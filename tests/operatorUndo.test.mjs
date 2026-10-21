import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { undoDatabase } from './fixtures/undoDatabase.mjs'
import { validHeader, validItems } from './fixtures/purchaseStatementDatabase.mjs'

test('operator undo database installs against the complete application schema', async () => {
  const { db, rpc } = await undoDatabase()
  try {
    assert.ok((await db.query('select count(*)::integer n from flexcon_undo_private.rpcs')).rows[0].n > 40)
    assert.equal((await db.query("select has_function_privilege('service_role','public.flexcon_attach_purchase_statement_image(text,uuid,text)','execute') allowed")).rows[0].allowed, true)
    assert.deepEqual(await rpc('tester', 'flexcon_get_undo_status', { p_worker_id: 'tester' }), { available: false, reason: '取り消せる操作はありません。' })
  } finally { await db.close() }
})

test('undo restores business operations exactly and protects operator boundaries', async t => {
  const { db, rpc } = await undoDatabase()
  try {
    const tables = (await db.query('select table_name from flexcon_undo_private.tables order by table_name')).rows.map(row => row.table_name)
    const snapshot = async () => {
      const result = {}
      for (const table of tables) result[table] = (await db.query(`select to_jsonb(t) row from public.${table} t order by to_jsonb(t)::text`)).rows.map(row => row.row)
      return result
    }
    const call = (actor, name, args = {}) => rpc(actor, name, { p_worker_id: actor, ...args })
    const status = actor => call(actor, 'flexcon_get_undo_status')
    const undo = async actor => {
      const target = await status(actor)
      assert.equal(target.available, true, JSON.stringify(target))
      return call(actor, 'flexcon_undo_last_operation', { p_operation_id: target.operationId })
    }
    const roundTrip = async (actor, name, args) => {
      const before = await snapshot()
      const result = await call(actor, name, args)
      await undo(actor)
      assert.deepEqual(await snapshot(), before, name)
      assert.equal((await status(actor)).available, false)
      return result
    }
    const authorization = number => ({ p_authorization_no: String(number), p_full_name: `Producer ${number}`, p_seed_purchase_slip: false, p_farming_plan: false, p_prefecture: '青森県', p_municipality: '青森市', p_address: 'Test', p_phone: '', p_crop_type: '', p_feed_rice_variety: '', p_notes: '' })
    const option = (type, name) => call('admin', 'flexcon_save_inspection_option', { p_option_id: null, p_option_type: type, p_name: name })
    const warehouseA = await option('warehouse', 'Undo Warehouse A')
    const warehouseB = await option('warehouse', 'Undo Warehouse B')
    await option('location', 'Undo Warehouse A')
    await option('brand_aomori', '青天のへきれき')
    const producer = await call('tester', 'flexcon_add_authorization', authorization(901))
    const group = { p_authorization_id: producer, p_fiscal_year: 8, p_purchase_date: '2026-10-16', p_inspection_date: '2026-10-16', p_inspection_location: 'Undo Warehouse A', p_brand: '青天のへきれき', p_flexcon_count: 2, p_paper_bag_count: 10, p_flexcon_quantity_kg: 1020, p_bulk_quantity_kg: 50, p_warehouse_id: warehouseA, p_settlement_no: 'UNDO' }

    await t.test('every frontend mutation is registered, including old clients', async () => {
      const registered = new Set((await db.query('select function_name from flexcon_undo_private.rpcs')).rows.map(row => row.function_name))
      const names = new Set()
      for (const file of fs.readdirSync('src/components')) if (file.endsWith('.tsx')) {
        for (const match of fs.readFileSync(`src/components/${file}`, 'utf8').matchAll(/['"](flexcon_(?:add|update|delete|set|save|register|import|append|split|mark|bulk|reorder|confirm|submit)_\w+)['"]/g)) names.add(match[1])
      }
      for (const name of names) assert.ok(registered.has(name), name)
    })
    await t.test('add, edit, delete and a batch of inspection details all round trip', async () => {
      await roundTrip('tester', 'flexcon_add_authorization', authorization(902))
      await roundTrip('tester', 'flexcon_add_inspection_group_with_warehouse', group)
      await call('tester', 'flexcon_add_inspection_group_with_warehouse', group)
      const registration = (await db.query('select id from flexcon_inspection_registrations where authorization_id=$1', [producer])).rows[0].id
      const details = (await db.query('select * from flexcon_inspection_flexcons where authorization_id=$1 order by flexcon_no', [producer])).rows
      await roundTrip('tester', 'flexcon_append_inspection_registration', { p_registration_id: registration, p_fiscal_year: 8, p_purchase_date: '2026-10-16', p_settlement_no: 'MORE', p_inspection_date: '2026-10-17', p_inspection_location: 'Undo Warehouse A', p_brand: '青天のへきれき', p_flexcon_count: 2, p_paper_bag_count: 5, p_bulk_quantity_kg: 0 })
      await roundTrip('tester', 'flexcon_set_inspection_registration_metadata_scope', { p_registration_id: registration, p_inspection_date: '2026-10-17', p_inspector_name: null, p_inspection_location: null, p_grade: '1等', p_target_kind: 'all', p_start_no: null, p_end_no: null, p_overwrite: true, p_target_inspection_date: '2026-10-16', p_only_undated: false })
      await roundTrip('tester', 'flexcon_mark_certificates_printed', { p_flexcon_ids: `{${details[0].id}}` })
      const paper = (await db.query('select id from flexcon_inspection_paper_bags where authorization_id=$1', [producer])).rows[0].id
      await roundTrip('tester', 'flexcon_split_inspection_paper_bags', { p_paper_bag_id: paper, p_first_bag_count: 4, p_second_bag_count: 6 })
      await roundTrip('tester', 'flexcon_delete_inspection_registration_date', { p_registration_id: registration, p_inspection_date: '2026-10-16', p_flexcon_ids: `{${details.map(row => row.id).join(',')}}`, p_paper_bag_ids: `{${paper}}` })
    })
    await t.test('inventory receipts, transfers and manual shipments restore stock exactly', async () => {
      const movement = { p_movement_date: '2026-10-16', p_producer_name: '', p_origin: '青森県', p_product_name: '青天のへきれき', p_grade: '1等', p_quantity: 10, p_unit: '本', p_from_warehouse_id: null, p_to_warehouse_id: warehouseA, p_crop_year: 2026, p_settlement_no: '', p_note: 'Undo test' }
      await roundTrip('tester', 'flexcon_add_inventory_movement', movement)
      await call('tester', 'flexcon_add_inventory_movement', movement)
      const stockBefore = (await db.query('select * from flexcon_inventory_balances_by_crop_year order by warehouse_id,product_name,grade,unit')).rows
      await roundTrip('tester', 'flexcon_add_inventory_movement', { ...movement, p_from_warehouse_id: warehouseA, p_to_warehouse_id: warehouseB, p_quantity: 3 })
      const destination = await call('admin', 'flexcon_add_destination', { p_name: 'Undo destination', p_address: '', p_contact_name: '' })
      await roundTrip('tester', 'flexcon_register_inventory_record', { p_destination_id: destination, p_transport_profile_id: null, p_shipped_at: '2026-10-16T09:00:00+09:00', p_driver_name: 'Driver', p_vehicle_no: 'Test', p_purchase_price_per_bale: null, p_from_warehouse_id: warehouseA, p_note: '', p_items: [{ crop_year: 2026, origin_prefecture: '青森県', product_name: '青天のへきれき', quantity_count: 2, grade: '1等', unit: '本' }] })
      assert.deepEqual((await db.query('select * from flexcon_inventory_balances_by_crop_year order by warehouse_id,product_name,grade,unit')).rows, stockBefore)
    })
    await t.test('statement reading, immutable image attachment, confirmation and deletion round trip', async () => {
      const draftId = crypto.randomUUID()
      const reading = { p_draft_id: draftId, p_source_type: 'camera', p_header: validHeader('UNDO-STATEMENT'), p_items: validItems(), p_warnings: ['確認してください'] }
      await roundTrip('tester', 'flexcon_submit_purchase_statement', reading)
      const before = await snapshot()
      await call('tester', 'flexcon_submit_purchase_statement', reading)
      const saved = await status('tester')
      const path = `${draftId}/${crypto.randomUUID()}.jpg`
      await call('tester', 'flexcon_attach_purchase_statement_image', { p_statement_id: draftId, p_image_path: path })
      assert.equal((await status('tester')).operationId, saved.operationId)
      await undo('tester')
      assert.deepEqual(await snapshot(), before)
      await call('tester', 'flexcon_submit_purchase_statement', reading)
      await call('tester', 'flexcon_attach_purchase_statement_image', { p_statement_id: draftId, p_image_path: path })
      const confirmation = { p_draft_id: draftId, p_header: validHeader('UNDO-STATEMENT'), p_items: validItems(), p_replace_statement_id: null }
      await roundTrip('other', 'flexcon_confirm_purchase_statement', confirmation)
      assert.equal((await status('tester')).available, false, 'another reviewer has used the pending record')
      const statementId = await call('other', 'flexcon_confirm_purchase_statement', confirmation)
      await roundTrip('admin', 'flexcon_delete_purchase_statement', { p_statement_id: statementId })
      await roundTrip('other', 'flexcon_save_purchase_statement', { p_statement_id: statementId, p_source_type: 'camera', p_header: validHeader('UNDO-EDITED'), p_items: validItems() })
      const oldImage = (await db.query('select image_path from flexcon_purchase_statements where id=$1', [statementId])).rows[0].image_path
      const original = await snapshot()
      await call('other', 'flexcon_save_purchase_statement', { p_statement_id: statementId, p_source_type: 'camera', p_header: validHeader('UNDO-IMAGE'), p_items: validItems() })
      await call('other', 'flexcon_attach_purchase_statement_image', { p_statement_id: statementId, p_image_path: `${statementId}/${crypto.randomUUID()}.jpg` })
      await undo('other')
      assert.deepEqual(await snapshot(), original)
      assert.equal((await db.query('select image_path from flexcon_purchase_statements where id=$1', [statementId])).rows[0].image_path, oldImage)
      await call('other', 'flexcon_add_memo_visible', { p_body: 'Intervening action', p_is_public: false })
      const beforeSeparateImage = await snapshot()
      await call('other', 'flexcon_attach_purchase_statement_image', { p_statement_id: statementId, p_image_path: `${statementId}/${crypto.randomUUID()}.jpg` })
      assert.equal((await status('other')).action, 'flexcon_attach_purchase_statement_image')
      await undo('other')
      assert.deepEqual(await snapshot(), beforeSeparateImage)
    })
    await t.test('QR shipments restore scan events, composite keys, lot status and print records', async () => {
      const destination = await call('admin', 'flexcon_add_destination', { p_name: 'QR Destination', p_address: '', p_contact_name: '' })
      const transport = await call('admin', 'flexcon_add_transport_profile', { p_company_name: 'QR Transport' })
      await db.exec("update flexcon_inspection_flexcons set grade='1等',moisture=13,moisture_values='{13}'")
      const lot = (await db.query("select lot_number from flexcon_inspection_flexcons where record_kind='standard' order by flexcon_no limit 1")).rows[0].lot_number
      const shipment = { p_destination_id: destination, p_transport_profile_id: transport, p_shipped_at: '2026-10-16T09:00:00+09:00', p_driver_name: 'Driver', p_vehicle_no: 'Test', p_lot_numbers: `{${lot}}`, p_purchase_price_per_bale: null, p_from_warehouse_id: warehouseA, p_note: 'QR undo' }
      await roundTrip('admin', 'flexcon_register_inventory_shipment', shipment)
      const shipmentId = await call('admin', 'flexcon_register_inventory_shipment', shipment)
      await roundTrip('admin', 'flexcon_delete_shipment', { p_shipment_id: shipmentId })
      assert.equal((await db.query('select count(*)::integer n from flexcon_scan_events where shipment_id=$1', [shipmentId])).rows[0].n, 1)
    })
    await t.test('master rows and their ordering are restored without disabling validation', async () => {
      await roundTrip('admin', 'flexcon_save_inspection_option', { p_option_id: warehouseB, p_option_type: 'warehouse', p_name: 'Renamed Warehouse' })
      await roundTrip('admin', 'flexcon_add_destination', { p_name: 'Undo Destination', p_address: '', p_contact_name: '' })
      await roundTrip('admin', 'flexcon_save_inspection_weights', { p_branded_rice_weight: 1030, p_feed_rice_weight: 1010 })
      await roundTrip('admin', 'flexcon_import_authorizations', { p_records: [{ authorization_no: '906', full_name: 'Imported A', address: 'A' }, { authorization_no: '907', full_name: 'Imported B', address: 'B' }] })
      const count = (await db.query("select count(*)::integer n from flexcon_undo_private.operations where worker_id='admin'")).rows[0].n
      assert.ok(count <= 1)
      const before = await snapshot()
      const definitions = (await db.query("select proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and prorettype='trigger'::regtype order by proname")).rows
      await db.exec(fs.readFileSync('supabase/migrations/202610160001_operator_undo.sql', 'utf8'))
      assert.deepEqual(await snapshot(), before)
      assert.deepEqual((await db.query("select proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and prorettype='trigger'::regtype order by proname")).rows, definitions)
    })
    await t.test('independent operators and no-op/read/failing calls do not consume the slot', async () => {
      await call('tester', 'flexcon_add_memo_visible', { p_body: 'A', p_is_public: false })
      const a = await status('tester')
      await call('tester', 'flexcon_update_memo_visible', { p_memo_no: (await db.query("select memo_no from flexcon_memos where body='A'")).rows[0].memo_no, p_body: 'A', p_is_public: false })
      await call('other', 'flexcon_add_memo_visible', { p_body: 'B', p_is_public: false })
      await call('tester', 'flexcon_list_memos')
      await assert.rejects(call('tester', 'flexcon_add_memo_visible', { p_body: '', p_is_public: false }))
      assert.equal((await status('tester')).operationId, a.operationId)
      await undo('tester')
      assert.equal((await db.query("select count(*)::integer n from flexcon_memos where body='B'")).rows[0].n, 1)
      assert.equal((await status('other')).available, true)
      await assert.rejects(call('tester', 'flexcon_undo_last_operation', { p_operation_id: a.operationId }))
      await undo('other')
    })
    await t.test('new operations replace the single slot and confirmation uses compare-and-swap', async () => {
      await call('tester', 'flexcon_add_memo_visible', { p_body: 'First', p_is_public: false })
      const first = await status('tester')
      await call('tester', 'flexcon_add_memo_visible', { p_body: 'Second', p_is_public: false })
      const before = await snapshot()
      await assert.rejects(call('tester', 'flexcon_undo_last_operation', { p_operation_id: first.operationId }), /直前/)
      assert.deepEqual(await snapshot(), before)
      await undo('tester')
      assert.equal((await status('tester')).available, false)
      assert.equal((await db.query("select count(*)::integer n from flexcon_memos where body='First'")).rows[0].n, 1)
    })
    await t.test('partial inverse failures roll back and normal foreign keys remain immediate', async () => {
      const id = await call('tester', 'flexcon_add_authorization', authorization(903))
      await call('tester', 'flexcon_delete_authorization', { p_authorization_id: id })
      await call('other', 'flexcon_add_authorization', { ...authorization(904), p_full_name: 'Producer 903' })
      const before = await snapshot()
      const target = await status('tester')
      assert.equal(target.available, true)
      await assert.rejects(call('tester', 'flexcon_undo_last_operation', { p_operation_id: target.operationId }), /住所|氏名/)
      assert.deepEqual(await snapshot(), before)
      assert.equal((await status('tester')).operationId, target.operationId)
      await assert.rejects(db.query("insert into flexcon_purchase_statement_items(statement_id,line_no,product_name) values(gen_random_uuid(),1,'Invalid')"), /foreign key/)
      assert.equal((await db.query("select count(*)::integer n from pg_trigger where tgrelid in (select table_name::regclass from flexcon_undo_private.tables) and tgenabled='D'")).rows[0].n, 0)
    })
    await t.test('same-row edits, newly dependent stock and revoked permissions block cancellation', async () => {
      const memo = await call('tester', 'flexcon_add_memo_visible', { p_body: 'Shared', p_is_public: true })
      await db.query("update flexcon_memos set body='Changed' where memo_no=$1", [memo])
      assert.equal((await status('tester')).available, false)
      await assert.rejects(call('tester', 'flexcon_undo_last_operation', { p_operation_id: (await status('tester')).operationId }))
      await call('tester', 'flexcon_add_inventory_movement', { p_movement_date: '2026-10-16', p_producer_name: '', p_origin: '青森県', p_product_name: '青天のへきれき', p_grade: '1等', p_quantity: 1, p_unit: '本', p_from_warehouse_id: null, p_to_warehouse_id: warehouseA, p_crop_year: 2026, p_settlement_no: '', p_note: '' })
      await call('other', 'flexcon_add_inventory_movement', { p_movement_date: '2026-10-16', p_producer_name: '', p_origin: '青森県', p_product_name: '青天のへきれき', p_grade: '1等', p_quantity: 1, p_unit: '本', p_from_warehouse_id: warehouseA, p_to_warehouse_id: null, p_crop_year: 2026, p_settlement_no: '', p_note: '' })
      assert.equal((await status('tester')).available, false)
      await call('tester', 'flexcon_add_memo_visible', { p_body: 'Permission', p_is_public: false })
      await db.exec("update business_private.permissions set role='viewer' where worker_id='tester' and app_id='rice_shipping'")
      await assert.rejects(status('tester'), /unauthorized/)
      await db.exec("update business_private.permissions set role='operator' where worker_id='tester' and app_id='rice_shipping'")
      await assert.rejects(rpc('other', 'flexcon_get_undo_status', { p_worker_id: 'tester' }), /ログイン/)
      const before = await snapshot()
      const implementation = (await db.query("select implementation_name from flexcon_undo_private.rpcs where function_name='flexcon_add_memo_visible'")).rows[0].implementation_name
      await db.exec('set role anon')
      await assert.rejects(db.query('select * from flexcon_undo_private.events'), /permission denied/)
      await assert.rejects(db.query("select flexcon_undo_private.prepare('tester','test','rice_shipping')"), /permission denied/)
      await assert.rejects(db.query(`select public.${implementation}('tester','Bypass',false)`), /permission denied/)
      await db.exec('reset role')
      assert.deepEqual(await snapshot(), before)
    })
  } finally { await db.close() }
})
