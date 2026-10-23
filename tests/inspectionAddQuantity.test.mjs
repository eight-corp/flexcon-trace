import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { undoDatabase } from './fixtures/undoDatabase.mjs'
import { undoDeploymentSql } from './fixtures/undoDeployment.mjs'

test('inspection additions preserve explicit per-flexcon quantities and Undo', async t => {
  const { db, rpc } = await undoDatabase()
  try {
    const call = (name, args = {}, actor = 'tester') => rpc(actor, name, { p_worker_id: actor, ...args })
    const option = (type, name) => call('flexcon_save_inspection_option', { p_option_id: null, p_option_type: type, p_name: name }, 'admin')
    const warehouse = await option('warehouse', 'Quantity test')
    await option('location', 'Quantity test')
    await call('flexcon_save_inspection_weights', { p_branded_rice_weight: 1040, p_feed_rice_weight: 1005 }, 'admin')
    const producer = await call('flexcon_add_authorization', { p_authorization_no: '900', p_full_name: 'Quantity Producer', p_seed_purchase_slip: false, p_farming_plan: false, p_prefecture: '青森県', p_municipality: '青森市', p_address: 'Test', p_phone: '', p_crop_type: '', p_feed_rice_variety: '', p_notes: '' })
    const group = { p_authorization_id: producer, p_fiscal_year: 8, p_purchase_date: '2026-10-23', p_inspection_date: '2026-10-23', p_inspection_location: 'Quantity test', p_brand: 'まっしぐら', p_flexcon_count: 2, p_paper_bag_count: 5, p_flexcon_quantity_kg: 1080, p_bulk_quantity_kg: 70, p_warehouse_id: warehouse, p_settlement_no: 'FIRST' }
    const tables = (await db.query('select table_name from flexcon_undo_private.tables order by table_name')).rows.map(row => row.table_name)
    const snapshot = async () => {
      const result = {}
      for (const table of tables) result[table] = (await db.query(`select to_jsonb(t) row from public.${table} t order by to_jsonb(t)::text`)).rows.map(row => row.row)
      return result
    }
    const undo = async () => {
      const status = await call('flexcon_get_undo_status')
      assert.equal(status.available, true)
      await call('flexcon_undo_last_operation', { p_operation_id: status.operationId })
    }
    await t.test('invalid quantities roll back all registration changes', async () => {
      const before = await snapshot()
      for (const quantity of [0, -1, 1.5]) await assert.rejects(call('flexcon_add_inspection_group_with_warehouse', { ...group, p_flexcon_quantity_kg: quantity }))
      assert.deepEqual(await snapshot(), before)
    })
    let registration
    await t.test('summary additions honor quantity without changing paper bags or bulk', async () => {
      const before = await snapshot()
      registration = (await call('flexcon_add_inspection_group_with_warehouse', group)).registration_id
      assert.deepEqual((await db.query('select flexcon_no,record_kind,quantity_kg from flexcon_inspection_flexcons order by flexcon_no')).rows, [
        { flexcon_no: 1, record_kind: 'standard', quantity_kg: 1080 },
        { flexcon_no: 2, record_kind: 'standard', quantity_kg: 1080 },
        { flexcon_no: 3, record_kind: 'bulk', quantity_kg: 70 },
      ])
      assert.equal((await db.query('select bag_count from flexcon_inspection_paper_bags')).rows[0].bag_count, 5)
      await undo()
      assert.deepEqual(await snapshot(), before)
      registration = (await call('flexcon_add_inspection_group_with_warehouse', group)).registration_id
    })
    const append = () => ({ p_registration_id: registration, p_fiscal_year: 8, p_purchase_date: '2026-10-23', p_inspection_date: '2026-10-24', p_inspection_location: 'Quantity test', p_brand: '飼料用玄米', p_flexcon_count: 2, p_paper_bag_count: 0, p_bulk_quantity_kg: 90, p_settlement_no: 'APPEND' })
    await t.test('detail additions retain shared numbering, existing rows and one-step Undo', async () => {
      const before = await snapshot()
      await call('flexcon_append_inspection_registration', { ...append(), p_flexcon_quantity_kg: 1030 })
      assert.deepEqual((await db.query('select flexcon_no,quantity_kg from flexcon_inspection_flexcons order by flexcon_no')).rows, [
        { flexcon_no: 1, quantity_kg: 1080 }, { flexcon_no: 2, quantity_kg: 1080 }, { flexcon_no: 3, quantity_kg: 70 },
        { flexcon_no: 4, quantity_kg: 1030 }, { flexcon_no: 5, quantity_kg: 1030 }, { flexcon_no: 6, quantity_kg: 90 },
      ])
      await undo()
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('null quantities use the current master for both kinds of rice', async () => {
      for (const [brand, weight] of [['まっしぐら', 1040], ['飼料用玄米', 1005]]) {
        await call('flexcon_append_inspection_registration', { ...append(), p_brand: brand, p_flexcon_quantity_kg: null })
        assert.deepEqual((await db.query("select quantity_kg from flexcon_inspection_flexcons where settlement_no='APPEND' and record_kind='standard'")).rows.map(row => row.quantity_kg), [weight, weight])
        await undo()
      }
    })
    await t.test('old clients still derive master quantities', async () => {
      await call('flexcon_append_inspection_registration', append())
      assert.deepEqual((await db.query("select quantity_kg from flexcon_inspection_flexcons where settlement_no='APPEND' and record_kind='standard'")).rows.map(row => row.quantity_kg), [1005, 1005])
      await undo()
    })
    await t.test('no flexcons means quantity is optional, with access checks preserved', async () => {
      const before = await snapshot()
      await call('flexcon_append_inspection_registration', { ...append(), p_flexcon_count: 0, p_flexcon_quantity_kg: null })
      await undo()
      assert.deepEqual(await snapshot(), before)
      for (const actor of ['viewer', 'missing']) await assert.rejects(call('flexcon_append_inspection_registration', { ...append(), p_flexcon_quantity_kg: 1030 }, actor))
      assert.deepEqual(await snapshot(), before)
      for (const impl of ['_flexcon_undo_impl_append_inspection_quantity', '_flexcon_undo_impl_add_inspection_quantity']) {
        const roles = (await db.query("select bool_or(has_function_privilege('anon',p.oid,'execute')) allowed from pg_proc p where proname=$1", [impl])).rows[0]
        assert.equal(roles.allowed, false)
      }
    })
    await t.test('repeated migration changes no business data and retains Undo wrappers', async () => {
      const before = await snapshot()
      await db.exec(undoDeploymentSql(fs.readFileSync('supabase/migrations/202610230001_inspection_add_quantity.sql', 'utf8')))
      assert.deepEqual(await snapshot(), before)
      await call('flexcon_append_inspection_registration', { ...append(), p_flexcon_quantity_kg: 1070 })
      await undo()
      assert.deepEqual(await snapshot(), before)
    })
  } finally { await db.close() }
})
