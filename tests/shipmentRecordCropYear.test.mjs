import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const migration = readFileSync(new URL('../supabase/migrations/202609300003_shipment_record_crop_year.sql', import.meta.url), 'utf8')
const uuid = (number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`

test('shipment record crop years stay separate and appear in inventory ledger', async (t) => {
  const db = new PGlite()
  try {
    await db.exec(`
      create table public.workers (worker_id text primary key, worker_name text);
      create table public.flexcon_destinations (id uuid primary key, name text, active boolean not null);
      create table public.flexcon_inspection_options (id uuid primary key, option_type text, name text, active boolean);
      create table public.flexcon_inventory_movements (id uuid primary key, settlement_no text, crop_year integer, note text);
      create table public.flexcon_purchase_statement_lines (id uuid primary key, crop_year integer);
      create table public.flexcon_shipments (
        id uuid primary key, destination_id uuid, shipped_at timestamptz, created_at timestamptz default now(),
        created_by_worker_id text, inventory_from_warehouse_id uuid, shipment_kind text,
        product_name text, quantity_count integer, origin_prefecture text, purchase_price_per_bale numeric
      );
      create table public.flexcon_manual_shipment_items (
        id uuid primary key default gen_random_uuid(), shipment_id uuid references public.flexcon_shipments(id),
        origin_prefecture text, product_name text, quantity_count integer, grade text,
        moisture numeric, reason text, unit text, sort_order integer
      );
      create view public.flexcon_inventory_ledger_base as select
        null::text as id, null::bigint as registration_order, null::text as source_type,
        null::text as movement_type, null::date as movement_date, null::text as worker_name,
        null::text as producer_name, null::text as settlement_no, null::text as origin,
        null::text as product_name, null::text as grade, null::numeric as quantity,
        null::text as unit, null::uuid as from_warehouse_id, null::uuid as to_warehouse_id,
        null::text as movement_from, null::text as movement_to, null::timestamptz as created_at,
        null::numeric as purchase_price where false;
      insert into public.workers values ('worker', '担当者');
      insert into public.flexcon_inspection_options values ('${uuid(1)}', 'warehouse', '倉庫A', true),
        ('${uuid(2)}', 'shipment_product', '米', true);
      insert into public.flexcon_shipments
        (id, destination_id, shipped_at, created_by_worker_id, inventory_from_warehouse_id, shipment_kind)
        values ('${uuid(3)}', null, '2026-09-30T09:00:00+09:00', 'worker', '${uuid(1)}', 'manual_record');
    `)
    await db.exec(migration)
    const item = (cropYear, quantity = 1) => ({ crop_year: cropYear, origin_prefecture: '青森県', product_name: '米', quantity_count: quantity, grade: null, unit: '本' })
    const replace = (items, isNew) => db.query(
      'select public.flexcon_replace_record_items($1::uuid, $2::jsonb, $3::boolean)',
      [uuid(3), JSON.stringify(items), isNew],
    )

    await t.test('new records require valid crop years', async () => {
      await assert.rejects(replace([item(null)], true), /産年を入力してください/)
      await assert.rejects(replace([item(2101)], true), /産年を確認してください/)
      assert.equal((await db.query('select count(*)::integer as count from public.flexcon_manual_shipment_items')).rows[0].count, 0)
    })

    await t.test('same product in different years stays separate and feeds inventory', async () => {
      await replace([item(2025, 2), item(2026, 3)], true)
      const rows = (await db.query(`select crop_year, quantity_count from public.flexcon_manual_shipment_items
        where shipment_id = $1::uuid order by crop_year`, [uuid(3)])).rows
      assert.deepEqual(rows, [{ crop_year: 2025, quantity_count: 2 }, { crop_year: 2026, quantity_count: 3 }])
      const ledger = (await db.query(`select crop_year, quantity, movement_type, movement_to from public.flexcon_inventory_ledger
        where source_type = 'shipment_record' order by crop_year`)).rows
      assert.deepEqual(ledger.map(row => ({ ...row, quantity: Number(row.quantity) })), [
        { crop_year: 2025, quantity: 2, movement_type: 'outbound', movement_to: null },
        { crop_year: 2026, quantity: 3, movement_type: 'outbound', movement_to: null },
      ])
    })

    await t.test('duplicate years are rejected without changing saved rows', async () => {
      await assert.rejects(replace([item(2025), item(2025)], true), /重複しています/)
      assert.equal((await db.query('select count(*)::integer as count from public.flexcon_manual_shipment_items')).rows[0].count, 2)
    })

    await t.test('legacy records without a crop year remain editable', async () => {
      await replace([item(null)], false)
      assert.equal((await db.query('select crop_year from public.flexcon_manual_shipment_items')).rows[0].crop_year, null)
    })
  } finally {
    await db.close()
  }
})
