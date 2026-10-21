import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { shipmentSourceDatabase } from './fixtures/shipmentSourceDatabase.mjs'
import { undoDeploymentSql } from './fixtures/undoDeployment.mjs'

test('shipment source and detail edits are atomic, stock checked and one-step undoable', async t => {
  const f = await shipmentSourceDatabase()
  const { db, call, option, receive, snapshot, status, undo, balance, warehouseA, warehouseB, emptyWarehouse, olderYearWarehouse, transport, shipmentId, items, edit, common } = f
  const save = (args = {}, actor = 'tester') => call(actor, 'flexcon_update_shipment_with_source', { ...edit, ...args })
  try {
    await t.test('operators can change source and quantity together without a transient stock failure', async () => {
      const before = await snapshot()
      await save({ p_from_warehouse_id: warehouseB, p_items: [{ ...items[0], quantity_count: 3 }], p_driver_name: 'Edited', p_note: 'Changed together' })
      assert.equal(await balance(warehouseA), 20)
      assert.equal(await balance(warehouseB), 1)
      assert.equal((await db.query('select inventory_from_warehouse_id from flexcon_shipments where id=$1', [shipmentId])).rows[0].inventory_from_warehouse_id, warehouseB)
      assert.equal((await status('tester')).action, 'flexcon_update_shipment_with_source')
      await undo('tester')
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('insufficient stock, wrong crop year, invalid masters, roles and details roll back everything', async () => {
      const invalidWarehouse = await option('location', 'Not a warehouse')
      const before = await snapshot(), undoBefore = await status('tester')
      for (const args of [
        { p_from_warehouse_id: warehouseB }, { p_from_warehouse_id: emptyWarehouse },
        { p_from_warehouse_id: olderYearWarehouse }, { p_from_warehouse_id: invalidWarehouse },
        { p_from_warehouse_id: null }, { p_from_warehouse_id: warehouseB, p_items: [] },
        { p_from_warehouse_id: warehouseB, p_destination_id: null },
      ]) {
        await assert.rejects(save(args))
        assert.deepEqual(await snapshot(), before)
        assert.deepEqual(await status('tester'), undoBefore)
      }
      await assert.rejects(save({}, 'viewer'), /unauthorized/)
      await assert.rejects(save({ p_worker_id: 'admin' }), /unauthorized/)
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('existing inactive sources can be retained, but cannot be newly selected', async () => {
      await db.query('update flexcon_inspection_options set active=false where id=any($1::uuid[])', [[warehouseA, warehouseB]])
      const before = await snapshot()
      await save({ p_note: 'Keep inactive source' })
      await undo('tester')
      assert.deepEqual(await snapshot(), before)
      await assert.rejects(save({ p_from_warehouse_id: warehouseB, p_items: [{ ...items[0], quantity_count: 1 }] }), /出荷元/)
      await db.query('update flexcon_inspection_options set active=true where id=any($1::uuid[])', [[warehouseA, warehouseB]])
    })
    await t.test('legacy unset sources stay editable and Undo can restore an unset source', async () => {
      await db.query('update flexcon_shipments set inventory_from_warehouse_id=null where id=$1', [shipmentId])
      const before = await snapshot()
      await save({ p_from_warehouse_id: null, p_note: 'Legacy edit' })
      await undo('tester')
      assert.deepEqual(await snapshot(), before)
      await save()
      await undo('tester')
      assert.deepEqual(await snapshot(), before)
      await db.query('update flexcon_shipments set inventory_from_warehouse_id=$2 where id=$1', [shipmentId, warehouseA])
    })
    await t.test('paper bags and other rice also change source and restore every field with Undo', async () => {
      await option('brand_aomori', '青天のへきれき')
      for (const kind of ['paper_bag', 'other_rice']) {
        const paper = kind === 'paper_bag'
        const product = paper ? '青天のへきれき' : '米'
        const grade = paper ? '1等' : ''
        for (const warehouse of [warehouseA, warehouseB]) await receive(warehouse, 10, { p_crop_year: null, p_product_name: product, p_grade: grade, p_unit: paper ? '袋' : '本' })
        const details = [{ origin_prefecture: '青森県', product_name: product, quantity_count: 2, grade: paper ? '1等' : null, moisture: paper ? 13 : null, reason: null }]
        const values = { ...common, p_transport_profile_id: transport, p_driver_name: 'Driver', p_vehicle_no: 'Test', p_items: details }
        const id = await call('tester', 'flexcon_register_inventory_manual_shipment', { ...values, p_shipment_kind: kind, p_from_warehouse_id: warehouseA })
        const before = await snapshot()
        await save({ ...values, p_shipment_id: id, p_from_warehouse_id: warehouseB })
        assert.equal((await db.query('select inventory_from_warehouse_id from flexcon_shipments where id=$1', [id])).rows[0].inventory_from_warehouse_id, warehouseB)
        await undo('tester')
        assert.deepEqual(await snapshot(), before)
      }
    })
    await t.test('QR edits retain lot relationships and scan data and remain one-step undoable', async () => {
      await option('location', '倉庫A')
      const producer = await call('tester', 'flexcon_add_authorization', { p_authorization_no: '903', p_full_name: 'Source Test', p_seed_purchase_slip: false, p_farming_plan: false, p_prefecture: '青森県', p_address: 'Test' })
      await call('tester', 'flexcon_add_inspection_group_with_warehouse', { p_authorization_id: producer, p_fiscal_year: 8, p_purchase_date: '2026-10-21', p_inspection_date: '2026-10-21', p_inspection_location: '倉庫A', p_brand: '青天のへきれき', p_flexcon_count: 1, p_paper_bag_count: 0, p_flexcon_quantity_kg: 1020, p_bulk_quantity_kg: 0, p_warehouse_id: warehouseA, p_settlement_no: 'SOURCE' })
      await db.exec("update flexcon_inspection_flexcons set grade='1等',moisture=13,moisture_values='{13}'")
      await receive(warehouseB, 1, { p_product_name: '青天のへきれき', p_grade: '1等' })
      const lot = (await db.query('select lot_number from flexcon_inspection_flexcons where authorization_id=$1', [producer])).rows[0].lot_number
      const values = { ...common, p_transport_profile_id: transport, p_driver_name: 'Driver', p_vehicle_no: 'Test' }
      const id = await call('admin', 'flexcon_register_inventory_shipment', { ...values, p_from_warehouse_id: warehouseA, p_lot_numbers: `{${lot}}` })
      const before = await snapshot()
      await save({ ...values, p_shipment_id: id, p_from_warehouse_id: warehouseB, p_items: null })
      assert.equal((await db.query('select inventory_from_warehouse_id from flexcon_shipments where id=$1', [id])).rows[0].inventory_from_warehouse_id, warehouseB)
      await undo('tester')
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('repeated installation does not alter business data or existing Undo wrappers', async () => {
      const before = await snapshot()
      const definitions = async () => (await db.query("select p.proname, pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('flexcon_update_inventory_record','flexcon_update_shipment','flexcon_update_manual_shipment') order by p.oid")).rows
      const beforeFunctions = await definitions()
      await db.exec(undoDeploymentSql(fs.readFileSync('supabase/migrations/202610210002_edit_shipment_source.sql', 'utf8')))
      assert.deepEqual(await snapshot(), before)
      assert.deepEqual(await definitions(), beforeFunctions)
      assert.equal((await db.query("select has_function_privilege('anon','public._flexcon_undo_impl_update_shipment_source(text,uuid,uuid,uuid,uuid,timestamptz,text,text,jsonb,numeric,text)','execute') allowed")).rows[0].allowed, false)
    })
  } finally { await db.close() }
})
