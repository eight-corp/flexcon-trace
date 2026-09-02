-- 運送会社マスターを会社名だけにし、ドライバー名と車両番号は出荷ごとに入力します。
-- 202609020001_shipping_details.sql の実行後に適用してください。

alter table public.flexcon_transport_profiles
  alter column driver_name drop not null,
  alter column vehicle_no drop not null;

update public.flexcon_transport_profiles
set driver_name = null,
    vehicle_no = null,
    updated_at = now();

with duplicate_companies as (
  select id,
         row_number() over (
           partition by lower(btrim(company_name))
           order by created_at, id
         ) as company_order
  from public.flexcon_transport_profiles
  where active = true
)
update public.flexcon_transport_profiles as profile
set active = false,
    updated_at = now()
from duplicate_companies
where profile.id = duplicate_companies.id
  and duplicate_companies.company_order > 1;

drop function if exists public.flexcon_add_transport_profile(text, text, text, text);
drop function if exists public.flexcon_update_transport_profile(text, uuid, text, text, text);
drop function if exists public.flexcon_register_shipment(text, uuid, uuid, timestamptz, text, text[], text);

create or replace function public.flexcon_add_transport_profile(
  p_worker_id text,
  p_company_name text
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
  if exists (
    select 1
    from public.flexcon_transport_profiles
    where active = true
      and lower(btrim(company_name)) = lower(btrim(p_company_name))
  ) then
    raise exception '同じ運送会社名がすでに登録されています。';
  end if;

  insert into public.flexcon_transport_profiles (
    company_name, driver_name, vehicle_no, created_by_worker_id
  ) values (
    btrim(p_company_name), null, null, v_worker.worker_id
  ) returning id into v_profile_id;

  return v_profile_id;
end;
$$;

create or replace function public.flexcon_update_transport_profile(
  p_worker_id text,
  p_profile_id uuid,
  p_company_name text
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
  if exists (
    select 1
    from public.flexcon_transport_profiles
    where id <> p_profile_id
      and active = true
      and lower(btrim(company_name)) = lower(btrim(p_company_name))
  ) then
    raise exception '同じ運送会社名がすでに登録されています。';
  end if;

  update public.flexcon_transport_profiles
  set company_name = btrim(p_company_name),
      driver_name = null,
      vehicle_no = null,
      updated_at = now()
  where id = p_profile_id;

  if not found then
    raise exception '運送会社が見つかりません。';
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
declare
  v_company_name text;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select company_name into v_company_name
  from public.flexcon_transport_profiles
  where id = p_profile_id;

  if not found then
    raise exception '運送会社が見つかりません。';
  end if;
  if coalesce(p_active, false) and exists (
    select 1
    from public.flexcon_transport_profiles
    where id <> p_profile_id
      and active = true
      and lower(btrim(company_name)) = lower(btrim(v_company_name))
  ) then
    raise exception '同じ運送会社名がすでに有効になっています。';
  end if;

  update public.flexcon_transport_profiles
  set active = coalesce(p_active, false),
      updated_at = now()
  where id = p_profile_id;
end;
$$;

create or replace function public.flexcon_register_shipment(
  p_worker_id text,
  p_destination_id uuid,
  p_transport_profile_id uuid,
  p_shipped_at timestamptz,
  p_driver_name text,
  p_vehicle_no text,
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
  v_driver_name text;
  v_vehicle_no text;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_count := coalesce(array_length(p_lot_numbers, 1), 0);
  v_driver_name := nullif(btrim(p_driver_name), '');
  v_vehicle_no := nullif(btrim(p_vehicle_no), '');

  if p_shipped_at is null then
    raise exception '出荷日時を入力してください。';
  end if;
  if v_driver_name is null then
    raise exception 'ドライバー名を入力してください。';
  end if;
  if v_vehicle_no is null then
    raise exception '車両番号を入力してください。';
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
    raise exception '選択された運送会社は利用できません。';
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
    null,
    v_transport.id,
    v_transport.company_name,
    v_driver_name,
    v_vehicle_no,
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

-- 旧PWAが端末に残っている間も、マスターへドライバー・車両を保存しません。
create or replace function public.flexcon_add_transport_profile(
  p_worker_id text,
  p_company_name text,
  p_driver_name text,
  p_vehicle_no text
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public.flexcon_add_transport_profile(p_worker_id, p_company_name);
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
  perform public.flexcon_update_transport_profile(p_worker_id, p_profile_id, p_company_name);
end;
$$;

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
begin
  raise exception '出荷画面が更新されています。アプリを閉じて開き直してください。';
end;
$$;

revoke all on function public.flexcon_add_transport_profile(text, text) from public;
revoke all on function public.flexcon_update_transport_profile(text, uuid, text) from public;
revoke all on function public.flexcon_register_shipment(text, uuid, uuid, timestamptz, text, text, text[], text) from public;
revoke all on function public.flexcon_add_transport_profile(text, text, text, text) from public;
revoke all on function public.flexcon_update_transport_profile(text, uuid, text, text, text) from public;
revoke all on function public.flexcon_register_shipment(text, uuid, uuid, timestamptz, text, text[], text) from public;

grant execute on function public.flexcon_add_transport_profile(text, text) to anon, authenticated;
grant execute on function public.flexcon_update_transport_profile(text, uuid, text) to anon, authenticated;
grant execute on function public.flexcon_register_shipment(text, uuid, uuid, timestamptz, text, text, text[], text) to anon, authenticated;
grant execute on function public.flexcon_add_transport_profile(text, text, text, text) to anon, authenticated;
grant execute on function public.flexcon_update_transport_profile(text, uuid, text, text, text) to anon, authenticated;
grant execute on function public.flexcon_register_shipment(text, uuid, uuid, timestamptz, text, text[], text) to anon, authenticated;
