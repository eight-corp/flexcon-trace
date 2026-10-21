begin;

create or replace function public._flexcon_undo_impl_update_shipment_source(
  p_worker_id text, p_shipment_id uuid, p_from_warehouse_id uuid,
  p_destination_id uuid, p_transport_profile_id uuid, p_shipped_at timestamptz,
  p_driver_name text, p_vehicle_no text, p_items jsonb,
  p_purchase_price_per_bale numeric, p_note text
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_shipment public.flexcon_shipments%rowtype;
  v_negative_before jsonb;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  select * into v_shipment from public.flexcon_shipments where id = p_shipment_id for update;
  if not found then raise exception '出荷履歴が見つかりません。'; end if;
  if p_from_warehouse_id is null then
    if v_shipment.inventory_from_warehouse_id is not null then
      raise exception '出荷元（出庫元倉庫）を選択してください。';
    end if;
  elsif not exists (
    select 1 from public.flexcon_inspection_options where id = p_from_warehouse_id
      and option_type = 'warehouse' and (active or id = v_shipment.inventory_from_warehouse_id)
  ) then
    raise exception '選択された出荷元は利用できません。';
  end if;

  if v_shipment.shipment_kind = 'manual_record' then
    select coalesce(jsonb_agg(to_jsonb(balance)), '[]'::jsonb) into v_negative_before
      from public.flexcon_inventory_balances_by_crop_year balance where quantity < 0;
  end if;

  -- Set the source before validating the final items, in the same transaction.
  update public.flexcon_shipments set inventory_from_warehouse_id = p_from_warehouse_id
    where id = p_shipment_id and inventory_from_warehouse_id is distinct from p_from_warehouse_id;
  if v_shipment.shipment_kind = 'manual_record' then
    perform public.flexcon_update_inventory_record(p_worker_id,p_shipment_id,p_destination_id,p_transport_profile_id,
      p_shipped_at,p_driver_name,p_vehicle_no,p_items,p_purchase_price_per_bale,p_note);
  elsif v_shipment.shipment_kind = 'qr_flexcon' then
    perform public.flexcon_update_shipment(p_worker_id,p_shipment_id,p_destination_id,p_transport_profile_id,
      p_shipped_at,p_driver_name,p_vehicle_no,null::text,null::text,
      v_shipment.quantity_count,p_purchase_price_per_bale,p_note);
  else
    perform public.flexcon_update_manual_shipment(p_worker_id,p_shipment_id,p_destination_id,p_transport_profile_id,
      p_shipped_at,p_driver_name,p_vehicle_no,p_items,p_purchase_price_per_bale,p_note);
  end if;
  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '出庫元倉庫の在庫が不足しているため変更できません。';
  end if;
  -- Manual records store crop years directly; do not consume another year's stock.
  if v_shipment.shipment_kind = 'manual_record' and exists (
    select 1 from public.flexcon_inventory_balances_by_crop_year balance
    where quantity < 0 and quantity < coalesce((
      select (previous->>'quantity')::numeric from jsonb_array_elements(v_negative_before) previous
      where previous - 'quantity' = to_jsonb(balance) - 'quantity'
    ), 0)
  ) then raise exception '出庫元倉庫の産年別在庫が不足しているため変更できません。'; end if;
end; $$;
revoke all on function public._flexcon_undo_impl_update_shipment_source(text,uuid,uuid,uuid,uuid,timestamptz,text,text,jsonb,numeric,text) from public, anon, authenticated;

create or replace function public.flexcon_update_shipment_with_source(
  p_worker_id text, p_shipment_id uuid, p_from_warehouse_id uuid,
  p_destination_id uuid, p_transport_profile_id uuid, p_shipped_at timestamptz,
  p_driver_name text, p_vehicle_no text, p_items jsonb,
  p_purchase_price_per_bale numeric, p_note text
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_root boolean;
begin
  v_root := flexcon_undo_private.prepare(p_worker_id, 'flexcon_update_shipment_with_source', 'rice_shipping');
  perform public._flexcon_undo_impl_update_shipment_source(p_worker_id,p_shipment_id,p_from_warehouse_id,
    p_destination_id,p_transport_profile_id,p_shipped_at,p_driver_name,p_vehicle_no,p_items,p_purchase_price_per_bale,p_note);
  if v_root then perform flexcon_undo_private.finish(); end if;
end; $$;
revoke all on function public.flexcon_update_shipment_with_source(text,uuid,uuid,uuid,uuid,timestamptz,text,text,jsonb,numeric,text) from public;
grant execute on function public.flexcon_update_shipment_with_source(text,uuid,uuid,uuid,uuid,timestamptz,text,text,jsonb,numeric,text) to anon, authenticated;
insert into flexcon_undo_private.rpcs(function_name,argument_types,implementation_name,app_id)
  values ('flexcon_update_shipment_with_source','text, uuid, uuid, uuid, uuid, timestamp with time zone, text, text, jsonb, numeric, text','_flexcon_undo_impl_update_shipment_source','rice_shipping')
  on conflict(function_name,argument_types) do update set implementation_name=excluded.implementation_name, app_id=excluded.app_id;
notify pgrst, 'reload schema';
commit;
