begin;

insert into public.flexcon_inspection_options (option_type, name, active, sort_order)
select 'warehouse', '倉庫未設定', false, -2147483648
where not exists (
  select 1 from public.flexcon_inspection_options
  where option_type = 'warehouse' and name = '倉庫未設定'
);

alter table public.flexcon_shipments
  add column if not exists inventory_from_warehouse_id uuid
  references public.flexcon_inspection_options(id);

alter table public.flexcon_inspection_registrations
  add column if not exists warehouse_id uuid
  references public.flexcon_inspection_options(id);

drop view if exists public.flexcon_inventory_ledger;
drop view if exists public.flexcon_inventory_balances;

create view public.flexcon_inventory_balances
with (security_invoker = true)
as
with unassigned_warehouse as (
  select id from public.flexcon_inspection_options
  where option_type = 'warehouse' and name = '倉庫未設定'
  order by created_at
  limit 1
),
inventory_delta as (
  select movement.to_warehouse_id as warehouse_id, movement.origin, movement.product_name, movement.grade, movement.unit, movement.quantity as quantity_delta
  from public.flexcon_inventory_movements as movement
  where movement.to_warehouse_id is not null
  union all
  select movement.from_warehouse_id, movement.origin, movement.product_name, movement.grade, movement.unit, -movement.quantity
  from public.flexcon_inventory_movements as movement
  where movement.from_warehouse_id is not null
  union all
  select line.to_warehouse_id, line.origin, line.product_name, line.grade, line.unit, line.quantity
  from public.flexcon_purchase_statement_lines as line
  union all
  select coalesce(registration.warehouse_id, unassigned.id),
    case when right(btrim(auth_record.prefecture), 1) in ('都', '道', '府', '県') then btrim(auth_record.prefecture) else btrim(auth_record.prefecture) || '県' end,
    btrim(flexcon.brand), case when btrim(flexcon.grade) in ('1等', '2等', '3等', '合格') then btrim(flexcon.grade) else '検査前' end,
    case when flexcon.record_kind = 'bulk' then 'kg' else '本' end,
    case when flexcon.record_kind = 'bulk' then flexcon.quantity_kg::numeric else 1::numeric end
  from public.flexcon_inspection_flexcons as flexcon
  join public.flexcon_inspection_registrations as registration on registration.id = flexcon.registration_id
  join public.flexcon_authorizations as auth_record on auth_record.id = flexcon.authorization_id
  cross join unassigned_warehouse as unassigned
  where nullif(btrim(auth_record.prefecture), '') is not null
    and nullif(btrim(flexcon.brand), '') is not null
    and flexcon.quantity_kg > 0
  union all
  select coalesce(registration.warehouse_id, unassigned.id),
    case when right(btrim(auth_record.prefecture), 1) in ('都', '道', '府', '県') then btrim(auth_record.prefecture) else btrim(auth_record.prefecture) || '県' end,
    btrim(paper.brand), case when btrim(paper.grade) in ('1等', '2等', '3等', '合格') then btrim(paper.grade) else '検査前' end, '袋', paper.bag_count::numeric
  from public.flexcon_inspection_paper_bags as paper
  join public.flexcon_inspection_registrations as registration on registration.id = paper.registration_id
  join public.flexcon_authorizations as auth_record on auth_record.id = paper.authorization_id
  cross join unassigned_warehouse as unassigned
  where nullif(btrim(auth_record.prefecture), '') is not null
    and nullif(btrim(paper.brand), '') is not null
    and paper.bag_count > 0
  union all
  select shipment.inventory_from_warehouse_id,
    item.origin_prefecture, item.product_name, coalesce(nullif(btrim(item.grade), ''), '未検査'),
    case when source.record_kind = 'bulk' then 'kg' else '本' end,
    -(case when source.record_kind = 'bulk' then source.quantity_kg::numeric else 1::numeric end)
  from public.flexcon_shipments as shipment
  join public.flexcon_shipment_items as item on item.shipment_id = shipment.id
  left join lateral (
    select flexcon.record_kind, flexcon.quantity_kg
    from public.flexcon_inspection_flexcons as flexcon
    where flexcon.lot_number = item.lot_number
       or (char_length(flexcon.lot_number) = 11 and substring(flexcon.lot_number from 5) = item.lot_number)
       or (char_length(item.lot_number) = 11 and substring(item.lot_number from 5) = flexcon.lot_number)
    order by case when flexcon.lot_number = item.lot_number then 0 else 1 end, flexcon.updated_at desc
    limit 1
  ) as source on true
  where shipment.inventory_from_warehouse_id is not null
    and shipment.shipment_kind = 'qr_flexcon'
  union all
  select shipment.inventory_from_warehouse_id,
    item.origin_prefecture, item.product_name,
    case when shipment.shipment_kind = 'other_rice' then '' else coalesce(nullif(btrim(item.grade), ''), '未検査') end,
    case when shipment.shipment_kind = 'paper_bag' then '袋' else '本' end,
    -item.quantity_count::numeric
  from public.flexcon_shipments as shipment
  join public.flexcon_manual_shipment_items as item on item.shipment_id = shipment.id
  where shipment.inventory_from_warehouse_id is not null
    and shipment.shipment_kind in ('paper_bag', 'other_rice')
),
normalized_delta as (
  select case when delta.warehouse_id = unassigned.id then null else delta.warehouse_id end as warehouse_id,
    delta.origin, delta.product_name, delta.grade, delta.unit, delta.quantity_delta
  from inventory_delta as delta
  cross join unassigned_warehouse as unassigned
)
select normalized.warehouse_id,
  case when normalized.warehouse_id is null then '倉庫未設定' else warehouse.name end as warehouse_name,
  normalized.origin, normalized.product_name,
  coalesce(nullif(btrim(normalized.grade), ''), '対象外') as grade,
  normalized.unit,
  sum(normalized.quantity_delta)::numeric(14, 3) as quantity
