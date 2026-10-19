import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { undoDatabase } from './fixtures/undoDatabase.mjs'
import { undoDeploymentSql } from './fixtures/undoDeployment.mjs'

test('summary deletion isolates brand, kind, date and producer and remains one-step undoable', async t => {
  const { db, rpc } = await undoDatabase()
  try {
    const call = (name, args, actor = 'tester') => rpc(actor, name, { p_worker_id: actor, ...args })
    const option = (type, name) => call('flexcon_save_inspection_option', { p_option_id: null, p_option_type: type, p_name: name }, 'admin')
    const warehouse = await option('warehouse', 'Group Place')
    await option('location', 'Group Place')
    await option('brand_aomori', 'Rice A')
    await option('brand_aomori', 'Rice B')
    const producer = async no => call('flexcon_add_authorization', { p_authorization_no: no, p_full_name: 'Namesake', p_seed_purchase_slip: false, p_farming_plan: false, p_prefecture: '青森県', p_municipality: 'Test', p_address: no, p_phone: '', p_crop_type: '', p_feed_rice_variety: '', p_notes: '' })
    const first = await producer('901')
    const second = await producer('902')
    const add = (authorization, brand, date, counts = {}) => call('flexcon_add_inspection_group_with_warehouse', {
      p_authorization_id: authorization, p_fiscal_year: 8, p_purchase_date: '2026-10-04', p_inspection_date: date,
      p_inspection_location: 'Group Place', p_brand: brand, p_flexcon_count: 2, p_paper_bag_count: 5,
      p_flexcon_quantity_kg: 1020, p_bulk_quantity_kg: 50, p_warehouse_id: warehouse, p_settlement_no: 'GROUP', ...counts,
    })
    await add(first, 'Rice A', '2026-10-04')
    await add(first, 'Rice B', '2026-10-04')
    await add(first, 'Rice A', '2026-10-06', { p_paper_bag_count: 0, p_bulk_quantity_kg: 0 })
    await add(second, 'Rice A', '2026-10-04', { p_flexcon_count: 0, p_bulk_quantity_kg: 0 })
    const registration = (await db.query('select id from flexcon_inspection_registrations where authorization_id=$1', [first])).rows[0].id
    const tables = (await db.query('select table_name from flexcon_undo_private.tables order by table_name')).rows.map(row => row.table_name)
    const snapshot = async () => {
      const result = {}
      for (const table of tables) result[table] = (await db.query(`select to_jsonb(t) row from public.${table} t order by to_jsonb(t)::text`)).rows.map(row => row.row)
      result.ledger = (await db.query('select to_jsonb(t) row from flexcon_inventory_ledger t order by to_jsonb(t)::text')).rows.map(row => row.row)
      return result
    }
    const argsFor = async (brand, kind, date = '2026-10-04', registrationId = registration) => {
      const flexcons = kind === 'paper' ? [] : (await db.query("select id from flexcon_inspection_flexcons where registration_id=$1 and inspection_date is not distinct from $2::date and btrim(coalesce(brand,''))=$3 and record_kind=$4 order by id", [registrationId, date, brand, kind])).rows.map(row => row.id)
      const paper = kind !== 'paper' ? [] : (await db.query("select id from flexcon_inspection_paper_bags where registration_id=$1 and inspection_date is not distinct from $2::date and btrim(coalesce(brand,''))=$3 order by id", [registrationId, date, brand])).rows.map(row => row.id)
      return { p_registration_id: registrationId, p_inspection_date: date, p_brand: brand, p_record_kind: kind, p_flexcon_ids: `{${flexcons.join(',')}}`, p_paper_bag_ids: `{${paper.join(',')}}` }
    }
    const undo = async () => {
      const status = await call('flexcon_get_undo_status', {})
      assert.equal(status.available, true)
      assert.equal(status.action, 'flexcon_delete_inspection_summary_group')
      await call('flexcon_undo_last_operation', { p_operation_id: status.operationId })
      assert.equal((await call('flexcon_get_undo_status', {})).available, false)
    }
    await t.test('every brand and packaging group deletes only its own IDs and restores all stock', async () => {
      for (const brand of ['Rice A', 'Rice B']) for (const kind of ['standard', 'bulk', 'paper']) {
        const before = await snapshot()
        const args = await argsFor(brand, kind)
        await call('flexcon_delete_inspection_summary_group', args)
        const after = await snapshot()
        const table = kind === 'paper' ? 'flexcon_inspection_paper_bags' : 'flexcon_inspection_flexcons'
        const removed = new Set((kind === 'paper' ? args.p_paper_bag_ids : args.p_flexcon_ids).slice(1, -1).split(','))
        assert.deepEqual(after[table], before[table].filter(row => !removed.has(row.id)))
        assert.equal(after.flexcon_inspection_registrations.length, before.flexcon_inspection_registrations.length)
        const archive = (await db.query('select snapshot from flexcon_inspection_deletion_archives order by deleted_at desc limit 1')).rows[0].snapshot
        assert.equal(archive.brand, brand)
        assert.equal(archive.record_kind, kind)
        assert.equal(archive.flexcons.length + archive.paper_bags.length, removed.size)
        await undo()
        assert.deepEqual(await snapshot(), before)
      }
    })
    await t.test('empty dates and deleting the final group restore the original parent', async () => {
      const otherRegistration = (await db.query('select id from flexcon_inspection_registrations where authorization_id=$1', [second])).rows[0].id
      await db.query('update flexcon_inspection_paper_bags set inspection_date=null where authorization_id=$1', [second])
      const before = await snapshot()
      await call('flexcon_delete_inspection_summary_group', await argsFor('Rice A', 'paper', null, otherRegistration))
      assert.equal((await db.query('select count(*)::int n from flexcon_inspection_registrations where id=$1', [otherRegistration])).rows[0].n, 0)
      await undo()
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('stale, cross-group, duplicate, spoofed and unauthorized requests cannot delete anything', async () => {
      const args = await argsFor('Rice A', 'standard')
      const before = await snapshot()
      const invalid = [
        { p_brand: 'Rice B' }, { p_record_kind: 'bulk' }, { p_inspection_date: '2026-10-06' },
        { p_flexcon_ids: '{}' }, { p_flexcon_ids: null }, { p_paper_bag_ids: null },
        { p_flexcon_ids: `{${args.p_flexcon_ids.slice(1, -1)},${args.p_flexcon_ids.slice(1, -1).split(',')[0]}}` },
        { p_record_kind: 'invalid' }, { p_brand: null },
      ]
      for (const changes of invalid) await assert.rejects(call('flexcon_delete_inspection_summary_group', { ...args, ...changes }))
      await assert.rejects(call('flexcon_delete_inspection_summary_group', args, 'viewer'))
      await assert.rejects(rpc('other', 'flexcon_delete_inspection_summary_group', { ...args, p_worker_id: 'tester' }))
      assert.equal((await db.query("select has_function_privilege('anon','public._flexcon_undo_impl_delete_summary_group(text,uuid,date,text,text,uuid[],uuid[])','execute') allowed")).rows[0].allowed, false)
      assert.deepEqual(await snapshot(), before)
      await add(first, 'Rice A', '2026-10-04', { p_flexcon_count: 1, p_paper_bag_count: 0, p_bulk_quantity_kg: 0 })
      const changed = await snapshot()
      const head = await call('flexcon_get_undo_status', {})
      await assert.rejects(call('flexcon_delete_inspection_summary_group', args), /変更されています/)
      assert.deepEqual(await snapshot(), changed)
      assert.equal((await call('flexcon_get_undo_status', {})).operationId, head.operationId)
    })
    await t.test('shipped sibling groups do not block deletion of a different group', async () => {
      const destination = await call('flexcon_add_destination', { p_name: 'Group Destination', p_address: '', p_contact_name: '' }, 'admin')
      const transport = await call('flexcon_add_transport_profile', { p_company_name: 'Group Transport' }, 'admin')
      await db.exec("update flexcon_inspection_flexcons set grade='1等',moisture=13,moisture_values='{13}',inspector_name='Tester'")
      const lot = (await db.query("select lot_number from flexcon_inspection_flexcons where brand='Rice B' and record_kind='standard' order by flexcon_no limit 1")).rows[0].lot_number
      await call('flexcon_register_inventory_shipment', { p_destination_id: destination, p_transport_profile_id: transport, p_shipped_at: '2026-10-19T09:00:00+09:00', p_driver_name: 'Driver', p_vehicle_no: 'Test', p_lot_numbers: `{${lot}}`, p_purchase_price_per_bale: null, p_from_warehouse_id: warehouse, p_note: '' }, 'admin')
      const before = await snapshot()
      await call('flexcon_delete_inspection_summary_group', await argsFor('Rice A', 'standard'))
      await assert.rejects(call('flexcon_delete_inspection_summary_group', await argsFor('Rice B', 'standard')), /出荷履歴/)
      await undo()
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('repeated installation preserves business records and the Undo wrapper', async () => {
      const before = await snapshot()
      await db.exec(undoDeploymentSql(fs.readFileSync('supabase/migrations/202610190001_inspection_summary_groups.sql', 'utf8')))
      assert.deepEqual(await snapshot(), before)
      await call('flexcon_delete_inspection_summary_group', await argsFor('Rice A', 'paper'))
      await undo()
      assert.deepEqual(await snapshot(), before)
    })
  } finally { await db.close() }
})
