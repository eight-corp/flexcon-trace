-- 銘柄米以外にも県名を保存し、QR出荷の県名を検査記録から補完します。
begin;

alter table public.flexcon_shipment_items
  add column if not exists origin_prefecture text;

create or replace function public.flexcon_origin_for_lot(p_lot_number text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(btrim(auth_record.prefecture), '')
  from public.flexcon_inspection_flexcons as flexcon
  join public.flexcon_authorizations as auth_record
    on auth_record.id = flexcon.authorization_id
  where flexcon.lot_number = p_lot_number
     or (
       char_length(flexcon.lot_number) = 11
       and substring(flexcon.lot_number from 5) = p_lot_number
     )
     or (
       char_length(flexcon.lot_number) = 11
       and ltrim(substring(flexcon.lot_number from 5), '0') = p_lot_number
     )
     or (
       char_length(p_lot_number) = 11
       and substring(p_lot_number from 5) = flexcon.lot_number
     )
     or (
       char_length(p_lot_number) = 11
       and ltrim(substring(p_lot_number from 5), '0') = flexcon.lot_number
     )
  order by
    case when flexcon.lot_number = p_lot_number then 0 else 1 end,
    flexcon.updated_at desc,
    flexcon.id
  limit 1;
$$;

create or replace function public.flexcon_assign_shipment_item_product()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if nullif(btrim(new.product_name), '') is null then
    new.product_name := coalesce(
      public.flexcon_brand_for_lot(new.lot_number),
      '品名未登録'
    );
  end if;
  if nullif(btrim(new.origin_prefecture), '') is null then
    new.origin_prefecture := public.flexcon_origin_for_lot(new.lot_number);
  end if;
  return new;
end;
$$;

create or replace function public.flexcon_refresh_shipment_product_summary()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.flexcon_shipments
  set product_name = (
        select string_agg(names.product_name, '、' order by names.product_name)
        from (
          select coalesce(nullif(btrim(item.product_name), ''), '品名未登録') as product_name
          from public.flexcon_shipment_items as item
          where item.shipment_id = new.shipment_id
          group by coalesce(nullif(btrim(item.product_name), ''), '品名未登録')
        ) as names
      ),
      quantity_count = (
        select count(*)::integer
        from public.flexcon_shipment_items as item
        where item.shipment_id = new.shipment_id
      ),
      origin_prefecture = (
        select case when count(distinct nullif(btrim(item.origin_prefecture), '')) = 1
          then min(nullif(btrim(item.origin_prefecture), ''))
          else null
        end
        from public.flexcon_shipment_items as item
        where item.shipment_id = new.shipment_id
      )
  where id = new.shipment_id
    and shipment_kind = 'qr_flexcon';
  return new;
end;
$$;

update public.flexcon_shipment_items as item
set origin_prefecture = public.flexcon_origin_for_lot(item.lot_number)
where nullif(btrim(item.origin_prefecture), '') is null;

update public.flexcon_shipments as shipment
set origin_prefecture = summary.single_prefecture
from (
  select
    item.shipment_id,
    case when count(distinct nullif(btrim(item.origin_prefecture), '')) = 1
      then min(nullif(btrim(item.origin_prefecture), ''))
      else null
    end as single_prefecture
  from public.flexcon_shipment_items as item
  group by item.shipment_id
) as summary
where shipment.id = summary.shipment_id
  and shipment.shipment_kind = 'qr_flexcon';

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
      raise exception '県名を選択してください。';
    end if;
    if coalesce(v_item->>'quantity_count', '') !~ '^[1-9][0-9]*$' then
      raise exception '本数は1以上の整数で入力してください。';
    end if;
    v_quantity := (v_item->>'quantity_count')::integer;
    if v_product_name is null then
      raise exception '種類を選択してください。';
    end if;

    if p_shipment_kind = 'paper_bag' then
      v_option_type := case
        when v_prefecture = '青森県' then 'brand_aomori'
        else 'brand_iwate'
      end;
    else
      v_option_type := 'shipment_product';
    end if;

    if not exists (
      select 1
      from public.flexcon_inspection_options as option_item
      where option_item.option_type = v_option_type
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
      raise exception '同じ県名と種類が重複しています。';
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

revoke all on function public.flexcon_origin_for_lot(text) from public;
revoke all on function public.flexcon_replace_manual_shipment_items(uuid, text, jsonb, boolean) from public;

commit;
