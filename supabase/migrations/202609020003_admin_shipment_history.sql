-- 出荷履歴の編集・削除を管理者だけに許可します。
-- 202609020002_transport_company_only.sql の実行後に適用してください。

create or replace function public.flexcon_require_admin_worker(p_worker_id text)
returns public.workers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);

  if v_worker.role is distinct from 'admin' then
    raise exception 'この操作は管理者だけが実行できます。';
  end if;

  return v_worker;
end;
$$;

create or replace function public.flexcon_update_shipment(
  p_worker_id text,
  p_shipment_id uuid,
  p_destination_id uuid,
  p_transport_profile_id uuid,
  p_shipped_at timestamptz,
  p_driver_name text,
  p_vehicle_no text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transport public.flexcon_transport_profiles%rowtype;
  v_driver_name text;
  v_vehicle_no text;
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
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

  update public.flexcon_shipments
  set destination_id = p_destination_id,
      transport_profile_id = v_transport.id,
      shipped_at = p_shipped_at,
      carrier_name = v_transport.company_name,
      driver_name = v_driver_name,
      vehicle_no = v_vehicle_no,
      note = nullif(btrim(p_note), '')
  where id = p_shipment_id;

  if not found then
    raise exception '出荷履歴が見つかりません。';
  end if;

  update public.flexcon_scan_events
  set destination_id = p_destination_id
  where shipment_id = p_shipment_id;
end;
$$;

create or replace function public.flexcon_delete_shipment(
  p_worker_id text,
  p_shipment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flexcon_ids uuid[];
begin
  perform public.flexcon_require_admin_worker(p_worker_id);

  perform 1
  from public.flexcon_shipments
  where id = p_shipment_id
  for update;

  if not found then
    raise exception '出荷履歴が見つかりません。';
  end if;

  select array_agg(flexcon_id) into v_flexcon_ids
  from public.flexcon_shipment_items
  where shipment_id = p_shipment_id;

  if v_flexcon_ids is not null then
    perform 1
    from public.flexcon_flexcons
    where id = any(v_flexcon_ids)
    for update;
  end if;

  delete from public.flexcon_scan_events
  where shipment_id = p_shipment_id;

  delete from public.flexcon_shipments
  where id = p_shipment_id;

  if v_flexcon_ids is not null then
    update public.flexcon_flexcons
    set status = 'available',
        updated_at = now()
    where id = any(v_flexcon_ids);
  end if;
end;
$$;

revoke all on function public.flexcon_require_admin_worker(text) from public;
revoke all on function public.flexcon_update_shipment(text, uuid, uuid, uuid, timestamptz, text, text, text) from public;
revoke all on function public.flexcon_delete_shipment(text, uuid) from public;

grant execute on function public.flexcon_update_shipment(text, uuid, uuid, uuid, timestamptz, text, text, text) to anon, authenticated;
grant execute on function public.flexcon_delete_shipment(text, uuid) to anon, authenticated;
