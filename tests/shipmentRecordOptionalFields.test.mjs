import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const migration = readFileSync(new URL('../supabase/migrations/202609300001_optional_shipment_record_destination_transport.sql', import.meta.url), 'utf8')
const uuid = (number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`

test('shipment records accept optional destination and transport details without relaxing other shipments', async (t) => {
  const db = new PGlite()
  try {
    await db.exec(`
      create table public.workers (worker_id text primary key);
      insert into public.workers values ('tester');
      create function public.flexcon_require_active_worker(p_worker_id text) returns public.workers
      language plpgsql as $$ declare v_worker public.workers%rowtype; begin
        select * into v_worker from public.workers where worker_id = p_worker_id;
        if not found then raise exception '担当者が見つかりません。'; end if;
        return v_worker;
      end; $$;
      create function public.flexcon_require_admin_worker(p_worker_id text) returns void
      language plpgsql as $$ begin
        if p_worker_id <> 'tester' then raise exception '管理者のみ編集できます。'; end if;
      end; $$;
      create table public.flexcon_destinations (id uuid primary key, active boolean not null);
      create table public.flexcon_transport_profiles (id uuid primary key, company_name text not null, active boolean not null);
      create table public.flexcon_inspection_options (id uuid primary key, option_type text not null);
      create table public.flexcon_shipments (
        id uuid primary key default gen_random_uuid(), destination_id uuid not null references public.flexcon_destinations(id),
        shipped_at timestamptz not null, contact_name text, transport_profile_id uuid references public.flexcon_transport_profiles(id),
        carrier_name text, driver_name text, vehicle_no text, note text, created_by_worker_id text,
        shipment_kind text not null default 'qr_flexcon', product_name text, quantity_count integer,
        purchase_price_per_bale numeric, inventory_from_warehouse_id uuid
      );
      create table public.flexcon_record_item_payload (shipment_id uuid primary key references public.flexcon_shipments(id), items jsonb not null);
      create table public.flexcon_inventory_balances (quantity numeric not null);
      create function public.flexcon_replace_record_items(p_shipment_id uuid, p_items jsonb, p_require_active boolean)
      returns void language plpgsql as $$ begin
        if p_items is null or jsonb_array_length(p_items) = 0 then raise exception '出荷明細を1件以上追加してください。'; end if;
        insert into public.flexcon_record_item_payload values (p_shipment_id, p_items)
        on conflict (shipment_id) do update set items = excluded.items;
      end; $$;
      insert into public.flexcon_destinations values ('${uuid(1)}', true), ('${uuid(2)}', false);
      insert into public.flexcon_transport_profiles values ('${uuid(3)}', '運送会社A', true), ('${uuid(4)}', '運送会社B', false);
      insert into public.flexcon_inspection_options values ('${uuid(5)}', 'warehouse');
    `)
    await db.exec(migration)
    const items = JSON.stringify([{ origin_prefecture: '青森県', product_name: '米', quantity_count: 1, unit: '本' }])
    const register = (destination, transport, driver, vehicle) => db.query(
      `select public.flexcon_register_inventory_record('tester', $1::uuid, $2::uuid,
        '2026-09-30T09:00:00+09:00', $3, $4, $5::jsonb, null, $6::uuid, null) as id`,
      [destination, transport, driver, vehicle, items, uuid(5)],
    ).then(result => result.rows[0].id)
    const update = (id, destination, transport, driver, vehicle) => db.query(
      `select public.flexcon_update_inventory_record('tester', $1::uuid, $2::uuid, $3::uuid,
        '2026-09-30T10:00:00+09:00', $4, $5, $6::jsonb, null, null)`,
      [id, destination, transport, driver, vehicle, items],
    )
    const details = (id) => db.query(
      'select destination_id, transport_profile_id, carrier_name, driver_name, vehicle_no from public.flexcon_shipments where id = $1::uuid',
      [id],
    ).then(result => result.rows[0])

    await t.test('all four fields can be absent', async () => {
      const id = await register(null, null, null, null)
      assert.deepEqual(await details(id), {
        destination_id: null, transport_profile_id: null, carrier_name: null, driver_name: null, vehicle_no: null,
      })
      assert.equal((await db.query('select count(*)::integer as count from public.flexcon_record_item_payload')).rows[0].count, 1)
    })

    await t.test('provided fields persist and can later be cleared', async () => {
      const id = await register(uuid(1), uuid(3), '  山田  ', '  青森 100  ')
      assert.deepEqual(await details(id), {
        destination_id: uuid(1), transport_profile_id: uuid(3), carrier_name: '運送会社A', driver_name: '山田', vehicle_no: '青森 100',
      })
      await update(id, null, null, '', '')
      assert.deepEqual(await details(id), {
        destination_id: null, transport_profile_id: null, carrier_name: null, driver_name: null, vehicle_no: null,
      })
      await update(id, uuid(1), uuid(3), '田中', '岩手 200')
      assert.equal((await details(id)).carrier_name, '運送会社A')
    })

    await t.test('inactive selections and missing destination for other shipment kinds are rejected', async () => {
      await assert.rejects(register(uuid(2), null, null, null), /納品先は利用できません/)
      await assert.rejects(register(null, uuid(4), null, null), /運送会社は利用できません/)
      await assert.rejects(db.query(
        "insert into public.flexcon_shipments (destination_id, shipped_at, shipment_kind) values (null, now(), 'qr_flexcon')",
      ), /flexcon_shipments_destination_required_for_other_kinds/)
    })
  } finally {
    await db.close()
  }
})
