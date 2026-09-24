begin;

alter table public.flexcon_inventory_movements
  add column if not exists note text
  check (char_length(note) <= 500);

create or replace function public.flexcon_add_inventory_movement(
  p_worker_id text, p_movement_date date, p_producer_name text, p_origin text,
  p_product_name text, p_grade text, p_quantity numeric, p_unit text,
  p_from_warehouse_id uuid, p_to_warehouse_id uuid, p_crop_year integer,
  p_settlement_no text, p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movement_id uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if char_length(v_note) > 500 then raise exception '備考は500文字以内で入力してください。'; end if;
  v_movement_id := public.flexcon_add_inventory_movement(
    p_worker_id, p_movement_date, p_producer_name, p_origin, p_product_name,
    p_grade, p_quantity, p_unit, p_from_warehouse_id, p_to_warehouse_id,
    p_crop_year, p_settlement_no
  );
  update public.flexcon_inventory_movements
  set note = v_note
  where id = v_movement_id;
  return v_movement_id;
end;
$$;

create or replace function public.flexcon_update_inventory_movement(
  p_worker_id text, p_movement_id uuid, p_movement_date date,
  p_producer_name text, p_origin text, p_product_name text, p_grade text,
  p_quantity numeric, p_unit text, p_from_warehouse_id uuid,
  p_to_warehouse_id uuid, p_crop_year integer, p_settlement_no text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if char_length(v_note) > 500 then raise exception '備考は500文字以内で入力してください。'; end if;
  perform public.flexcon_update_inventory_movement(
    p_worker_id, p_movement_id, p_movement_date, p_producer_name, p_origin,
    p_product_name, p_grade, p_quantity, p_unit, p_from_warehouse_id,
    p_to_warehouse_id, p_crop_year, p_settlement_no
  );
  update public.flexcon_inventory_movements
  set note = v_note
  where id = p_movement_id;
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
  shipment.created_at, shipment.purchase_price_per_bale, null::integer, null::text
from public.flexcon_shipments as shipment
join public.flexcon_manual_shipment_items as item on item.shipment_id = shipment.id
join public.flexcon_destinations as destination on destination.id = shipment.destination_id
left join public.workers as worker on worker.worker_id = shipment.created_by_worker_id
left join public.flexcon_inspection_options as warehouse on warehouse.id = shipment.inventory_from_warehouse_id
where shipment.shipment_kind = 'manual_record' and shipment.inventory_from_warehouse_id is not null;

revoke all on function public.flexcon_add_inventory_movement(text, date, text, text, text, text, numeric, text, uuid, uuid, integer, text, text) from public;
revoke all on function public.flexcon_update_inventory_movement(text, uuid, date, text, text, text, text, numeric, text, uuid, uuid, integer, text, text) from public;
grant execute on function public.flexcon_add_inventory_movement(text, date, text, text, text, text, numeric, text, uuid, uuid, integer, text, text) to anon, authenticated;
grant execute on function public.flexcon_update_inventory_movement(text, uuid, date, text, text, text, text, numeric, text, uuid, uuid, integer, text, text) to anon, authenticated;
grant select on public.flexcon_inventory_ledger to anon, authenticated;
notify pgrst, 'reload schema';

commit;
