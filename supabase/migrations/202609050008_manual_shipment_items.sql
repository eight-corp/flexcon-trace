-- 紙袋・銘柄米以外の出荷1件に、種類別の数量明細を複数保存します。
begin;

create table if not exists public.flexcon_manual_shipment_items (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.flexcon_shipments(id) on delete cascade,
  origin_prefecture text,
  product_name text not null check (nullif(btrim(product_name), '') is not null),
  quantity_count integer not null check (quantity_count > 0),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists flexcon_manual_shipment_items_shipment_idx
  on public.flexcon_manual_shipment_items (shipment_id, sort_order, created_at);

create unique index if not exists flexcon_manual_shipment_items_product_idx
  on public.flexcon_manual_shipment_items (
    shipment_id,
    coalesce(origin_prefecture, ''),
    lower(btrim(product_name))
  );

alter table public.flexcon_manual_shipment_items enable row level security;

drop policy if exists flexcon_read_manual_shipment_items
  on public.flexcon_manual_shipment_items;
create policy flexcon_read_manual_shipment_items
  on public.flexcon_manual_shipment_items
  for select to anon, authenticated using (true);

grant select on public.flexcon_manual_shipment_items to anon, authenticated;

insert into public.flexcon_manual_shipment_items (
  shipment_id,
  origin_prefecture,
  product_name,
  quantity_count,
  sort_order
)
select
  shipment.id,
  case when shipment.shipment_kind = 'paper_bag' then shipment.origin_prefecture else null end,
  coalesce(nullif(btrim(shipment.product_name), ''), '品名未登録'),
  shipment.quantity_count,
  0
from public.flexcon_shipments as shipment
where shipment.shipment_kind in ('paper_bag', 'other_rice')
  and shipment.quantity_count is not null
  and shipment.quantity_count > 0
  and not exists (
    select 1
    from public.flexcon_manual_shipment_items as detail
    where detail.shipment_id = shipment.id
  )
on conflict do nothing;

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

    if coalesce(v_item->>'quantity_count', '') !~ '^[1-9][0-9]*$' then
      raise exception '本数は1以上の整数で入力してください。';
    end if;
    v_quantity := (v_item->>'quantity_count')::integer;
    if v_product_name is null then
      raise exception '種類を選択してください。';
    end if;

    if p_shipment_kind = 'paper_bag' then
      if v_prefecture not in ('青森県', '岩手県') then
        raise exception '県名を選択してください。';
      end if;
      v_option_type := case
        when v_prefecture = '青森県' then 'brand_aomori'
        else 'brand_iwate'
      end;
    else
      v_prefecture := null;
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
          and coalesce(current_item.origin_prefecture, '') = coalesce(v_prefecture, '')
      )
    ) then
      raise exception '選択された種類は利用できません。';
    end if;

    v_key := coalesce(v_prefecture, '') || chr(31) || lower(v_product_name);
    if v_key = any(v_seen_keys) then
      raise exception '同じ種類が重複しています。';
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
    case when p_shipment_kind = 'paper_bag'
      then nullif(btrim(item.value->>'origin_prefecture'), '')
      else null
    end,
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

create or replace function public.flexcon_register_manual_shipment(
  p_worker_id text,
  p_destination_id uuid,
  p_transport_profile_id uuid,
  p_shipped_at timestamptz,
  p_driver_name text,
  p_vehicle_no text,
  p_shipment_kind text,
  p_items jsonb,
  p_purchase_price_per_bale numeric,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first_item jsonb;
  v_shipment_id uuid;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception '種類と本数を1件以上追加してください。';
  end if;
  v_first_item := p_items->0;

  v_shipment_id := public.flexcon_register_manual_shipment(
    p_worker_id,
    p_destination_id,
    p_transport_profile_id,
    p_shipped_at,
    p_driver_name,
    p_vehicle_no,
    p_shipment_kind,
    case when p_shipment_kind = 'paper_bag' then v_first_item->>'origin_prefecture' else null end,
    v_first_item->>'product_name',
    (v_first_item->>'quantity_count')::integer,
    p_purchase_price_per_bale,
    p_note
  );

  perform public.flexcon_replace_manual_shipment_items(
    v_shipment_id,
    p_shipment_kind,
    p_items,
    true
  );

  return v_shipment_id;
end;
$$;

create or replace function public.flexcon_update_manual_shipment(
  p_worker_id text,
  p_shipment_id uuid,
  p_destination_id uuid,
  p_transport_profile_id uuid,
  p_shipped_at timestamptz,
  p_driver_name text,
  p_vehicle_no text,
  p_items jsonb,
  p_purchase_price_per_bale numeric,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shipment public.flexcon_shipments%rowtype;
begin
  perform public.flexcon_require_admin_worker(p_worker_id);

  select * into v_shipment
  from public.flexcon_shipments
  where id = p_shipment_id;
  if not found then raise exception '出荷履歴が見つかりません。'; end if;
  if v_shipment.shipment_kind not in ('paper_bag', 'other_rice') then
    raise exception 'この出荷では種類別明細を編集できません。';
  end if;

  perform public.flexcon_replace_manual_shipment_items(
    p_shipment_id,
    v_shipment.shipment_kind,
    p_items,
    false
  );

  select * into v_shipment
  from public.flexcon_shipments
  where id = p_shipment_id;

  perform public.flexcon_update_shipment(
    p_worker_id,
    p_shipment_id,
    p_destination_id,
    p_transport_profile_id,
    p_shipped_at,
    p_driver_name,
    p_vehicle_no,
    v_shipment.origin_prefecture,
    v_shipment.product_name,
    v_shipment.quantity_count,
    p_purchase_price_per_bale,
    p_note
  );
end;
$$;

revoke all on function public.flexcon_replace_manual_shipment_items(uuid, text, jsonb, boolean) from public;
revoke all on function public.flexcon_register_manual_shipment(text, uuid, uuid, timestamptz, text, text, text, jsonb, numeric, text) from public;
revoke all on function public.flexcon_update_manual_shipment(text, uuid, uuid, uuid, timestamptz, text, text, jsonb, numeric, text) from public;

grant execute on function public.flexcon_register_manual_shipment(text, uuid, uuid, timestamptz, text, text, text, jsonb, numeric, text)
  to anon, authenticated;
grant execute on function public.flexcon_update_manual_shipment(text, uuid, uuid, uuid, timestamptz, text, text, jsonb, numeric, text)
  to anon, authenticated;

commit;
