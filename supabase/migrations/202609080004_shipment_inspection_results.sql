-- 出荷明細に検査結果を保存し、QRフレコンはロット番号から自動取得します。
begin;

alter table public.flexcon_shipment_items
  add column if not exists grade text,
  add column if not exists moisture numeric(4, 1)
    check (moisture is null or moisture between 0 and 100),
  add column if not exists reason text;

alter table public.flexcon_manual_shipment_items
  add column if not exists grade text,
  add column if not exists moisture numeric(4, 1)
    check (moisture is null or moisture between 0 and 100),
  add column if not exists reason text;

drop index if exists public.flexcon_manual_shipment_items_product_idx;
create unique index if not exists flexcon_manual_shipment_items_result_idx
  on public.flexcon_manual_shipment_items (
    shipment_id,
    coalesce(origin_prefecture, ''),
    lower(btrim(product_name)),
    coalesce(grade, ''),
    coalesce(moisture, -1),
    coalesce(reason, '')
  );

create or replace function public.flexcon_inspection_result_for_lot(p_lot_number text)
returns table(result_grade text, result_moisture numeric, result_reason text)
language sql
stable
security definer
set search_path = public
as $$
  select result.grade, result.moisture, result.reason
  from (
    select
      nullif(btrim(flexcon.grade), '') as grade,
      flexcon.moisture,
      nullif(btrim(flexcon.reason), '') as reason,
      case when flexcon.lot_number = p_lot_number then 0 else 1 end as priority,
      flexcon.updated_at
    from public.flexcon_inspection_flexcons as flexcon
    where flexcon.lot_number = p_lot_number
       or (char_length(flexcon.lot_number) = 11 and substring(flexcon.lot_number from 5) = p_lot_number)
       or (char_length(flexcon.lot_number) = 11 and ltrim(substring(flexcon.lot_number from 5), '0') = p_lot_number)
       or (char_length(p_lot_number) = 11 and substring(p_lot_number from 5) = flexcon.lot_number)
       or (char_length(p_lot_number) = 11 and ltrim(substring(p_lot_number from 5), '0') = flexcon.lot_number)
    union all
    select
      nullif(btrim(mixed.grade), ''),
      mixed.moisture,
      nullif(btrim(mixed.reason), ''),
      0,
      mixed.updated_at
    from public.flexcon_mixed_flexcons as mixed
    where mixed.lot_number = p_lot_number
  ) as result
  order by result.priority, result.updated_at desc
  limit 1;
$$;

create or replace function public.flexcon_assign_shipment_item_inspection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result record;
begin
  select * into v_result
  from public.flexcon_inspection_result_for_lot(new.lot_number);

  if found then
    new.grade := v_result.result_grade;
    new.moisture := v_result.result_moisture;
    new.reason := v_result.result_reason;
  end if;
  return new;
end;
$$;

drop trigger if exists flexcon_assign_shipment_item_inspection
  on public.flexcon_shipment_items;
create trigger flexcon_assign_shipment_item_inspection
before insert on public.flexcon_shipment_items
for each row execute function public.flexcon_assign_shipment_item_inspection();

update public.flexcon_shipment_items as item
set grade = (
      select result.result_grade
      from public.flexcon_inspection_result_for_lot(item.lot_number) as result
    ),
    moisture = (
      select result.result_moisture
      from public.flexcon_inspection_result_for_lot(item.lot_number) as result
    ),
    reason = (
      select result.result_reason
      from public.flexcon_inspection_result_for_lot(item.lot_number) as result
    )
where item.grade is null
   or item.moisture is null;

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
  v_option_type text;
  v_grade text;
  v_reason text;
  v_moisture numeric;
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
      v_option_type := case when v_prefecture = '青森県' then 'brand_aomori' else 'brand_iwate' end;
      v_grade := nullif(btrim(v_item->>'grade'), '');
      v_reason := nullif(btrim(v_item->>'reason'), '');
      if coalesce(v_item->>'moisture', '') !~ '^[0-9]+([.][0-9]+)?$' then
        raise exception '水分を入力してください。';
      end if;
      v_moisture := round((v_item->>'moisture')::numeric, 1);
      if v_moisture not between 0 and 100 then
        raise exception '水分は0から100の範囲で入力してください。';
      end if;
      if v_grade is null then raise exception '等級を選択してください。'; end if;
      if v_product_name = '飼料用玄米' and v_grade <> '合格' then
        raise exception '飼料用玄米の等級は合格を選択してください。';
      end if;
      if v_product_name <> '飼料用玄米' and v_grade = '合格' then
        raise exception '飼料用玄米以外では合格を選択できません。';
      end if;
      if v_grade in ('1等', '合格') then
        v_reason := null;
      elsif v_reason is null then
        raise exception '理由を選択してください。';
      end if;
    else
      v_option_type := 'shipment_product';
      v_grade := null;
      v_reason := null;
      v_moisture := null;
    end if;

    if not exists (
      select 1 from public.flexcon_inspection_options as option_item
      where option_item.option_type = v_option_type
        and option_item.name = v_product_name
        and (not p_require_active_options or option_item.active = true)
    ) and not (
      not p_require_active_options
      and exists (
        select 1 from public.flexcon_manual_shipment_items as current_item
        where current_item.shipment_id = p_shipment_id
          and current_item.product_name = v_product_name
          and coalesce(current_item.origin_prefecture, '') = v_prefecture
      )
    ) then
      raise exception '選択された種類は利用できません。';
    end if;

    if p_shipment_kind = 'paper_bag' and not exists (
      select 1 from public.flexcon_inspection_options as option_item
      where option_item.option_type = 'grade'
        and option_item.name = v_grade
        and (not p_require_active_options or option_item.active = true)
    ) then
      raise exception '選択された等級は利用できません。';
    end if;
    if p_shipment_kind = 'paper_bag' and v_reason is not null and not exists (
      select 1 from public.flexcon_inspection_options as option_item
      where option_item.option_type = 'grade_reason'
        and option_item.name = v_reason
        and (not p_require_active_options or option_item.active = true)
    ) then
      raise exception '選択された理由は利用できません。';
    end if;

    v_key := v_prefecture || chr(31) || lower(v_product_name) || chr(31)
      || coalesce(v_grade, '') || chr(31) || coalesce(v_moisture::text, '') || chr(31) || coalesce(v_reason, '');
    if v_key = any(v_seen_keys) then
      raise exception '同じ産地・種類・検査結果が重複しています。';
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
    grade,
    moisture,
    reason,
    sort_order
  )
  select
    p_shipment_id,
    nullif(btrim(item.value->>'origin_prefecture'), ''),
    btrim(item.value->>'product_name'),
    (item.value->>'quantity_count')::integer,
    case when p_shipment_kind = 'paper_bag' then nullif(btrim(item.value->>'grade'), '') else null end,
    case when p_shipment_kind = 'paper_bag' then round((item.value->>'moisture')::numeric, 1) else null end,
    case
      when p_shipment_kind = 'paper_bag' and nullif(btrim(item.value->>'grade'), '') not in ('1等', '合格')
        then nullif(btrim(item.value->>'reason'), '')
      else null
    end,
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

revoke all on function public.flexcon_inspection_result_for_lot(text) from public;
revoke all on function public.flexcon_assign_shipment_item_inspection() from public;
revoke all on function public.flexcon_replace_manual_shipment_items(uuid, text, jsonb, boolean) from public;

commit;