from normalized_delta as normalized
left join public.flexcon_inspection_options as warehouse
  on warehouse.id = normalized.warehouse_id and warehouse.option_type = 'warehouse'
group by normalized.warehouse_id, warehouse.name, normalized.origin, normalized.product_name,
  coalesce(nullif(btrim(normalized.grade), ''), '対象外'), normalized.unit
having sum(normalized.quantity_delta) <> 0;

create view public.flexcon_inventory_ledger
with (security_invoker = true)
as
with unassigned_warehouse as (
  select id, name from public.flexcon_inspection_options
  where option_type = 'warehouse' and name = '倉庫未設定'
  order by created_at
  limit 1
)
select movement.id::text as id, movement.registration_order, 'manual'::text as source_type,
  case when movement.from_warehouse_id is null then 'inbound' when movement.to_warehouse_id is null then 'outbound' else 'transfer' end as movement_type,
  movement.movement_date, movement.worker_name, coalesce(movement.producer_name, '') as producer_name,
  ''::text as settlement_no, movement.origin, movement.product_name,
  coalesce(nullif(btrim(movement.grade), ''), '対象外') as grade, movement.quantity, movement.unit,
  movement.from_warehouse_id, movement.to_warehouse_id, movement.movement_from, movement.movement_to,
  movement.created_at, null::numeric as purchase_price
from public.flexcon_inventory_movements as movement
union all
select line.id::text, line.registration_order, 'settlement', 'settlement', line.purchased_at::date,
  batch.imported_by_worker_name, line.producer_name, line.settlement_no, line.origin, line.product_name,
  line.grade, line.quantity, line.unit, null::uuid, line.to_warehouse_id, '仕切り書', line.to_warehouse_name,
  line.created_at, line.purchase_price
from public.flexcon_purchase_statement_lines as line
join public.flexcon_purchase_import_batches as batch on batch.id = line.batch_id
union all
select 'inspection-flexcon:' || flexcon.id::text, null::bigint, 'inspection_flexcon', 'inbound',
  flexcon.purchase_date, coalesce(worker.worker_name, '登録者不明'), auth_record.full_name, '',
  case when right(btrim(auth_record.prefecture), 1) in ('都', '道', '府', '県') then btrim(auth_record.prefecture) else btrim(auth_record.prefecture) || '県' end,
  btrim(flexcon.brand), case when btrim(flexcon.grade) in ('1等', '2等', '3等', '合格') then btrim(flexcon.grade) else '検査前' end,
  case when flexcon.record_kind = 'bulk' then flexcon.quantity_kg::numeric else 1::numeric end,
  case when flexcon.record_kind = 'bulk' then 'kg' else '本' end,
  null::uuid, coalesce(registration.warehouse_id, unassigned.id), '検査記録', coalesce(warehouse.name, unassigned.name), flexcon.created_at, null::numeric
