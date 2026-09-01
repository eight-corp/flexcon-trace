-- にんにく冷蔵庫管理と同じSupabaseプロジェクトへ追加するフレコン追跡スキーマ
-- 先に、にんにく冷蔵庫管理の public.workers が存在することを確認してください。

create extension if not exists pgcrypto;

create table if not exists public.flexcon_destinations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  address text,
  contact_name text,
  active boolean not null default true,
  created_by_worker_id text not null references public.workers(worker_id),
  created_at timestamptz not null default now()
);

create table if not exists public.flexcon_flexcons (
  id uuid primary key default gen_random_uuid(),
  lot_number text not null unique check (lot_number ~ '^[0-9]{6}$'),
  status text not null default 'available' check (status in ('available', 'shipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.flexcon_shipments (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.flexcon_destinations(id),
  shipped_at timestamptz not null default now(),
  vehicle_no text,
  note text,
  created_by_worker_id text not null references public.workers(worker_id),
  created_at timestamptz not null default now()
);

create table if not exists public.flexcon_shipment_items (
  shipment_id uuid not null references public.flexcon_shipments(id) on delete cascade,
  flexcon_id uuid not null unique references public.flexcon_flexcons(id),
  lot_number text not null unique check (lot_number ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now(),
  primary key (shipment_id, flexcon_id)
);

create table if not exists public.flexcon_scan_events (
  id bigint generated always as identity primary key,
  flexcon_id uuid not null references public.flexcon_flexcons(id),
  shipment_id uuid references public.flexcon_shipments(id),
  event_type text not null check (event_type in ('registered', 'shipped')),
  destination_id uuid references public.flexcon_destinations(id),
  worker_id text not null references public.workers(worker_id),
  occurred_at timestamptz not null default now()
);

create index if not exists flexcon_shipments_shipped_at_idx
  on public.flexcon_shipments (shipped_at desc);
create index if not exists flexcon_shipments_destination_idx
  on public.flexcon_shipments (destination_id);
create index if not exists flexcon_scan_events_flexcon_idx
  on public.flexcon_scan_events (flexcon_id, occurred_at desc);

alter table public.flexcon_destinations enable row level security;
alter table public.flexcon_flexcons enable row level security;
alter table public.flexcon_shipments enable row level security;
alter table public.flexcon_shipment_items enable row level security;
alter table public.flexcon_scan_events enable row level security;

drop policy if exists flexcon_read_destinations on public.flexcon_destinations;
create policy flexcon_read_destinations on public.flexcon_destinations
  for select to anon, authenticated using (true);

drop policy if exists flexcon_read_flexcons on public.flexcon_flexcons;
create policy flexcon_read_flexcons on public.flexcon_flexcons
  for select to anon, authenticated using (true);

drop policy if exists flexcon_read_shipments on public.flexcon_shipments;
create policy flexcon_read_shipments on public.flexcon_shipments
  for select to anon, authenticated using (true);

drop policy if exists flexcon_read_shipment_items on public.flexcon_shipment_items;
create policy flexcon_read_shipment_items on public.flexcon_shipment_items
  for select to anon, authenticated using (true);

drop policy if exists flexcon_read_scan_events on public.flexcon_scan_events;
create policy flexcon_read_scan_events on public.flexcon_scan_events
  for select to anon, authenticated using (true);

create or replace function public.flexcon_require_active_worker(p_worker_id text)
returns public.workers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
begin
  select * into v_worker
  from public.workers
  where worker_id = btrim(coalesce(p_worker_id, ''))
    and active = true;

  if not found then
    raise exception '作業者が無効です。もう一度ログインしてください。';
  end if;

  return v_worker;
end;
$$;

create or replace function public.flexcon_add_destination(
  p_worker_id text,
  p_name text,
  p_address text default null,
  p_contact_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_destination_id uuid;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);

  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception '納品先名を1文字から120文字で入力してください。';
  end if;

  insert into public.flexcon_destinations (
    name, address, contact_name, created_by_worker_id
  ) values (
    btrim(p_name), nullif(btrim(p_address), ''), nullif(btrim(p_contact_name), ''), v_worker.worker_id
  ) returning id into v_destination_id;

  return v_destination_id;
end;
$$;

create or replace function public.flexcon_set_destination_active(
  p_worker_id text,
  p_destination_id uuid,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  update public.flexcon_destinations
  set active = coalesce(p_active, false)
  where id = p_destination_id;

  if not found then
    raise exception '納品先が見つかりません。';
  end if;
end;
$$;

create or replace function public.flexcon_register_shipment(
  p_worker_id text,
  p_destination_id uuid,
  p_lot_numbers text[],
  p_vehicle_no text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_shipment_id uuid;
  v_count integer;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_count := coalesce(array_length(p_lot_numbers, 1), 0);

  if v_count < 1 or v_count > 24 then
    raise exception '一度に登録できる本数は1本から24本です。';
  end if;

  if exists (
    select 1 from unnest(p_lot_numbers) as lot
    where lot !~ '^[0-9]{6}$'
  ) then
    raise exception '6桁ではないロット番号が含まれています。';
  end if;

  if (select count(distinct lot) from unnest(p_lot_numbers) as lot) <> v_count then
    raise exception '同じロット番号が重複しています。';
  end if;

  if not exists (
    select 1 from public.flexcon_destinations
    where id = p_destination_id and active = true
  ) then
    raise exception '選択された納品先は利用できません。';
  end if;

  insert into public.flexcon_flexcons (lot_number)
  select lot from unnest(p_lot_numbers) as lot
  on conflict (lot_number) do nothing;

  perform 1
  from public.flexcon_flexcons
  where lot_number = any(p_lot_numbers)
  for update;

  if exists (
    select 1 from public.flexcon_flexcons
    where lot_number = any(p_lot_numbers) and status <> 'available'
  ) then
    raise exception 'すでに出荷済みのロット番号が含まれています。';
  end if;

  insert into public.flexcon_shipments (
    destination_id, vehicle_no, note, created_by_worker_id
  ) values (
    p_destination_id,
    nullif(btrim(p_vehicle_no), ''),
    nullif(btrim(p_note), ''),
    v_worker.worker_id
  ) returning id into v_shipment_id;

  insert into public.flexcon_shipment_items (shipment_id, flexcon_id, lot_number)
  select v_shipment_id, id, lot_number
  from public.flexcon_flexcons
  where lot_number = any(p_lot_numbers);

  update public.flexcon_flexcons
  set status = 'shipped', updated_at = now()
  where lot_number = any(p_lot_numbers);

  insert into public.flexcon_scan_events (
    flexcon_id, shipment_id, event_type, destination_id, worker_id
  )
  select id, v_shipment_id, 'shipped', p_destination_id, v_worker.worker_id
  from public.flexcon_flexcons
  where lot_number = any(p_lot_numbers);

  return v_shipment_id;
end;
$$;

revoke all on function public.flexcon_require_active_worker(text) from public;
revoke all on function public.flexcon_add_destination(text, text, text, text) from public;
revoke all on function public.flexcon_set_destination_active(text, uuid, boolean) from public;
revoke all on function public.flexcon_register_shipment(text, uuid, text[], text, text) from public;

grant usage on schema public to anon, authenticated;
grant select on public.flexcon_destinations, public.flexcon_flexcons,
  public.flexcon_shipments, public.flexcon_shipment_items,
  public.flexcon_scan_events to anon, authenticated;
grant execute on function public.flexcon_add_destination(text, text, text, text) to anon, authenticated;
grant execute on function public.flexcon_set_destination_active(text, uuid, boolean) to anon, authenticated;
grant execute on function public.flexcon_register_shipment(text, uuid, text[], text, text) to anon, authenticated;

