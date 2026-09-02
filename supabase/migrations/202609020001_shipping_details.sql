-- 出荷詳細、納品先編集、運送会社情報管理を追加します。
-- 202609010001_shared_garlic_supabase.sql の実行後に適用してください。

create table if not exists public.flexcon_transport_profiles (
  id uuid primary key default gen_random_uuid(),
  company_name text not null check (char_length(btrim(company_name)) between 1 and 120),
  driver_name text not null check (char_length(btrim(driver_name)) between 1 and 120),
  vehicle_no text not null check (char_length(btrim(vehicle_no)) between 1 and 60),
  active boolean not null default true,
  created_by_worker_id text not null references public.workers(worker_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists flexcon_transport_profiles_company_idx
  on public.flexcon_transport_profiles (company_name, driver_name, vehicle_no);

alter table public.flexcon_shipments
  add column if not exists contact_name text,
  add column if not exists transport_profile_id uuid references public.flexcon_transport_profiles(id),
  add column if not exists carrier_name text,
  add column if not exists driver_name text;

alter table public.flexcon_transport_profiles enable row level security;

drop policy if exists flexcon_read_transport_profiles on public.flexcon_transport_profiles;
create policy flexcon_read_transport_profiles on public.flexcon_transport_profiles
  for select to anon, authenticated using (true);

create or replace function public.flexcon_update_destination(
  p_worker_id text,
  p_destination_id uuid,
  p_name text,
  p_address text default null,
  p_contact_name text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception '納品先名を1文字から120文字で入力してください。';
  end if;

  update public.flexcon_destinations
  set name = btrim(p_name),
      address = nullif(btrim(p_address), ''),
      contact_name = nullif(btrim(p_contact_name), '')
  where id = p_destination_id;

  if not found then
    raise exception '納品先が見つかりません。';
  end if;
end;
$$;

create or replace function public.flexcon_add_transport_profile(
  p_worker_id text,
  p_company_name text,
  p_driver_name text,
  p_vehicle_no text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_profile_id uuid;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);

  if char_length(btrim(coalesce(p_company_name, ''))) not between 1 and 120 then
    raise exception '運送会社名を入力してください。';
  end if;
  if char_length(btrim(coalesce(p_driver_name, ''))) not between 1 and 120 then
    raise exception 'ドライバー名を入力してください。';
  end if;
  if char_length(btrim(coalesce(p_vehicle_no, ''))) not between 1 and 60 then
    raise exception '車両番号を入力してください。';
  end if;

  insert into public.flexcon_transport_profiles (
    company_name, driver_name, vehicle_no, created_by_worker_id
  ) values (
    btrim(p_company_name), btrim(p_driver_name), btrim(p_vehicle_no), v_worker.worker_id
  ) returning id into v_profile_id;

  return v_profile_id;
end;
$$;

create or replace function public.flexcon_update_transport_profile(
  p_worker_id text,
  p_profile_id uuid,
  p_company_name text,
  p_driver_name text,
  p_vehicle_no text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if char_length(btrim(coalesce(p_company_name, ''))) not between 1 and 120 then
    raise exception '運送会社名を入力してください。';
  end if;
  if char_length(btrim(coalesce(p_driver_name, ''))) not between 1 and 120 then
    raise exception 'ドライバー名を入力してください。';
  end if;
  if char_length(btrim(coalesce(p_vehicle_no, ''))) not between 1 and 60 then
    raise exception '車両番号を入力してください。';
  end if;

  update public.flexcon_transport_profiles
  set company_name = btrim(p_company_name),
      driver_name = btrim(p_driver_name),
      vehicle_no = btrim(p_vehicle_no),
      updated_at = now()
  where id = p_profile_id;

  if not found then
    raise exception '運送会社情報が見つかりません。';
  end if;
end;
$$;

create or replace function public.flexcon_set_transport_profile_active(
  p_worker_id text,
  p_profile_id uuid,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  update public.flexcon_transport_profiles
  set active = coalesce(p_active, false),
      updated_at = now()
  where id = p_profile_id;

  if not found then
    raise exception '運送会社情報が見つかりません。';
  end if;
end;
$$;

drop function if exists public.flexcon_register_shipment(text, uuid, text[], text, text);

create or replace function public.flexcon_register_shipment(
  p_worker_id text,
  p_destination_id uuid,
  p_transport_profile_id uuid,
  p_shipped_at timestamptz,
  p_contact_name text,
  p_lot_numbers text[],
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_transport public.flexcon_transport_profiles%rowtype;
  v_shipment_id uuid;
  v_count integer;
  v_contact_name text;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_count := coalesce(array_length(p_lot_numbers, 1), 0);
  v_contact_name := nullif(btrim(p_contact_name), '');

  if p_shipped_at is null then
    raise exception '出荷日時を入力してください。';
  end if;
  if v_contact_name is null then
    raise exception '納品先の担当者を入力してください。';
  end if;
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

  select * into v_transport
  from public.flexcon_transport_profiles
  where id = p_transport_profile_id and active = true;

  if not found then
    raise exception '選択された運送会社情報は利用できません。';
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
    destination_id,
    shipped_at,
    contact_name,
    transport_profile_id,
    carrier_name,
    driver_name,
    vehicle_no,
    note,
    created_by_worker_id
  ) values (
    p_destination_id,
    p_shipped_at,
    v_contact_name,
    v_transport.id,
    v_transport.company_name,
    v_transport.driver_name,
    v_transport.vehicle_no,
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

revoke all on function public.flexcon_update_destination(text, uuid, text, text, text) from public;
revoke all on function public.flexcon_add_transport_profile(text, text, text, text) from public;
revoke all on function public.flexcon_update_transport_profile(text, uuid, text, text, text) from public;
revoke all on function public.flexcon_set_transport_profile_active(text, uuid, boolean) from public;
revoke all on function public.flexcon_register_shipment(text, uuid, uuid, timestamptz, text, text[], text) from public;

grant select on public.flexcon_transport_profiles to anon, authenticated;
grant execute on function public.flexcon_update_destination(text, uuid, text, text, text) to anon, authenticated;
grant execute on function public.flexcon_add_transport_profile(text, text, text, text) to anon, authenticated;
grant execute on function public.flexcon_update_transport_profile(text, uuid, text, text, text) to anon, authenticated;
grant execute on function public.flexcon_set_transport_profile_active(text, uuid, boolean) to anon, authenticated;
grant execute on function public.flexcon_register_shipment(text, uuid, uuid, timestamptz, text, text[], text) to anon, authenticated;
