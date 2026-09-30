import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const migration = readFileSync(new URL('../supabase/migrations/202609300004_inventory_shipped_quantities.sql', import.meta.url), 'utf8')
const uuid = (number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`

test('shipped quantities follow inventory row dimensions and exclude transfers', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create table public.flexcon_inspection_options (
        id uuid primary key, option_type text, name text, created_at timestamptz default now()
      );
      create table public.flexcon_inspection_flexcons (id uuid primary key, fiscal_year integer);
      create table public.flexcon_inventory_ledger (
        id text, source_type text, from_warehouse_id uuid, crop_year integer,
        origin text, product_name text, grade text, unit text, quantity numeric
      );
      insert into public.flexcon_inspection_options (id, option_type, name) values
        ('${uuid(1)}', 'warehouse', '倉庫未設定'),
        ('${uuid(2)}', 'warehouse', '倉庫A'),
        ('${uuid(3)}', 'warehouse', '倉庫B');
      insert into public.flexcon_inspection_flexcons values ('${uuid(4)}', 7);
      insert into public.flexcon_inventory_ledger values
        ('shipment-flexcon:${uuid(5)}:${uuid(4)}', 'shipment_flexcon', '${uuid(2)}', null, '青森県', '米', '1等', '本', 2),
        ('shipment-flexcon:${uuid(6)}:${uuid(4)}', 'shipment_flexcon', '${uuid(2)}', null, '青森県', '米', '2等', '本', 3),
        ('shipment-manual:${uuid(7)}', 'shipment_manual', '${uuid(2)}', 2026, '青森県', '米', '1等', '本', 4),
        ('shipment-record:${uuid(8)}', 'shipment_record', '${uuid(3)}', 2025, '青森県', '米', '1等', '本', 6),
        ('shipment-record:${uuid(9)}', 'shipment_record', '${uuid(1)}', 2025, '青森県', '米', '1等', '本', 1),
        ('transfer:${uuid(10)}', 'manual', '${uuid(2)}', 2025, '青森県', '米', '1等', '本', 20),
        ('shipment-record:${uuid(11)}', 'shipment_record', '${uuid(2)}', 2025, '青森県', '米', '1等', '袋', 7);
    `)
    await db.exec(migration)
    const rows = (await db.query(`
      select warehouse_id, crop_year, unit, shipped_quantity
      from public.flexcon_inventory_shipped_quantities_by_crop_year
      order by warehouse_id nulls first, crop_year, unit
    `)).rows.map((row) => ({ ...row, shipped_quantity: Number(row.shipped_quantity) }))
    assert.deepEqual(rows, [
      { warehouse_id: null, crop_year: 2025, unit: '本', shipped_quantity: 1 },
      { warehouse_id: uuid(2), crop_year: 2025, unit: '本', shipped_quantity: 5 },
      { warehouse_id: uuid(2), crop_year: 2025, unit: '袋', shipped_quantity: 7 },
      { warehouse_id: uuid(2), crop_year: 2026, unit: '本', shipped_quantity: 4 },
      { warehouse_id: uuid(3), crop_year: 2025, unit: '本', shipped_quantity: 6 },
    ])
  } finally {
    await db.close()
  }
})
