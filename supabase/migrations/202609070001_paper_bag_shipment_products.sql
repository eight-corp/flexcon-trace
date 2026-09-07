-- 紙袋出荷では、産地別銘柄に加えて「銘柄米以外の種類」も選択可能にします。
begin;

create or replace function public.flexcon_replace_manual_shipment_items(
  p_shipment_id uuid,
  p_shipment_kind text,
  p_items jsonb,
  p_require_active_options boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_order bigint;
  v_prefecture text;
  v_product_name text;
  v_quantity integer;
  v_option_types text[];
  v_key text;
  v_seen_keys text[] := array[]::text[];
begin
  if p_shipment_kind not in ('paper_bag', 'other_rice') then
    raise exception '出荷区分が正しくありません。';
  end if;
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception '種類と本数を1件以上追加してください。';
  end if;

  for v_item, v_order in
    select item.value, item.ordinality
    from jsonb_array_elements(p_items) with ordinality as item(value, ordinality)
  loop
    v_prefecture := nullif(btrim(v_item->>'origin_prefecture'), '');
    v_product_name := nullif(btrim(v_item->>'product_name'), '');

    if v_prefecture not in ('青森県', '岩手県') then
      raise exception '産地を選択してください。';
    end if;
    if coalesce(v_item->>'quantity_count', '') !~ '^[1-9][0-9]*$' then
      raise exception '本数は1以上の整数で入力してください。';
    end if;
    v_quantity := (v_item->>'quantity_count')::integer;
    if v_product_name is null then
      raise exception '種類を選択してください。';
    end if;

    if p_shipment_kind = 'paper_bag' then
      v_option_types := array[
        case when v_prefecture = '青森県' then 'brand_aomori' else 'brand_iwate' end,
        'shipment_product'
      ];
    else
      v_option_types := array['shipment_product'];
    end if;

    if not exists (
      select 1
      from public.flexcon_inspection_options as option_item
      where option_item.option_type = any(v_option_types)
        and option_item.name = v_product_name
        and (not p_require_active_options or option_item.active = true)
    ) and not (
      not p_require_active_options
      and exists (
        select 1
        from public.flexcon_manual_shipment_items as current_item
        where current_item.shipment_id = p_shipment_id
          and current_item.product_name = v_product_name
          and coalesce(current_item.origin_prefecture, '') = v_prefecture
      )
    ) then
      raise exception '選択された種類は利用できません。';
    end if;

    v_key := v_prefecture || chr(31) || lower(v_product_name);
    if v_key = any(v_seen_keys) then
      raise exception '同じ産地と種類が重複しています。';
    end if;
    v_seen_keys := array_append(v_seen_keys, v_key);
  end loop;

  delete from public.flexcon_manual_shipment_items
  where shipment_id = p_shipment_id;

  insert into public.flexcon_manual_shipment_items (
    shipment_id,
    origin_prefecture,
    product_name,
    quantity_count,
    sort_order
  )
  select
    p_shipment_id,
    nullif(btrim(item.value->>'origin_prefecture'), ''),
    btrim(item.value->>'product_name'),
    (item.value->>'quantity_count')::integer,
    (item.ordinality - 1)::integer
  from jsonb_array_elements(p_items) with ordinality as item(value, ordinality);

  update public.flexcon_shipments as shipment
  set product_name = summary.product_names,
      quantity_count = summary.total_quantity,
      origin_prefecture = summary.single_prefecture
  from (
    select
      string_agg(detail.product_name, '、' order by detail.sort_order, detail.id) as product_names,
      sum(detail.quantity_count)::integer as total_quantity,
      case when count(distinct detail.origin_prefecture) = 1
        then min(detail.origin_prefecture)
        else null
      end as single_prefecture
    from public.flexcon_manual_shipment_items as detail
    where detail.shipment_id = p_shipment_id
  ) as summary
  where shipment.id = p_shipment_id;
end;
$$;

revoke all on function public.flexcon_replace_manual_shipment_items(uuid, text, jsonb, boolean) from public;

commit;
