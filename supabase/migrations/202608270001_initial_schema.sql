create extension if not exists pgcrypto;

create table if not exists public.destinations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  address text,
  contact_name text,
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.flexcons (
  id uuid primary key default gen_random_uuid(),
  lot_number text not null unique check (lot_number ~ '^[0-9]{6}$'),
  status text not null default 'available' check (status in ('available', 'shipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.destinations(id),
  shipped_at timestamptz not null default now(),
  vehicle_no text,
  note text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.shipment_items (
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  flexcon_id uuid not null unique references public.flexcons(id),
  lot_number text not null unique check (lot_number ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now(),
  primary key (shipment_id, flexcon_id)
);

create table if not exists public.scan_events (
  id bigint generated always as identity primary key,
  flexcon_id uuid not null references public.flexcons(id),
  shipment_id uuid references public.shipments(id),
  event_type text not null check (event_type in ('registered', 'shipped')),
  destination_id uuid references public.destinations(id),
  created_by uuid not null references auth.users(id),
  occurred_at timestamptz not null default now()
);

create index if not exists shipments_shipped_at_idx on public.shipments (shipped_at desc);
create index if not exists shipments_destination_idx on public.shipments (destination_id);
create index if not exists scan_events_flexcon_idx on public.scan_events (flexcon_id, occurred_at desc);

alter table public.destinations enable row level security;
alter table public.flexcons enable row level security;
alter table public.shipments enable row level security;
alter table public.shipment_items enable row level security;
alter table public.scan_events enable row level security;

drop policy if exists "authenticated users can read destinations" on public.destinations;
create policy "authenticated users can read destinations"
  on public.destinations for select to authenticated using (true);

drop policy if exists "authenticated users can add destinations" on public.destinations;
create policy "authenticated users can add destinations"
  on public.destinations for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "authenticated users can update destinations" on public.destinations;
create policy "authenticated users can update destinations"
  on public.destinations for update to authenticated using (true) with check (true);

drop policy if exists "authenticated users can read flexcons" on public.flexcons;
create policy "authenticated users can read flexcons"
  on public.flexcons for select to authenticated using (true);

drop policy if exists "authenticated users can read shipments" on public.shipments;
create policy "authenticated users can read shipments"
  on public.shipments for select to authenticated using (true);

drop policy if exists "authenticated users can read shipment items" on public.shipment_items;
create policy "authenticated users can read shipment items"
  on public.shipment_items for select to authenticated using (true);

drop policy if exists "authenticated users can read scan events" on public.scan_events;
create policy "authenticated users can read scan events"
  on public.scan_events for select to authenticated using (true);

create or replace function public.register_shipment(
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
  v_user_id uuid := auth.uid();
  v_shipment_id uuid;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'ログインが必要です。';
  end if;

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
    select 1 from public.destinations
    where id = p_destination_id and active = true
  ) then
    raise exception '選択された納品先は利用できません。';
  end if;

  insert into public.flexcons (lot_number)
  select lot from unnest(p_lot_numbers) as lot
  on conflict (lot_number) do nothing;

  perform 1
  from public.flexcons
  where lot_number = any(p_lot_numbers)
  for update;

  if exists (
    select 1 from public.flexcons
    where lot_number = any(p_lot_numbers) and status <> 'available'
  ) then
    raise exception 'すでに出荷済みのロット番号が含まれています。';
  end if;

  insert into public.shipments (destination_id, vehicle_no, note, created_by)
  values (p_destination_id, nullif(trim(p_vehicle_no), ''), nullif(trim(p_note), ''), v_user_id)
  returning id into v_shipment_id;

  insert into public.shipment_items (shipment_id, flexcon_id, lot_number)
  select v_shipment_id, id, lot_number
  from public.flexcons
  where lot_number = any(p_lot_numbers);

  update public.flexcons
  set status = 'shipped', updated_at = now()
  where lot_number = any(p_lot_numbers);

  insert into public.scan_events (
    flexcon_id, shipment_id, event_type, destination_id, created_by
  )
  select id, v_shipment_id, 'shipped', p_destination_id, v_user_id
  from public.flexcons
  where lot_number = any(p_lot_numbers);

  return v_shipment_id;
end;
$$;

revoke all on function public.register_shipment(uuid, text[], text, text) from public;
grant execute on function public.register_shipment(uuid, text[], text, text) to authenticated;

grant usage on schema public to authenticated;
grant select on public.destinations, public.flexcons, public.shipments, public.shipment_items, public.scan_events to authenticated;
grant insert, update on public.destinations to authenticated;