from public.flexcon_inspection_flexcons as flexcon
join public.flexcon_inspection_registrations as registration on registration.id = flexcon.registration_id
join public.flexcon_authorizations as auth_record on auth_record.id = flexcon.authorization_id
left join public.workers as worker on worker.worker_id = flexcon.created_by_worker_id
left join public.flexcon_inspection_options as warehouse on warehouse.id = registration.warehouse_id and warehouse.option_type = 'warehouse'
cross join unassigned_warehouse as unassigned
where nullif(btrim(auth_record.prefecture), '') is not null and nullif(btrim(flexcon.brand), '') is not null
union all
select 'inspection-paper:' || paper.id::text, null::bigint, 'inspection_paper_bag', 'inbound',
  paper.purchase_date, coalesce(worker.worker_name, '登録者不明'), auth_record.full_name, '',
  case when right(btrim(auth_record.prefecture), 1) in ('都', '道', '府', '県') then btrim(auth_record.prefecture) else btrim(auth_record.prefecture) || '県' end,
  btrim(paper.brand), case when btrim(paper.grade) in ('1等', '2等', '3等', '合格') then btrim(paper.grade) else '検査前' end, paper.bag_count::numeric, '袋',
  null::uuid, coalesce(registration.warehouse_id, unassigned.id), '検査記録', coalesce(warehouse.name, unassigned.name), paper.created_at, null::numeric
from public.flexcon_inspection_paper_bags as paper
join public.flexcon_inspection_registrations as registration on registration.id = paper.registration_id
join public.flexcon_authorizations as auth_record on auth_record.id = paper.authorization_id
left join public.workers as worker on worker.worker_id = paper.created_by_worker_id
left join public.flexcon_inspection_options as warehouse on warehouse.id = registration.warehouse_id and warehouse.option_type = 'warehouse'
cross join unassigned_warehouse as unassigned
where nullif(btrim(auth_record.prefecture), '') is not null and nullif(btrim(paper.brand), '') is not null
union all
select 'shipment-flexcon:' || shipment.id::text || ':' || item.flexcon_id::text, null::bigint,
  'shipment_flexcon', 'outbound', shipment.shipped_at::date,
  coalesce(worker.worker_name, '登録者不明'), coalesce(auth_record.full_name, ''), '',
  item.origin_prefecture, item.product_name, coalesce(nullif(btrim(item.grade), ''), '未検査'),
  case when source.record_kind = 'bulk' then source.quantity_kg::numeric else 1::numeric end,
  case when source.record_kind = 'bulk' then 'kg' else '本' end,
  shipment.inventory_from_warehouse_id, null::uuid, coalesce(warehouse.name, '倉庫未設定'), destination.name,
  shipment.created_at, shipment.purchase_price_per_bale
from public.flexcon_shipments as shipment
join public.flexcon_shipment_items as item on item.shipment_id = shipment.id
join public.flexcon_destinations as destination on destination.id = shipment.destination_id
left join public.workers as worker on worker.worker_id = shipment.created_by_worker_id
left join public.flexcon_inspection_options as warehouse on warehouse.id = shipment.inventory_from_warehouse_id
left join lateral (
  select flexcon.authorization_id, flexcon.record_kind, flexcon.quantity_kg
  from public.flexcon_inspection_flexcons as flexcon
  where flexcon.lot_number = item.lot_number
     or (char_length(flexcon.lot_number) = 11 and substring(flexcon.lot_number from 5) = item.lot_number)
     or (char_length(item.lot_number) = 11 and substring(item.lot_number from 5) = flexcon.lot_number)
  order by case when flexcon.lot_number = item.lot_number then 0 else 1 end, flexcon.updated_at desc
  limit 1
) as source on true
left join public.flexcon_authorizations as auth_record on auth_record.id = source.authorization_id
where shipment.shipment_kind = 'qr_flexcon' and shipment.inventory_from_warehouse_id is not null
union all
select 'shipment-manual:' || item.id::text, null::bigint, 'shipment_manual', 'outbound',
  shipment.shipped_at::date, coalesce(worker.worker_name, '登録者不明'), '', '',
  item.origin_prefecture, item.product_name,
  case when shipment.shipment_kind = 'other_rice' then '対象外' else coalesce(nullif(btrim(item.grade), ''), '未検査') end,
  item.quantity_count::numeric, case when shipment.shipment_kind = 'paper_bag' then '袋' else '本' end,
  shipment.inventory_from_warehouse_id, null::uuid, coalesce(warehouse.name, '倉庫未設定'), destination.name,
  shipment.created_at, shipment.purchase_price_per_bale
