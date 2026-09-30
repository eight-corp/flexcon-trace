begin;

create or replace function public.flexcon_update_shipment(
  p_worker_id text, p_shipment_id uuid, p_destination_id uuid, p_transport_profile_id uuid,
  p_shipped_at timestamptz, p_driver_name text, p_vehicle_no text, p_product_name text,
  p_quantity_count integer, p_purchase_price_per_bale numeric, p_note text default null
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
  v_shipment public.flexcon_shipments%rowtype;
  v_product_name text;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  v_driver_name := nullif(btrim(p_driver_name), '');
  v_vehicle_no := nullif(btrim(p_vehicle_no), '');
  v_product_name := nullif(btrim(p_product_name), '');

  select * into v_shipment
  from public.flexcon_shipments
  where id = p_shipment_id
  for update;
  if not found then raise exception '出荷履歴が見つかりません。'; end if;

  if p_shipped_at is null then raise exception '出荷日時を入力してください。'; end if;
  if v_driver_name is null then raise exception 'ドライバー名を入力してください。'; end if;
  if v_vehicle_no is null then raise exception '車両番号を入力してください。'; end if;
  if p_purchase_price_per_bale is not null and p_purchase_price_per_bale < 0 then
    raise exception '仕入値は0以上で入力してください。';
  end if;
  if v_shipment.shipment_kind <> 'qr_flexcon'
     and (p_quantity_count is null or p_quantity_count < 1) then
    raise exception '数量を1以上で入力してください。';
  end if;
  if v_shipment.shipment_kind = 'paper_bag' then
    v_product_name := '紙袋';
  elsif v_shipment.shipment_kind = 'other_rice' and v_product_name is null then
    raise exception '種類を入力してください。';
  elsif v_shipment.shipment_kind = 'other_rice'
        and v_product_name is distinct from v_shipment.product_name
        and not exists (
          select 1 from public.flexcon_inspection_options
          where option_type = 'shipment_product' and name = v_product_name and active = true
        ) then
    raise exception '選択された種類は利用できません。';
  end if;
  if not exists (
    select 1 from public.flexcon_destinations where id = p_destination_id and active = true
  ) then
    raise exception '選択された納品先は利用できません。';
  end if;

  select * into v_transport
  from public.flexcon_transport_profiles
  where id = p_transport_profile_id and active = true;
  if not found then raise exception '選択された運送会社は利用できません。'; end if;

  update public.flexcon_shipments
  set destination_id = p_destination_id,
      transport_profile_id = v_transport.id,
      shipped_at = p_shipped_at,
      carrier_name = v_transport.company_name,
      driver_name = v_driver_name,
      vehicle_no = v_vehicle_no,
      product_name = case when v_shipment.shipment_kind = 'qr_flexcon' then null else v_product_name end,
      quantity_count = case when v_shipment.shipment_kind = 'qr_flexcon' then v_shipment.quantity_count else p_quantity_count end,
      purchase_price_per_bale = p_purchase_price_per_bale,
      note = nullif(btrim(p_note), '')
  where id = p_shipment_id;
  if not found then raise exception '出荷履歴が見つかりません。'; end if;

  update public.flexcon_scan_events
  set destination_id = p_destination_id
  where shipment_id = p_shipment_id;
end;
$$;

create or replace function public.flexcon_update_shipment(
  p_worker_id text, p_shipment_id uuid, p_destination_id uuid, p_transport_profile_id uuid,
  p_shipped_at timestamptz, p_driver_name text, p_vehicle_no text, p_origin_prefecture text,
  p_product_name text, p_quantity_count integer, p_purchase_price_per_bale numeric, p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shipment public.flexcon_shipments%rowtype;
  v_prefecture text := nullif(btrim(p_origin_prefecture), '');
  v_product_name text := nullif(btrim(p_product_name), '');
  v_option_type text;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select * into v_shipment from public.flexcon_shipments where id = p_shipment_id;
  if not found then raise exception '出荷履歴が見つかりません。'; end if;

  if v_shipment.shipment_kind = 'paper_bag' then
    if v_prefecture not in ('青森県', '岩手県') then
      raise exception '県名を選択してください。';
    end if;
    v_option_type := case when v_prefecture = '青森県' then 'brand_aomori' else 'brand_iwate' end;
    if v_product_name is null
       or (
         v_product_name is distinct from v_shipment.product_name
         and not exists (
           select 1 from public.flexcon_inspection_options
           where option_type = v_option_type and name = v_product_name and active = true
         )
       ) then
      raise exception '選択された県の銘柄は利用できません。';
    end if;
  elsif v_shipment.shipment_kind <> 'other_rice' then
    v_prefecture := null;
    v_product_name := null;
  end if;

  perform public.flexcon_update_shipment(
    p_worker_id, p_shipment_id, p_destination_id, p_transport_profile_id,
    p_shipped_at, p_driver_name, p_vehicle_no, p_product_name, p_quantity_count,
    p_purchase_price_per_bale, p_note
  );

  update public.flexcon_shipments
  set origin_prefecture = v_prefecture,
      product_name = case
        when shipment_kind = 'qr_flexcon' then (
          select string_agg(names.product_name, '、' order by names.product_name)
          from (
            select coalesce(nullif(btrim(item.product_name), ''), '品名未登録') as product_name
            from public.flexcon_shipment_items as item
            where item.shipment_id = p_shipment_id
            group by coalesce(nullif(btrim(item.product_name), ''), '品名未登録')
          ) as names
        )
        else v_product_name
      end
  where id = p_shipment_id;
end;
$$;

create or replace function public.flexcon_update_manual_shipment(
  p_worker_id text, p_shipment_id uuid, p_destination_id uuid, p_transport_profile_id uuid,
  p_shipped_at timestamptz, p_driver_name text, p_vehicle_no text, p_items jsonb,
  p_purchase_price_per_bale numeric, p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shipment public.flexcon_shipments%rowtype;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select * into v_shipment from public.flexcon_shipments where id = p_shipment_id;
  if not found then raise exception '出荷履歴が見つかりません。'; end if;
  if v_shipment.shipment_kind not in ('paper_bag', 'other_rice') then
    raise exception 'この出荷では種類別明細を編集できません。';
  end if;

  perform public.flexcon_replace_manual_shipment_items(
    p_shipment_id, v_shipment.shipment_kind, p_items, false
  );

  select * into v_shipment from public.flexcon_shipments where id = p_shipment_id;
  perform public.flexcon_update_shipment(
    p_worker_id, p_shipment_id, p_destination_id, p_transport_profile_id,
    p_shipped_at, p_driver_name, p_vehicle_no, v_shipment.origin_prefecture,
    v_shipment.product_name, v_shipment.quantity_count, p_purchase_price_per_bale, p_note
  );
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
declare
  v_carrier_name text;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  if not exists (
    select 1 from public.flexcon_shipments where id = p_shipment_id and shipment_kind = 'manual_record'
  ) then raise exception '出荷記録が見つかりません。'; end if;
  if p_shipped_at is null then raise exception '出荷日時を入力してください。'; end if;
  if p_purchase_price_per_bale < 0 then raise exception '仕入値は0以上で入力してください。'; end if;
  if p_destination_id is not null and not exists (
    select 1 from public.flexcon_destinations where id = p_destination_id and active
  ) then raise exception '選択された納品先は利用できません。'; end if;
  if p_transport_profile_id is not null then
    select company_name into v_carrier_name from public.flexcon_transport_profiles
    where id = p_transport_profile_id and active;
    if not found then raise exception '選択された運送会社は利用できません。'; end if;
  end if;

  perform public.flexcon_replace_record_items(p_shipment_id, p_items, false);
  update public.flexcon_shipments
  set destination_id = p_destination_id, transport_profile_id = p_transport_profile_id,
      carrier_name = v_carrier_name, driver_name = nullif(btrim(p_driver_name), ''),
      vehicle_no = nullif(btrim(p_vehicle_no), ''), shipped_at = p_shipped_at,
      purchase_price_per_bale = p_purchase_price_per_bale, note = nullif(btrim(p_note), '')
  where id = p_shipment_id;
  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '出庫元倉庫の在庫が不足しているため変更できません。';
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
