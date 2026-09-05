-- 紙袋出荷の県名・銘柄と、QR出荷の銘柄別本数を保存します。
begin;

alter table public.flexcon_shipments
  add column if not exists origin_prefecture text;

alter table public.flexcon_shipment_items
  add column if not exists product_name text;

create or replace function public.flexcon_brand_for_lot(p_lot_number text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(flexcon.brand), ''), '品名未登録')
  from public.flexcon_inspection_flexcons as flexcon
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
  return new;
end;
$$;

drop trigger if exists flexcon_assign_shipment_item_product
  on public.flexcon_shipment_items;
create trigger flexcon_assign_shipment_item_product
before insert on public.flexcon_shipment_items
for each row execute function public.flexcon_assign_shipment_item_product();

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
      )
  where id = new.shipment_id
    and shipment_kind = 'qr_flexcon';
  return new;
end;
$$;

drop trigger if exists flexcon_refresh_shipment_product_summary
  on public.flexcon_shipment_items;
create trigger flexcon_refresh_shipment_product_summary
after insert or update of product_name on public.flexcon_shipment_items
for each row execute function public.flexcon_refresh_shipment_product_summary();

update public.flexcon_shipment_items as item
set product_name = coalesce(
  public.flexcon_brand_for_lot(item.lot_number),
  '品名未登録'
)
where nullif(btrim(item.product_name), '') is null;

update public.flexcon_shipments as shipment
set product_name = summary.product_name,
    quantity_count = summary.quantity_count
from (
  select
    item.shipment_id,
    string_agg(distinct coalesce(nullif(btrim(item.product_name), ''), '品名未登録'), '、') as product_name,
    count(*)::integer as quantity_count
  from public.flexcon_shipment_items as item
  group by item.shipment_id
) as summary
where shipment.id = summary.shipment_id
  and shipment.shipment_kind = 'qr_flexcon';

create or replace function public.flexcon_register_manual_shipment(
  p_worker_id text,
  p_destination_id uuid,
  p_transport_profile_id uuid,
  p_shipped_at timestamptz,
  p_driver_name text,
  p_vehicle_no text,
  p_shipment_kind text,
  p_origin_prefecture text,
  p_product_name text,
  p_quantity_count integer,
  p_purchase_price_per_bale numeric,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shipment_id uuid;
  v_prefecture text := nullif(btrim(p_origin_prefecture), '');
  v_product_name text := nullif(btrim(p_product_name), '');
  v_option_type text;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if p_shipment_kind = 'paper_bag' then
    if v_prefecture not in ('青森県', '岩手県') then
      raise exception '県名を選択してください。';
    end if;
    v_option_type := case
      when v_prefecture = '青森県' then 'brand_aomori'
      else 'brand_iwate'
    end;
    if v_product_name is null or not exists (
      select 1
      from public.flexcon_inspection_options
      where option_type = v_option_type
        and name = v_product_name
        and active = true
    ) then
      raise exception '選択された県の銘柄は利用できません。';
    end if;
  elsif p_shipment_kind = 'other_rice' then
    v_prefecture := null;
  else
    raise exception '出荷区分が正しくありません。';
  end if;

  v_shipment_id := public.flexcon_register_manual_shipment(
    p_worker_id,
    p_destination_id,
    p_transport_profile_id,
    p_shipped_at,
    p_driver_name,
    p_vehicle_no,
    p_shipment_kind,
    p_product_name,
    p_quantity_count,
    p_purchase_price_per_bale,
    p_note
  );

  update public.flexcon_shipments
  set origin_prefecture = v_prefecture,
      product_name = v_product_name
  where id = v_shipment_id;

  return v_shipment_id;
end;
$$;

create or replace function public.flexcon_update_shipment(
  p_worker_id text,
  p_shipment_id uuid,
  p_destination_id uuid,
  p_transport_profile_id uuid,
  p_shipped_at timestamptz,
  p_driver_name text,
  p_vehicle_no text,
  p_origin_prefecture text,
  p_product_name text,
  p_quantity_count integer,
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
  v_prefecture text := nullif(btrim(p_origin_prefecture), '');
  v_product_name text := nullif(btrim(p_product_name), '');
  v_option_type text;
begin
  perform public.flexcon_require_admin_worker(p_worker_id);

  select * into v_shipment
  from public.flexcon_shipments
  where id = p_shipment_id;

  if not found then raise exception '出荷履歴が見つかりません。'; end if;

  if v_shipment.shipment_kind = 'paper_bag' then
    if v_prefecture not in ('青森県', '岩手県') then
      raise exception '県名を選択してください。';
    end if;
    v_option_type := case
      when v_prefecture = '青森県' then 'brand_aomori'
      else 'brand_iwate'
    end;
    if v_product_name is null
       or (
         v_product_name is distinct from v_shipment.product_name
         and not exists (
           select 1
           from public.flexcon_inspection_options
           where option_type = v_option_type
             and name = v_product_name
             and active = true
         )
       ) then
      raise exception '選択された県の銘柄は利用できません。';
    end if;
  elsif v_shipment.shipment_kind <> 'other_rice' then
    v_prefecture := null;
    v_product_name := null;
  end if;

  perform public.flexcon_update_shipment(
    p_worker_id,
    p_shipment_id,
    p_destination_id,
    p_transport_profile_id,
    p_shipped_at,
    p_driver_name,
    p_vehicle_no,
    p_product_name,
    p_quantity_count,
    p_purchase_price_per_bale,
    p_note
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

revoke all on function public.flexcon_brand_for_lot(text) from public;
revoke all on function public.flexcon_assign_shipment_item_product() from public;
revoke all on function public.flexcon_refresh_shipment_product_summary() from public;
revoke all on function public.flexcon_register_manual_shipment(text, uuid, uuid, timestamptz, text, text, text, text, text, integer, numeric, text) from public;
revoke all on function public.flexcon_update_shipment(text, uuid, uuid, uuid, timestamptz, text, text, text, text, integer, numeric, text) from public;

grant execute on function public.flexcon_register_manual_shipment(text, uuid, uuid, timestamptz, text, text, text, text, text, integer, numeric, text)
  to anon, authenticated;
grant execute on function public.flexcon_update_shipment(text, uuid, uuid, uuid, timestamptz, text, text, text, text, integer, numeric, text)
  to anon, authenticated;

commit;
