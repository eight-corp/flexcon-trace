-- 仕入値、紙袋出荷、QRなしフレコン出荷、銘柄米以外の種類マスタを追加します。
begin;

alter table public.flexcon_shipments
  add column if not exists shipment_kind text not null default 'qr_flexcon',
  add column if not exists product_name text,
  add column if not exists quantity_count integer,
  add column if not exists purchase_price_per_bale numeric(12, 2);

alter table public.flexcon_shipments
  drop constraint if exists flexcon_shipments_shipment_kind_check;
alter table public.flexcon_shipments
  add constraint flexcon_shipments_shipment_kind_check
  check (shipment_kind in ('qr_flexcon', 'paper_bag', 'other_rice'));

alter table public.flexcon_shipments
  drop constraint if exists flexcon_shipments_quantity_count_check;
alter table public.flexcon_shipments
  add constraint flexcon_shipments_quantity_count_check
  check (quantity_count is null or quantity_count > 0);

alter table public.flexcon_shipments
  drop constraint if exists flexcon_shipments_purchase_price_check;
alter table public.flexcon_shipments
  add constraint flexcon_shipments_purchase_price_check
  check (purchase_price_per_bale is null or purchase_price_per_bale >= 0);

update public.flexcon_shipments as shipment
set quantity_count = (
  select count(*)::integer
  from public.flexcon_shipment_items as item
  where item.shipment_id = shipment.id
)
where shipment.shipment_kind = 'qr_flexcon'
  and shipment.quantity_count is null;

alter table public.flexcon_inspection_options
  drop constraint if exists flexcon_inspection_options_option_type_check;
alter table public.flexcon_inspection_options
  add constraint flexcon_inspection_options_option_type_check
  check (
    option_type in (
      'location',
      'brand_aomori',
      'brand_iwate',
      'grade',
      'grade_reason',
      'shipment_product'
    )
  );

insert into public.flexcon_inspection_options (option_type, name, sort_order)
values
  ('shipment_product', '中米1.8上', 10),
  ('shipment_product', '中米1.75上', 20),
  ('shipment_product', 'くず米1.75下', 30),
  ('shipment_product', 'くず米1.8下', 40),
  ('shipment_product', '中米はじき1.75上', 50),
  ('shipment_product', '中米はじき1.8上', 60),
  ('shipment_product', '色選はじき', 70),
  ('shipment_product', '雑米', 80)
on conflict (option_type, name) do nothing;

