import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { undoDatabase } from './fixtures/undoDatabase.mjs'
import { undoDeploymentSql } from './fixtures/undoDeployment.mjs'

test('shipment destinations are required without altering legacy rows or breaking operator Undo', async t => {
  const { db, rpc } = await undoDatabase()
  try {
    const call = (actor, name, args = {}) => rpc(actor, name, { p_worker_id: actor, ...args })
    const option = (type, name) => call('admin', 'flexcon_save_inspection_option', { p_option_id: null, p_option_type: type, p_name: name })
    const warehouse = await option('warehouse', 'Required destination warehouse')
    await option('shipment_product', '米')
    const destination = await call('admin', 'flexcon_add_destination', { p_name: 'Required destination', p_address: '', p_contact_name: '' })
    await call('tester', 'flexcon_add_inventory_movement', { p_movement_date: '2026-10-21', p_producer_name: '', p_origin: '青森県', p_product_name: '米', p_grade: '', p_quantity: 20, p_unit: '本', p_from_warehouse_id: null, p_to_warehouse_id: warehouse, p_crop_year: 2026, p_settlement_no: '', p_note: '' })
    const args = { p_destination_id: destination, p_transport_profile_id: null, p_shipped_at: '2026-10-21T09:00:00+09:00', p_driver_name: null, p_vehicle_no: null, p_purchase_price_per_bale: null, p_from_warehouse_id: warehouse, p_note: null, p_items: [{ crop_year: 2026, origin_prefecture: '青森県', product_name: '米', quantity_count: 1, grade: null, unit: '本' }] }
    const details = async id => (await db.query('select to_jsonb(s) row from flexcon_shipments s where id=$1', [id])).rows[0]?.row
    const stock = async () => (await db.query('select to_jsonb(s) row from flexcon_inventory_balances_by_crop_year s order by to_jsonb(s)::text')).rows
    const status = actor => call(actor, 'flexcon_get_undo_status')
    const undo = async actor => call(actor, 'flexcon_undo_last_operation', { p_operation_id: (await status(actor)).operationId })
    const editArgs = id => {
      const { p_from_warehouse_id: _warehouse, ...values } = args
      return { ...values, p_shipment_id: id, p_note: 'Edited' }
    }
    await t.test('new registrations reject missing destination atomically and keep transport optional', async () => {
      const beforeStock = await stock(), beforeUndo = await status('tester')
      await assert.rejects(call('tester', 'flexcon_register_inventory_record', { ...args, p_destination_id: null }), /納品先を選択/)
      assert.deepEqual(await stock(), beforeStock)
      assert.deepEqual(await status('tester'), beforeUndo)
      const id = await call('tester', 'flexcon_register_inventory_record', args)
      const row = await details(id)
      assert.equal(row.destination_id, destination)
      for (const key of ['transport_profile_id', 'driver_name', 'vehicle_no']) assert.equal(row[key], null)
      await undo('tester')
      assert.equal(await details(id), undefined)
      assert.deepEqual(await stock(), beforeStock)
    })
    await t.test('edits cannot clear destinations and valid edits remain one-step undoable', async () => {
      const id = await call('tester', 'flexcon_register_inventory_record', args)
      const before = await details(id), beforeStock = await stock(), beforeUndo = await status('tester')
      await assert.rejects(call('tester', 'flexcon_update_inventory_record', { ...editArgs(id), p_destination_id: null }), /納品先を選択/)
      assert.deepEqual(await details(id), before)
      assert.deepEqual(await stock(), beforeStock)
      assert.deepEqual(await status('tester'), beforeUndo)
      await call('tester', 'flexcon_update_inventory_record', editArgs(id))
      await undo('tester')
      assert.deepEqual(await details(id), before)
      await assert.rejects(call('viewer', 'flexcon_register_inventory_record', args), /unauthorized/)
    })
    await t.test('legacy unset destinations survive installation and can be corrected, deleted and restored', async () => {
      // Model a row created before the new rule, only in this disposable database.
      await db.exec('drop trigger flexcon_shipment_destination_required on flexcon_shipments')
      const legacy = await call('tester', 'flexcon_register_inventory_record', { ...args, p_destination_id: null })
      const original = await details(legacy), originalStock = await stock()
      const wrapper = (await db.query("select pg_get_functiondef('flexcon_update_inventory_record(text,uuid,uuid,uuid,timestamptz,text,text,jsonb,numeric,text)'::regprocedure) definition")).rows[0].definition
      const migration = fs.readFileSync('supabase/migrations/202610210001_required_shipment_destination.sql', 'utf8')
      await db.exec(undoDeploymentSql(migration))
      assert.deepEqual(await details(legacy), original)
      assert.equal((await db.query("select pg_get_functiondef('flexcon_update_inventory_record(text,uuid,uuid,uuid,timestamptz,text,text,jsonb,numeric,text)'::regprocedure) definition")).rows[0].definition, wrapper)
      await assert.rejects(call('tester', 'flexcon_update_inventory_record', { ...editArgs(legacy), p_destination_id: null }), /納品先を選択/)
      await call('tester', 'flexcon_update_inventory_record', editArgs(legacy))
      assert.equal((await details(legacy)).destination_id, destination)
      await undo('tester')
      assert.deepEqual(await details(legacy), original, 'Undo restores the original unset destination')
      await call('admin', 'flexcon_delete_shipment', { p_shipment_id: legacy })
      await undo('admin')
      assert.deepEqual(await details(legacy), original, 'Undo can reinsert a deleted legacy row')
      assert.deepEqual(await stock(), originalStock)
      await db.exec(undoDeploymentSql(migration))
      await assert.rejects(call('tester', 'flexcon_register_inventory_record', { ...args, p_destination_id: null }), /納品先を選択/)
      assert.equal((await db.query("select has_function_privilege('anon','flexcon_require_shipment_destination()','execute') allowed")).rows[0].allowed, false)
      assert.equal((await db.query("select tgenabled from pg_trigger where tgname='flexcon_shipment_destination_required'")).rows[0].tgenabled, 'O')
    })
  } finally { await db.close() }
})
