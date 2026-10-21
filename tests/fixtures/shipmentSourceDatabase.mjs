import { undoDatabase } from './undoDatabase.mjs'

export async function shipmentSourceDatabase() {
  const { db, rpc } = await undoDatabase()
  try {
    const call = (actor, name, args = {}) => rpc(actor, name, { p_worker_id: actor, ...args })
    const option = (type, name) => call('admin', 'flexcon_save_inspection_option', { p_option_id: null, p_option_type: type, p_name: name })
    const warehouseA = await option('warehouse', '倉庫A')
    const warehouseB = await option('warehouse', '倉庫B')
    const emptyWarehouse = await option('warehouse', '在庫なし倉庫')
    const olderYearWarehouse = await option('warehouse', '前年産のみ倉庫')
    await option('shipment_product', '米')
    const destination = await call('admin', 'flexcon_add_destination', { p_name: '納品先A', p_address: '', p_contact_name: '' })
    const transport = await call('admin', 'flexcon_add_transport_profile', { p_company_name: '運送会社A' })
    const receive = (warehouse, quantity, changes = {}) => call('tester', 'flexcon_add_inventory_movement', {
      p_movement_date: '2026-10-21', p_producer_name: '', p_origin: '青森県', p_product_name: '米',
      p_grade: '', p_quantity: quantity, p_unit: '本', p_from_warehouse_id: null,
      p_to_warehouse_id: warehouse, p_crop_year: 2026, p_settlement_no: '', p_note: '', ...changes,
    })
    await receive(warehouseA, 20)
    await receive(warehouseB, 4)
    await receive(olderYearWarehouse, 20, { p_crop_year: 2025 })
    const items = [{ crop_year: 2026, origin_prefecture: '青森県', product_name: '米', quantity_count: 5, grade: null, unit: '本' }]
    const common = { p_destination_id: destination, p_transport_profile_id: null, p_shipped_at: '2026-10-21T09:00:00+09:00', p_driver_name: null, p_vehicle_no: null, p_purchase_price_per_bale: 12000, p_note: 'Original' }
    const shipmentId = await call('tester', 'flexcon_register_inventory_record', { ...common, p_items: items, p_from_warehouse_id: warehouseA })
    const edit = { ...common, p_shipment_id: shipmentId, p_from_warehouse_id: warehouseA, p_items: items }
    const tables = (await db.query('select table_name from flexcon_undo_private.tables order by table_name')).rows.map(row => row.table_name)
    const snapshot = async () => {
      const result = {}
      for (const table of tables) result[table] = (await db.query(`select to_jsonb(t) row from public.${table} t order by to_jsonb(t)::text`)).rows.map(row => row.row)
      return result
    }
    const status = actor => call(actor, 'flexcon_get_undo_status')
    const undo = async actor => call(actor, 'flexcon_undo_last_operation', { p_operation_id: (await status(actor)).operationId })
    const balance = async (warehouse, year = 2026) => Number((await db.query("select coalesce(sum(quantity),0) quantity from flexcon_inventory_balances_by_crop_year where warehouse_id=$1 and crop_year is not distinct from $2 and product_name='米' and unit='本'", [warehouse, year])).rows[0].quantity)
    return { db, rpc, call, option, receive, snapshot, status, undo, balance, warehouseA, warehouseB, emptyWarehouse, olderYearWarehouse, destination, transport, shipmentId, items, edit, common }
  } catch (error) { await db.close(); throw error }
}