create or replace function public.flexcon_save_inspection_option(
  p_worker_id text,
  p_option_id uuid,
  p_option_type text,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_id uuid;
  v_name text;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_name := btrim(coalesce(p_name, ''));

  if p_option_type not in (
    'location',
    'brand_aomori',
    'brand_iwate',
    'grade',
    'grade_reason',
    'shipment_product'
  ) then
    raise exception 'マスタ項目の種類が正しくありません。';
  end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception '名称を1文字から120文字で入力してください。';
  end if;
  if exists (
    select 1
    from public.flexcon_inspection_options as inspection_option
    where inspection_option.option_type = p_option_type
      and lower(btrim(inspection_option.name)) = lower(v_name)
      and (p_option_id is null or inspection_option.id <> p_option_id)
  ) then
    raise exception '同じ名称がすでに登録されています。';
  end if;

  if p_option_id is null then
    insert into public.flexcon_inspection_options (
      option_type, name, created_by_worker_id, updated_by_worker_id
    ) values (
      p_option_type, v_name, v_worker.worker_id, v_worker.worker_id
    ) returning id into v_id;
  else
    update public.flexcon_inspection_options
    set name = v_name,
        updated_by_worker_id = v_worker.worker_id,
        updated_at = now()
    where id = p_option_id
      and option_type = p_option_type
    returning id into v_id;

    if v_id is null then
      raise exception 'マスタ項目が見つかりません。';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.flexcon_register_shipment(
  p_worker_id text,
  p_destination_id uuid,
  p_transport_profile_id uuid,
  p_shipped_at timestamptz,
  p_driver_name text,
  p_vehicle_no text,
  p_lot_numbers text[],
  p_purchase_price_per_bale numeric,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_transport public.flexcon_transport_profiles%rowtype;
  v_shipment_id uuid;
  v_count integer;
  v_driver_name text;
  v_vehicle_no text;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_count := coalesce(array_length(p_lot_numbers, 1), 0);
  v_driver_name := nullif(btrim(p_driver_name), '');
  v_vehicle_no := nullif(btrim(p_vehicle_no), '');

  if p_shipped_at is null then raise exception '出荷日時を入力してください。'; end if;
  if v_driver_name is null then raise exception 'ドライバー名を入力してください。'; end if;
  if v_vehicle_no is null then raise exception '車両番号を入力してください。'; end if;
  if p_purchase_price_per_bale is not null and p_purchase_price_per_bale < 0 then
    raise exception '仕入値は0以上で入力してください。';
  end if;
  if v_count < 1 or v_count > 24 then
    raise exception '一度に登録できる本数は1本から24本です。';
  end if;
  if exists (
    select 1 from unnest(p_lot_numbers) as lot
    where lot !~ '^([0-9]{6}|[0-9]{7}|[0-9]{11})$'
  ) then
    raise exception 'ロット番号の桁数が正しくありません。';
  end if;
  if (select count(distinct lot) from unnest(p_lot_numbers) as lot) <> v_count then
    raise exception '同じロット番号が重複しています。';
  end if;
  if not exists (
    select 1 from public.flexcon_destinations
    where id = p_destination_id and active = true
  ) then
    raise exception '選択された納品先は利用できません。';
  end if;

  select * into v_transport
  from public.flexcon_transport_profiles
  where id = p_transport_profile_id and active = true;
  if not found then raise exception '選択された運送会社は利用できません。'; end if;

  insert into public.flexcon_flexcons (lot_number)
  select lot from unnest(p_lot_numbers) as lot
  on conflict (lot_number) do nothing;

  perform 1
  from public.flexcon_flexcons
  where lot_number = any(p_lot_numbers)
  for update;

  if exists (
    select 1 from public.flexcon_flexcons
    where lot_number = any(p_lot_numbers) and status <> 'available'
  ) then
    raise exception 'すでに出荷済みのロット番号が含まれています。';
  end if;

  insert into public.flexcon_shipments (
    destination_id, shipped_at, contact_name, transport_profile_id,
    carrier_name, driver_name, vehicle_no, note, created_by_worker_id,
    shipment_kind, product_name, quantity_count, purchase_price_per_bale
  ) values (
    p_destination_id, p_shipped_at, null, v_transport.id,
    v_transport.company_name, v_driver_name, v_vehicle_no,
    nullif(btrim(p_note), ''), v_worker.worker_id,
    'qr_flexcon', null, v_count, p_purchase_price_per_bale
  ) returning id into v_shipment_id;

  insert into public.flexcon_shipment_items (shipment_id, flexcon_id, lot_number)
  select v_shipment_id, id, lot_number
  from public.flexcon_flexcons
  where lot_number = any(p_lot_numbers);

  update public.flexcon_flexcons
  set status = 'shipped', updated_at = now()
  where lot_number = any(p_lot_numbers);

  insert into public.flexcon_scan_events (
    flexcon_id, shipment_id, event_type, destination_id, worker_id
  )
  select id, v_shipment_id, 'shipped', p_destination_id, v_worker.worker_id
  from public.flexcon_flexcons
  where lot_number = any(p_lot_numbers);

  return v_shipment_id;
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
  p_product_name text,
  p_quantity_count integer,
  p_purchase_price_per_bale numeric,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_transport public.flexcon_transport_profiles%rowtype;
  v_shipment_id uuid;
  v_driver_name text;
  v_vehicle_no text;
  v_product_name text;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_driver_name := nullif(btrim(p_driver_name), '');
  v_vehicle_no := nullif(btrim(p_vehicle_no), '');
  v_product_name := nullif(btrim(p_product_name), '');

  if p_shipment_kind not in ('paper_bag', 'other_rice') then
    raise exception '出荷区分が正しくありません。';
  end if;
  if p_shipped_at is null then raise exception '出荷日時を入力してください。'; end if;
  if v_driver_name is null then raise exception 'ドライバー名を入力してください。'; end if;
  if v_vehicle_no is null then raise exception '車両番号を入力してください。'; end if;
  if p_quantity_count is null or p_quantity_count < 1 then
    raise exception '数量を1以上で入力してください。';
  end if;
  if p_purchase_price_per_bale is not null and p_purchase_price_per_bale < 0 then
    raise exception '仕入値は0以上で入力してください。';
  end if;
  if p_shipment_kind = 'paper_bag' then
    v_product_name := '紙袋';
  elsif v_product_name is null or not exists (
    select 1
    from public.flexcon_inspection_options
    where option_type = 'shipment_product'
      and name = v_product_name
      and active = true
  ) then
    raise exception '選択された種類は利用できません。';
  end if;
  if not exists (
    select 1 from public.flexcon_destinations
    where id = p_destination_id and active = true
  ) then
    raise exception '選択された納品先は利用できません。';
  end if;

  select * into v_transport
  from public.flexcon_transport_profiles
  where id = p_transport_profile_id and active = true;
  if not found then raise exception '選択された運送会社は利用できません。'; end if;

  insert into public.flexcon_shipments (
    destination_id, shipped_at, contact_name, transport_profile_id,
    carrier_name, driver_name, vehicle_no, note, created_by_worker_id,
    shipment_kind, product_name, quantity_count, purchase_price_per_bale
  ) values (
    p_destination_id, p_shipped_at, null, v_transport.id,
    v_transport.company_name, v_driver_name, v_vehicle_no,
    nullif(btrim(p_note), ''), v_worker.worker_id,
    p_shipment_kind, v_product_name, p_quantity_count, p_purchase_price_per_bale
  ) returning id into v_shipment_id;

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
  p_product_name text,
  p_quantity_count integer,
  p_purchase_price_per_bale numeric,
  p_note text default null
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
  perform public.flexcon_require_admin_worker(p_worker_id);
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
  elsif v_shipment.shipment_kind = 'other_rice'
        and v_product_name is null then
    raise exception '種類を入力してください。';
  elsif v_shipment.shipment_kind = 'other_rice'
        and v_product_name is distinct from v_shipment.product_name
        and not exists (
          select 1
          from public.flexcon_inspection_options
          where option_type = 'shipment_product'
            and name = v_product_name
            and active = true
        ) then
    raise exception '選択された種類は利用できません。';
  end if;
  if not exists (
    select 1 from public.flexcon_destinations
    where id = p_destination_id and active = true
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
      product_name = case
        when v_shipment.shipment_kind = 'qr_flexcon' then null
        else v_product_name
      end,
      quantity_count = case
        when v_shipment.shipment_kind = 'qr_flexcon' then v_shipment.quantity_count
        else p_quantity_count
      end,
      purchase_price_per_bale = p_purchase_price_per_bale,
      note = nullif(btrim(p_note), '')
  where id = p_shipment_id;

  if not found then raise exception '出荷履歴が見つかりません。'; end if;

  update public.flexcon_scan_events
  set destination_id = p_destination_id
  where shipment_id = p_shipment_id;
end;
$$;

revoke all on function public.flexcon_save_inspection_option(text, uuid, text, text) from public;
revoke all on function public.flexcon_register_shipment(text, uuid, uuid, timestamptz, text, text, text[], numeric, text) from public;
revoke all on function public.flexcon_register_manual_shipment(text, uuid, uuid, timestamptz, text, text, text, text, integer, numeric, text) from public;
revoke all on function public.flexcon_update_shipment(text, uuid, uuid, uuid, timestamptz, text, text, text, integer, numeric, text) from public;

grant execute on function public.flexcon_save_inspection_option(text, uuid, text, text)
  to anon, authenticated;
grant execute on function public.flexcon_register_shipment(text, uuid, uuid, timestamptz, text, text, text[], numeric, text)
  to anon, authenticated;
grant execute on function public.flexcon_register_manual_shipment(text, uuid, uuid, timestamptz, text, text, text, text, integer, numeric, text)
  to anon, authenticated;
grant execute on function public.flexcon_update_shipment(text, uuid, uuid, uuid, timestamptz, text, text, text, integer, numeric, text)
  to anon, authenticated;

commit;
