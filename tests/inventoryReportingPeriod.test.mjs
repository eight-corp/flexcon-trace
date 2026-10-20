import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { inventoryReportingDates, inventoryReportingSnapshot } from '../src/lib/inventoryReportingPeriod.ts'

test('ledger timestamp sources use the same local date as shipment and purchase forms', () => {
  const atMidnight = new Date(2026, 8, 1, 0, 0).toISOString()
  const ledger = ['shipment_flexcon', 'shipment_manual', 'shipment_record', 'settlement', 'manual'].map((source, index) => ({ source_type: source, id: index === 0 ? 'shipment-flexcon:shipment:detail' : index < 3 ? `${source}:item` : 'purchase', movement_date: '2026-08-31' }))
  const corrected = inventoryReportingDates(ledger, [{ id: 'shipment', shipped_at: atMidnight, flexcon_manual_shipment_items: [{ id: 'item' }] }], [{ id: 'purchase', purchased_at: atMidnight }])
  assert.deepEqual(corrected.map(row => row.movement_date), ['2026-09-01', '2026-09-01', '2026-09-01', '2026-09-01', '2026-08-31'])
  assert.ok(ledger.every(row => row.movement_date === '2026-08-31'), 'Loaded ledger rows remain immutable')
  assert.deepEqual(inventoryReportingDates(ledger, [], []), ledger)
})

test('period inventory matches the production SQL views, with carryover or net movement and period shipments', async () => {
  const db = new PGlite()
  const uuid = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
  const warehouses = [1, 2, 3].map(id => ({ id: uuid(id), name: id === 1 ? '倉庫未設定' : `W${id}`, created_at: '2026-01-01' }))
  const flexcons = [{ id: uuid(4), fiscal_year: 8 }]
  const paper = [{ id: uuid(5), fiscal_year: 7 }]
  const ledger = []
  const add = (source, date, from, to, quantity, extra = {}) => ledger.push({ id: `${source}:${uuid(100 + ledger.length)}`, source_type: source, movement_date: date, from_warehouse_id: from ? uuid(from) : null, to_warehouse_id: to ? uuid(to) : null, quantity, crop_year: 2026, origin: '青森県', product_name: 'Rice', grade: '1等', unit: '本', ...extra })
  add('settlement', '2026-08-31', null, 2, 10)
  add('manual', '2026-09-01', null, 2, 5)
  add('shipment_record', '2026-09-01', 2, null, 3)
  add('manual', '2026-10-01', 2, 3, 2)
  add('shipment_record', '2027-08-31', 2, null, 1)
  add('shipment_record', '2027-09-01', 2, null, 4)
  add('inspection_flexcon', '2026-10-01', null, 2, 1, { id: `inspection-flexcon:${uuid(4)}`, crop_year: null, grade: '' })
  add('shipment_flexcon', '2026-10-01', 2, null, 1, { id: `shipment-flexcon:${uuid(50)}:${uuid(4)}`, crop_year: null, grade: '' })
  add('inspection_paper_bag', '2026-10-02', null, 1, 12, { id: `inspection-paper:${uuid(5)}`, crop_year: null, unit: '袋' })
  add('settlement', '2026-10-01', null, null, 3, { grade: '', unit: 'kg', crop_year: null })
  add('shipment_manual', '2026-10-01', 1, null, 1, { unit: 'kg', crop_year: null })
  add('manual', '2026-10-01', null, 2, 0.1, { unit: 'kg', product_name: 'Decimal' })
  add('manual', '2026-10-01', null, 2, 0.2, { unit: 'kg', product_name: 'Decimal' })
  add('manual', '2026-10-01', 2, null, 0.3, { unit: 'kg', product_name: 'Decimal' })
  try {
    await db.exec(`create role anon; create role authenticated;
      create table flexcon_inspection_options(id uuid, name text, option_type text, created_at timestamptz);
      create table flexcon_inspection_flexcons(id uuid, fiscal_year integer);
      create table flexcon_inspection_paper_bags(id uuid, fiscal_year integer);
      create table ledger_rows(id text, source_type text, movement_date text, from_warehouse_id uuid, to_warehouse_id uuid, quantity numeric, crop_year integer, origin text, product_name text, grade text, unit text);
      create view flexcon_inventory_ledger as select * from ledger_rows where
        (coalesce(current_setting('test.start',true),'')='' or movement_date>=current_setting('test.start',true)) and
        (coalesce(current_setting('test.end',true),'')='' or movement_date<=current_setting('test.end',true));`)
    for (const row of warehouses) await db.query("insert into flexcon_inspection_options values ($1,$2,'warehouse',$3)", [row.id, row.name, row.created_at])
    for (const row of flexcons) await db.query('insert into flexcon_inspection_flexcons values ($1,$2)', [row.id, row.fiscal_year])
    for (const row of paper) await db.query('insert into flexcon_inspection_paper_bags values ($1,$2)', [row.id, row.fiscal_year])
    for (const row of ledger) await db.query('insert into ledger_rows values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [row.id, row.source_type, row.movement_date, row.from_warehouse_id, row.to_warehouse_id, row.quantity, row.crop_year, row.origin, row.product_name, row.grade, row.unit])
    await db.exec(readFileSync('supabase/migrations/202609240007_inventory_balances_by_crop_year.sql', 'utf8'))
    await db.exec(readFileSync('supabase/migrations/202609300004_inventory_shipped_quantities.sql', 'utf8'))
    const normalize = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, ['quantity', 'shipped_quantity'].includes(key) ? Number(value) : value]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    for (const period of [{ start: '2026-09-01', end: '2027-08-31' }, { start: '2025-09-01', end: '2026-08-31' }, { start: '', end: '' }]) {
      for (const basis of ['closing', 'net']) {
        const actual = inventoryReportingSnapshot(ledger, warehouses, flexcons, paper, period, basis)
        await db.query("select set_config('test.start',$1,false),set_config('test.end',$2,false)", [basis === 'closing' ? '' : period.start, period.end])
        const expectedBalances = (await db.query('select warehouse_id, warehouse_name, crop_year, origin, product_name, grade, unit, quantity from flexcon_inventory_balances_by_crop_year')).rows
        assert.deepEqual(normalize(actual.balances), normalize(expectedBalances), JSON.stringify({ period, basis }))
        await db.query("select set_config('test.start',$1,false),set_config('test.end',$2,false)", [period.start, period.end])
        const expectedShipped = (await db.query('select warehouse_id, crop_year, origin, product_name, unit, shipped_quantity from flexcon_inventory_shipped_quantities_by_crop_year')).rows
        assert.deepEqual(normalize(actual.shippedQuantities), normalize(expectedShipped))
      }
    }
    const period = { start: '2026-09-01', end: '2027-08-31' }
    const quantity = basis => inventoryReportingSnapshot(ledger, warehouses, flexcons, paper, period, basis).balances.find(row => row.warehouse_id === uuid(2) && row.grade === '1等' && row.unit === '本').quantity
    assert.equal(quantity('closing'), 9)
    assert.equal(quantity('net'), -1)
    assert.deepEqual(inventoryReportingSnapshot(ledger, warehouses, flexcons, paper, { start: '2027-09-01', end: '2026-09-01' }, 'closing'), { balances: [], shippedQuantities: [] })
  } finally { await db.close() }
})
