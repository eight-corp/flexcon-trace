begin;

alter table public.flexcon_manual_shipment_items
  add column if not exists crop_year integer check (crop_year between 1900 and 2100);

drop index if exists public.flexcon_manual_shipment_items_result_unit_idx;
create unique index flexcon_manual_shipment_items_result_unit_idx
  on public.flexcon_manual_shipment_items (
    shipment_id, coalesce(crop_year, 0), coalesce(origin_prefecture, ''),
    lower(btrim(product_name)), coalesce(grade, ''), coalesce(moisture, -1),
    coalesce(reason, ''), unit
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
  v_crop_year_text text;
  v_crop_year integer;
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
    v_crop_year_text := nullif(btrim(v_item->>'crop_year'), '');
    if v_crop_year_text is null and p_require_active then raise exception '産年を入力してください。'; end if;
    if v_crop_year_text is not null then
      if v_crop_year_text !~ '^[0-9]{4}$' or v_crop_year_text::integer not between 1900 and 2100 then
        raise exception '産年を確認してください。';
      end if;
      v_crop_year := v_crop_year_text::integer;
    else
      v_crop_year := null;
    end if;
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

    v_key := coalesce(v_crop_year::text, '') || chr(31) || v_origin || chr(31)
      || lower(v_product) || chr(31) || coalesce(v_grade, '') || chr(31) || v_unit;
    if v_key = any(v_seen) then raise exception '同じ産年・産地・種類・等級・単位が重複しています。'; end if;
    v_seen := array_append(v_seen, v_key);
  end loop;

  delete from public.flexcon_manual_shipment_items where shipment_id = p_shipment_id;
  insert into public.flexcon_manual_shipment_items (
    shipment_id, crop_year, origin_prefecture, product_name, quantity_count, grade, unit, sort_order
  )
  select p_shipment_id, nullif(btrim(item.value->>'crop_year'), '')::integer,
    btrim(item.value->>'origin_prefecture'), btrim(item.value->>'product_name'),
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

create or replace view public.flexcon_inventory_ledger
with (security_invoker = true)
as
select base.id, base.registration_order, base.source_type, base.movement_type,
  base.movement_date, base.worker_name, base.producer_name,
  case when base.source_type = 'manual' then coalesce(movement.settlement_no, '') else base.settlement_no end as settlement_no,
  base.origin, base.product_name, base.grade, base.quantity, base.unit,
  base.from_warehouse_id, base.to_warehouse_id, base.movement_from,
  base.movement_to, base.created_at, base.purchase_price,
  coalesce(movement.crop_year, line.crop_year) as crop_year,
  movement.note
from public.flexcon_inventory_ledger_base as base
left join public.flexcon_inventory_movements as movement
  on base.source_type = 'manual' and base.id = movement.id::text
left join public.flexcon_purchase_statement_lines as line
  on base.source_type = 'settlement' and base.id = line.id::text
union all
select 'shipment-record:' || item.id::text, null::bigint, 'shipment_record', 'outbound',
  shipment.shipped_at::date, coalesce(worker.worker_name, '登録者不明'), ''::text, ''::text,
  item.origin_prefecture, item.product_name,
  coalesce(nullif(btrim(item.grade), ''), '対象外'), item.quantity_count::numeric, item.unit,
  shipment.inventory_from_warehouse_id, null::uuid, coalesce(warehouse.name, '倉庫未設定'), destination.name,
  shipment.created_at, shipment.purchase_price_per_bale, item.crop_year, null::text
from public.flexcon_shipments as shipment
join public.flexcon_manual_shipment_items as item on item.shipment_id = shipment.id
left join public.flexcon_destinations as destination on destination.id = shipment.destination_id
left join public.workers as worker on worker.worker_id = shipment.created_by_worker_id
left join public.flexcon_inspection_options as warehouse on warehouse.id = shipment.inventory_from_warehouse_id
where shipment.shipment_kind = 'manual_record' and shipment.inventory_from_warehouse_id is not null;

notify pgrst, 'reload schema';
commit;
