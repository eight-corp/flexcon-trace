begin;

alter table public.flexcon_inventory_movements
  add column if not exists crop_year integer
  check (crop_year between 1900 and 2100);

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
  p_to_warehouse_id uuid,
  p_crop_year integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movement_id uuid;
begin
  if p_crop_year is not null and p_crop_year not between 1900 and 2100 then
    raise exception '産年は1900～2100の西暦4桁で入力してください。';
  end if;

  v_movement_id := public.flexcon_add_inventory_movement(
    p_worker_id, p_movement_date, p_producer_name, p_origin, p_product_name,
    p_grade, p_quantity, p_unit, p_from_warehouse_id, p_to_warehouse_id
  );
  update public.flexcon_inventory_movements
  set crop_year = p_crop_year
  where id = v_movement_id;
  return v_movement_id;
end;
$$;

create or replace function public.flexcon_update_inventory_movement(
  p_worker_id text,
  p_movement_id uuid,
  p_movement_date date,
  p_producer_name text,
  p_origin text,
  p_product_name text,
  p_grade text,
  p_quantity numeric,
  p_unit text,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_crop_year integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_crop_year is not null and p_crop_year not between 1900 and 2100 then
    raise exception '産年は1900～2100の西暦4桁で入力してください。';
  end if;

  perform public.flexcon_update_inventory_movement(
    p_worker_id, p_movement_id, p_movement_date, p_producer_name, p_origin,
    p_product_name, p_grade, p_quantity, p_unit, p_from_warehouse_id, p_to_warehouse_id
  );
  update public.flexcon_inventory_movements
  set crop_year = p_crop_year
  where id = p_movement_id;
end;
$$;

create or replace view public.flexcon_inventory_ledger
with (security_invoker = true)
as
select base.*, coalesce(movement.crop_year, line.crop_year) as crop_year
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

grant execute on function public.flexcon_add_inventory_movement(text, date, text, text, text, text, numeric, text, uuid, uuid, integer) to anon, authenticated;
grant execute on function public.flexcon_update_inventory_movement(text, uuid, date, text, text, text, text, numeric, text, uuid, uuid, integer) to anon, authenticated;
grant select on public.flexcon_inventory_ledger to anon, authenticated;
notify pgrst, 'reload schema';

commit;
