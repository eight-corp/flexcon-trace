begin;

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
      if v_grade is null or v_grade not in ('1等', '2等', '3等', '合格', '未検査') then
        raise exception '銘柄米の等級を選択してください。';
      end if;
      if (v_product = '飼料用玄米' and v_grade not in ('合格', '未検査'))
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

notify pgrst, 'reload schema';
commit;