from public.flexcon_shipments as shipment
join public.flexcon_manual_shipment_items as item on item.shipment_id = shipment.id
join public.flexcon_destinations as destination on destination.id = shipment.destination_id
left join public.workers as worker on worker.worker_id = shipment.created_by_worker_id
left join public.flexcon_inspection_options as warehouse on warehouse.id = shipment.inventory_from_warehouse_id
where shipment.shipment_kind in ('paper_bag', 'other_rice') and shipment.inventory_from_warehouse_id is not null;

create or replace function public.flexcon_add_inspection_group_with_warehouse(
  p_worker_id text,
  p_authorization_id uuid,
  p_fiscal_year integer,
  p_purchase_date date,
  p_inspection_date date,
  p_inspection_location text,
  p_brand text,
  p_flexcon_count integer,
  p_paper_bag_count integer,
  p_flexcon_quantity_kg integer,
  p_bulk_quantity_kg integer,
  p_warehouse_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_registration_no bigint;
begin
  if not exists (
    select 1 from public.flexcon_inspection_options
    where id = p_warehouse_id and option_type = 'warehouse' and active = true
  ) then raise exception '搬入先を選択してください。'; end if;

  v_result := public.flexcon_add_inspection_group(
    p_worker_id, p_authorization_id, p_fiscal_year, p_purchase_date, p_inspection_date,
    p_inspection_location, p_brand, p_flexcon_count, p_paper_bag_count,
    p_flexcon_quantity_kg, p_bulk_quantity_kg
  );
  v_registration_no := (v_result->>'registration_no')::bigint;

  update public.flexcon_inspection_registrations
  set warehouse_id = p_warehouse_id
  where registration_no = v_registration_no;

  return v_result || jsonb_build_object('warehouse_id', p_warehouse_id);
end;
$$;

create or replace function public.flexcon_add_inventory_movement(
  p_worker_id text,
  p_movement_date date,
  p_producer_name text,
  p_origin text,
  p_product_name text,
  p_grade text,
  p_quantity numeric,
  p_unit text,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_producer_name text := btrim(coalesce(p_producer_name, ''));
  v_origin text := btrim(coalesce(p_origin, ''));
  v_product_name text := btrim(coalesce(p_product_name, ''));
  v_grade text := btrim(coalesce(p_grade, ''));
  v_unit text := btrim(coalesce(p_unit, ''));
  v_from_name text := '外部';
  v_to_name text := '外部';
  v_movement_id uuid;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if p_movement_date is null then raise exception '日付を入力してください。'; end if;
  if char_length(v_producer_name) > 120 then raise exception '生産者名は120文字以内で入力してください。'; end if;
  perform public.flexcon_validate_inventory_selection(v_origin, v_product_name, v_grade, p_quantity, v_unit);
  if p_from_warehouse_id is null and p_to_warehouse_id is null then raise exception '移動元または移動先の倉庫を選択してください。'; end if;
  if p_from_warehouse_id is not null and p_from_warehouse_id = p_to_warehouse_id then raise exception '移動元と移動先には別の倉庫を選択してください。'; end if;

  if p_from_warehouse_id is not null then
    select name into v_from_name from public.flexcon_inspection_options
    where id = p_from_warehouse_id and option_type = 'warehouse';
    if v_from_name is null then raise exception '移動元の倉庫が見つかりません。'; end if;
    perform pg_advisory_xact_lock(hashtextextended(concat_ws(chr(31), p_from_warehouse_id::text, v_origin, v_product_name, v_grade, v_unit), 0));
  end if;
  if p_to_warehouse_id is not null then
    select name into v_to_name from public.flexcon_inspection_options
    where id = p_to_warehouse_id and option_type = 'warehouse' and active = true;
    if v_to_name is null then raise exception '移動先の倉庫は利用できません。'; end if;
  end if;

  insert into public.flexcon_inventory_movements (
    movement_date, worker_id, worker_name, producer_name, origin, product_name, grade, quantity, unit,
    from_warehouse_id, to_warehouse_id, movement_from, movement_to
  ) values (
    p_movement_date, v_worker.worker_id, v_worker.worker_name, nullif(v_producer_name, ''), v_origin, v_product_name, v_grade,
    round(p_quantity, 3), v_unit, p_from_warehouse_id, p_to_warehouse_id, v_from_name, v_to_name
  ) returning id into v_movement_id;

  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '移動元の在庫が不足しているため登録できません。';
  end if;
  return v_movement_id;
end;
$$;

create or replace function public.flexcon_register_inventory_shipment(
  p_worker_id text, p_destination_id uuid, p_transport_profile_id uuid, p_shipped_at timestamptz,
  p_driver_name text, p_vehicle_no text, p_lot_numbers text[], p_purchase_price_per_bale numeric,
  p_from_warehouse_id uuid, p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_shipment_id uuid;
begin
  if not exists (select 1 from public.flexcon_inspection_options where id = p_from_warehouse_id and option_type = 'warehouse') then
    raise exception '出庫元倉庫を選択してください。';
  end if;
  v_shipment_id := public.flexcon_register_shipment(p_worker_id, p_destination_id, p_transport_profile_id,
    p_shipped_at, p_driver_name, p_vehicle_no, p_lot_numbers, p_purchase_price_per_bale, p_note);
  update public.flexcon_shipments set inventory_from_warehouse_id = p_from_warehouse_id where id = v_shipment_id;
  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '出庫元倉庫の在庫が不足しているため出荷できません。';
  end if;
  return v_shipment_id;
end;
$$;

create or replace function public.flexcon_register_inventory_manual_shipment(
  p_worker_id text, p_destination_id uuid, p_transport_profile_id uuid, p_shipped_at timestamptz,
  p_driver_name text, p_vehicle_no text, p_shipment_kind text, p_items jsonb,
  p_purchase_price_per_bale numeric, p_from_warehouse_id uuid, p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_shipment_id uuid;
begin
  if not exists (select 1 from public.flexcon_inspection_options where id = p_from_warehouse_id and option_type = 'warehouse') then
    raise exception '出庫元倉庫を選択してください。';
  end if;
  v_shipment_id := public.flexcon_register_manual_shipment(p_worker_id, p_destination_id, p_transport_profile_id,
    p_shipped_at, p_driver_name, p_vehicle_no, p_shipment_kind, p_items, p_purchase_price_per_bale, p_note);
  update public.flexcon_shipments set inventory_from_warehouse_id = p_from_warehouse_id where id = v_shipment_id;
  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '出庫元倉庫の在庫が不足しているため出荷できません。';
  end if;
  return v_shipment_id;
end;
$$;

grant select on public.flexcon_inventory_ledger, public.flexcon_inventory_balances to anon, authenticated;
revoke all on function public.flexcon_register_inventory_shipment(text, uuid, uuid, timestamptz, text, text, text[], numeric, uuid, text) from public;
revoke all on function public.flexcon_register_inventory_manual_shipment(text, uuid, uuid, timestamptz, text, text, text, jsonb, numeric, uuid, text) from public;
revoke all on function public.flexcon_add_inspection_group_with_warehouse(text, uuid, integer, date, date, text, text, integer, integer, integer, integer, uuid) from public;
grant execute on function public.flexcon_register_inventory_shipment(text, uuid, uuid, timestamptz, text, text, text[], numeric, uuid, text) to anon, authenticated;
grant execute on function public.flexcon_register_inventory_manual_shipment(text, uuid, uuid, timestamptz, text, text, text, jsonb, numeric, uuid, text) to anon, authenticated;
grant execute on function public.flexcon_add_inspection_group_with_warehouse(text, uuid, integer, date, date, text, text, integer, integer, integer, integer, uuid) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
