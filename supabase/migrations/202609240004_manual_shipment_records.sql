begin;

alter table public.flexcon_shipments drop constraint if exists flexcon_shipments_shipment_kind_check;
alter table public.flexcon_shipments add constraint flexcon_shipments_shipment_kind_check
  check (shipment_kind in ('qr_flexcon', 'paper_bag', 'other_rice', 'manual_record'));

alter table public.flexcon_manual_shipment_items
  add column if not exists unit text not null default '本'
  check (unit in ('本', '袋', 'kg'));

update public.flexcon_manual_shipment_items as item
set unit = '袋'
from public.flexcon_shipments as shipment
where shipment.id = item.shipment_id and shipment.shipment_kind = 'paper_bag' and item.unit <> '袋';

drop index if exists public.flexcon_manual_shipment_items_result_idx;
create unique index flexcon_manual_shipment_items_result_unit_idx
  on public.flexcon_manual_shipment_items (
    shipment_id, coalesce(origin_prefecture, ''), lower(btrim(product_name)),
    coalesce(grade, ''), coalesce(moisture, -1), coalesce(reason, ''), unit
  );

create or replace function public.flexcon_replace_record_items(
  p_shipment_id uuid, p_items jsonb, p_require_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_origin text;
  v_product text;
  v_grade text;
  v_unit text;
  v_brand boolean;
  v_key text;
  v_seen text[] := array[]::text[];
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception '出荷明細を1件以上追加してください。';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_origin := nullif(btrim(v_item->>'origin_prefecture'), '');
    v_product := nullif(btrim(v_item->>'product_name'), '');
    v_grade := nullif(btrim(v_item->>'grade'), '');
    v_unit := nullif(btrim(v_item->>'unit'), '');
    if v_origin is null or v_origin not in ('青森県', '岩手県') then raise exception '産地を選択してください。'; end if;
    if v_product is null then raise exception '種類を選択してください。'; end if;
    if v_unit is null or v_unit not in ('本', '袋', 'kg') then raise exception '単位を選択してください。'; end if;
    if coalesce(v_item->>'quantity_count', '') !~ '^[1-9][0-9]*$' then
      raise exception '数量は1以上の整数で入力してください。';
    end if;

    select exists (
      select 1 from public.flexcon_inspection_options as option_item
      where option_item.name = v_product
        and option_item.option_type in ('brand', case when v_origin = '青森県' then 'brand_aomori' else 'brand_iwate' end)
        and (not p_require_active or option_item.active)
    ) into v_brand;
    if not v_brand and not exists (
      select 1 from public.flexcon_inspection_options as option_item
      where option_item.name = v_product and option_item.option_type = 'shipment_product'
        and (not p_require_active or option_item.active)
    ) then raise exception '選択された種類は利用できません。'; end if;

    if v_brand then
      if v_grade is null or v_grade not in ('1等', '2等', '3等', '合格') then raise exception '銘柄米の等級を選択してください。'; end if;
      if (v_product = '飼料用玄米' and v_grade <> '合格')
        or (v_product <> '飼料用玄米' and v_grade = '合格') then
        raise exception '銘柄に対応する等級を選択してください。';
      end if;
      if not exists (
        select 1 from public.flexcon_inspection_options
        where option_type = 'grade' and name = v_grade and (not p_require_active or active)
      ) then raise exception '選択された等級は利用できません。'; end if;
    elsif v_grade is not null then
      raise exception '銘柄米以外に等級は入力できません。';
    end if;

    v_key := v_origin || chr(31) || lower(v_product) || chr(31) || coalesce(v_grade, '') || chr(31) || v_unit;
    if v_key = any(v_seen) then raise exception '同じ産地・種類・等級・単位が重複しています。'; end if;
    v_seen := array_append(v_seen, v_key);
  end loop;

  delete from public.flexcon_manual_shipment_items where shipment_id = p_shipment_id;
  insert into public.flexcon_manual_shipment_items (
    shipment_id, origin_prefecture, product_name, quantity_count, grade, unit, sort_order
  )
  select p_shipment_id, btrim(item.value->>'origin_prefecture'), btrim(item.value->>'product_name'),
    (item.value->>'quantity_count')::integer, nullif(btrim(item.value->>'grade'), ''),
    btrim(item.value->>'unit'), (item.ordinality - 1)::integer
  from jsonb_array_elements(p_items) with ordinality as item(value, ordinality);

  update public.flexcon_shipments as shipment
  set product_name = summary.product_names, quantity_count = summary.total_quantity,
      origin_prefecture = summary.single_origin
  from (
    select string_agg(item.product_name, '、' order by item.sort_order) as product_names,
      sum(item.quantity_count)::integer as total_quantity,
      case when count(distinct item.origin_prefecture) = 1 then min(item.origin_prefecture) else null end as single_origin
    from public.flexcon_manual_shipment_items as item where item.shipment_id = p_shipment_id
  ) as summary
  where shipment.id = p_shipment_id;
end;
$$;

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
  v_transport public.flexcon_transport_profiles%rowtype;
  v_id uuid;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if p_shipped_at is null then raise exception '出荷日時を入力してください。'; end if;
  if nullif(btrim(p_driver_name), '') is null then raise exception 'ドライバー名を入力してください。'; end if;
  if nullif(btrim(p_vehicle_no), '') is null then raise exception '車両番号を入力してください。'; end if;
  if p_purchase_price_per_bale < 0 then raise exception '仕入値は0以上で入力してください。'; end if;
  if not exists (select 1 from public.flexcon_destinations where id = p_destination_id and active) then
    raise exception '納品先を選択してください。';
  end if;
  select * into v_transport from public.flexcon_transport_profiles
  where id = p_transport_profile_id and active;
  if not found then raise exception '運送会社を選択してください。'; end if;
  if not exists (select 1 from public.flexcon_inspection_options
    where id = p_from_warehouse_id and option_type = 'warehouse') then
    raise exception '出庫元倉庫を選択してください。';
  end if;

  insert into public.flexcon_shipments (
    destination_id, shipped_at, contact_name, transport_profile_id, carrier_name,
    driver_name, vehicle_no, note, created_by_worker_id, shipment_kind,
    product_name, quantity_count, purchase_price_per_bale, inventory_from_warehouse_id
  ) values (
    p_destination_id, p_shipped_at, null, v_transport.id, v_transport.company_name,
    btrim(p_driver_name), btrim(p_vehicle_no), nullif(btrim(p_note), ''), v_worker.worker_id,
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
declare v_transport public.flexcon_transport_profiles%rowtype;
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  if not exists (select 1 from public.flexcon_shipments
    where id = p_shipment_id and shipment_kind = 'manual_record') then
    raise exception '出荷記録が見つかりません。';
  end if;
  if p_shipped_at is null then raise exception '出荷日時を入力してください。'; end if;
  if nullif(btrim(p_driver_name), '') is null then raise exception 'ドライバー名を入力してください。'; end if;
  if nullif(btrim(p_vehicle_no), '') is null then raise exception '車両番号を入力してください。'; end if;
  if p_purchase_price_per_bale < 0 then raise exception '仕入値は0以上で入力してください。'; end if;
  if not exists (select 1 from public.flexcon_destinations where id = p_destination_id and active) then
    raise exception '納品先を選択してください。';
  end if;
  select * into v_transport from public.flexcon_transport_profiles
  where id = p_transport_profile_id and active;
  if not found then raise exception '運送会社を選択してください。'; end if;

  perform public.flexcon_replace_record_items(p_shipment_id, p_items, false);
  update public.flexcon_shipments
  set destination_id = p_destination_id, transport_profile_id = v_transport.id,
      carrier_name = v_transport.company_name, shipped_at = p_shipped_at,
      driver_name = btrim(p_driver_name), vehicle_no = btrim(p_vehicle_no),
      purchase_price_per_bale = p_purchase_price_per_bale, note = nullif(btrim(p_note), '')
  where id = p_shipment_id;
  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '出庫元倉庫の在庫が不足しているため変更できません。';
  end if;
end;
$$;

revoke all on function public.flexcon_replace_record_items(uuid, jsonb, boolean) from public;
revoke all on function public.flexcon_register_inventory_record(text, uuid, uuid, timestamptz, text, text, jsonb, numeric, uuid, text) from public;
revoke all on function public.flexcon_update_inventory_record(text, uuid, uuid, uuid, timestamptz, text, text, jsonb, numeric, text) from public;
grant execute on function public.flexcon_register_inventory_record(text, uuid, uuid, timestamptz, text, text, jsonb, numeric, uuid, text) to anon, authenticated;
grant execute on function public.flexcon_update_inventory_record(text, uuid, uuid, uuid, timestamptz, text, text, jsonb, numeric, text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
