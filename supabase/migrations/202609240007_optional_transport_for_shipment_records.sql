begin;

create or replace function public.flexcon_register_inventory_record(
  p_worker_id text, p_destination_id uuid, p_transport_profile_id uuid, p_shipped_at timestamptz,
  p_driver_name text, p_vehicle_no text, p_items jsonb, p_purchase_price_per_bale numeric,
  p_from_warehouse_id uuid, p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_id uuid;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if p_shipped_at is null then raise exception '出荷日時を入力してください。'; end if;
  if p_purchase_price_per_bale < 0 then raise exception '仕入値は0以上で入力してください。'; end if;
  if not exists (select 1 from public.flexcon_destinations where id = p_destination_id and active) then
    raise exception '納品先を選択してください。';
  end if;
  if not exists (select 1 from public.flexcon_inspection_options
    where id = p_from_warehouse_id and option_type = 'warehouse') then
    raise exception '出庫元倉庫を選択してください。';
  end if;

  insert into public.flexcon_shipments (
    destination_id, shipped_at, contact_name, transport_profile_id, carrier_name,
    driver_name, vehicle_no, note, created_by_worker_id, shipment_kind,
    product_name, quantity_count, purchase_price_per_bale, inventory_from_warehouse_id
  ) values (
    p_destination_id, p_shipped_at, null, null, null,
    null, null, nullif(btrim(p_note), ''), v_worker.worker_id,
    'manual_record', '出荷記録', 1, p_purchase_price_per_bale, p_from_warehouse_id
  ) returning id into v_id;
  perform public.flexcon_replace_record_items(v_id, p_items, true);
  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '出庫元倉庫の在庫が不足しているため出荷できません。';
  end if;
  return v_id;
end;
$$;

create or replace function public.flexcon_update_inventory_record(
  p_worker_id text, p_shipment_id uuid, p_destination_id uuid, p_transport_profile_id uuid,
  p_shipped_at timestamptz, p_driver_name text, p_vehicle_no text, p_items jsonb,
  p_purchase_price_per_bale numeric, p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  if not exists (select 1 from public.flexcon_shipments
    where id = p_shipment_id and shipment_kind = 'manual_record') then
    raise exception '出荷記録が見つかりません。';
  end if;
  if p_shipped_at is null then raise exception '出荷日時を入力してください。'; end if;
  if p_purchase_price_per_bale < 0 then raise exception '仕入値は0以上で入力してください。'; end if;
  if not exists (select 1 from public.flexcon_destinations where id = p_destination_id and active) then
    raise exception '納品先を選択してください。';
  end if;

  perform public.flexcon_replace_record_items(p_shipment_id, p_items, false);
  update public.flexcon_shipments
  set destination_id = p_destination_id, shipped_at = p_shipped_at,
      purchase_price_per_bale = p_purchase_price_per_bale, note = nullif(btrim(p_note), '')
  where id = p_shipment_id;
  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '出庫元倉庫の在庫が不足しているため変更できません。';
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
