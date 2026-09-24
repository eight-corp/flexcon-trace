begin;

alter table public.flexcon_inventory_movements
  add column if not exists settlement_no text
  check (char_length(settlement_no) <= 80);

alter table public.flexcon_inspection_registrations
  add column if not exists settlement_no text
  check (char_length(settlement_no) <= 80);

create or replace function public.flexcon_add_inventory_movement(
  p_worker_id text, p_movement_date date, p_producer_name text, p_origin text,
  p_product_name text, p_grade text, p_quantity numeric, p_unit text,
  p_from_warehouse_id uuid, p_to_warehouse_id uuid, p_crop_year integer,
  p_settlement_no text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movement_id uuid;
  v_settlement_no text := nullif(btrim(coalesce(p_settlement_no, '')), '');
begin
  if char_length(v_settlement_no) > 80 then raise exception '仕切書№は80文字以内で入力してください。'; end if;
  v_movement_id := public.flexcon_add_inventory_movement(
    p_worker_id, p_movement_date, p_producer_name, p_origin, p_product_name,
    p_grade, p_quantity, p_unit, p_from_warehouse_id, p_to_warehouse_id, p_crop_year
  );
  update public.flexcon_inventory_movements
  set settlement_no = v_settlement_no
  where id = v_movement_id;
  return v_movement_id;
end;
$$;

create or replace function public.flexcon_update_inventory_movement(
  p_worker_id text, p_movement_id uuid, p_movement_date date,
  p_producer_name text, p_origin text, p_product_name text, p_grade text,
  p_quantity numeric, p_unit text, p_from_warehouse_id uuid,
  p_to_warehouse_id uuid, p_crop_year integer, p_settlement_no text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settlement_no text := nullif(btrim(coalesce(p_settlement_no, '')), '');
begin
  if char_length(v_settlement_no) > 80 then raise exception '仕切書№は80文字以内で入力してください。'; end if;
  perform public.flexcon_update_inventory_movement(
    p_worker_id, p_movement_id, p_movement_date, p_producer_name, p_origin,
    p_product_name, p_grade, p_quantity, p_unit, p_from_warehouse_id,
    p_to_warehouse_id, p_crop_year
  );
  update public.flexcon_inventory_movements
  set settlement_no = v_settlement_no
  where id = p_movement_id;
end;
$$;

create or replace function public.flexcon_add_inspection_group_with_warehouse(
  p_worker_id text, p_authorization_id uuid, p_fiscal_year integer,
  p_purchase_date date, p_inspection_date date, p_inspection_location text,
  p_brand text, p_flexcon_count integer, p_paper_bag_count integer,
  p_flexcon_quantity_kg integer, p_bulk_quantity_kg integer,
  p_warehouse_id uuid, p_settlement_no text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_settlement_no text := nullif(btrim(coalesce(p_settlement_no, '')), '');
begin
  if char_length(v_settlement_no) > 80 then raise exception '仕切書№は80文字以内で入力してください。'; end if;
  v_result := public.flexcon_add_inspection_group_with_warehouse(
    p_worker_id, p_authorization_id, p_fiscal_year, p_purchase_date,
    p_inspection_date, p_inspection_location, p_brand, p_flexcon_count,
    p_paper_bag_count, p_flexcon_quantity_kg, p_bulk_quantity_kg, p_warehouse_id
  );
  update public.flexcon_inspection_registrations
  set settlement_no = v_settlement_no
  where registration_no = (v_result->>'registration_no')::bigint;
  return v_result;
end;
$$;

create or replace function public.flexcon_set_inspection_registration_settlement_no(
  p_worker_id text, p_registration_id uuid, p_settlement_no text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settlement_no text := nullif(btrim(coalesce(p_settlement_no, '')), '');
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  if char_length(v_settlement_no) > 80 then raise exception '仕切書№は80文字以内で入力してください。'; end if;
  update public.flexcon_inspection_registrations
  set settlement_no = v_settlement_no
  where id = p_registration_id;
  if not found then raise exception '検査記録が見つかりません。'; end if;
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
  coalesce(movement.crop_year, line.crop_year) as crop_year
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
  shipment.created_at, shipment.purchase_price_per_bale, null::integer
from public.flexcon_shipments as shipment
join public.flexcon_manual_shipment_items as item on item.shipment_id = shipment.id
join public.flexcon_destinations as destination on destination.id = shipment.destination_id
left join public.workers as worker on worker.worker_id = shipment.created_by_worker_id
left join public.flexcon_inspection_options as warehouse on warehouse.id = shipment.inventory_from_warehouse_id
where shipment.shipment_kind = 'manual_record' and shipment.inventory_from_warehouse_id is not null;

grant execute on function public.flexcon_add_inventory_movement(text, date, text, text, text, text, numeric, text, uuid, uuid, integer, text) to anon, authenticated;
grant execute on function public.flexcon_update_inventory_movement(text, uuid, date, text, text, text, text, numeric, text, uuid, uuid, integer, text) to anon, authenticated;
grant execute on function public.flexcon_add_inspection_group_with_warehouse(text, uuid, integer, date, date, text, text, integer, integer, integer, integer, uuid, text) to anon, authenticated;
grant execute on function public.flexcon_set_inspection_registration_settlement_no(text, uuid, text) to anon, authenticated;
grant select on public.flexcon_inventory_ledger to anon, authenticated;
notify pgrst, 'reload schema';

commit;
