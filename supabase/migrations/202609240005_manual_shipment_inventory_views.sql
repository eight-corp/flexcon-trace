begin;

alter view public.flexcon_inventory_ledger rename to flexcon_inventory_ledger_base;
alter view public.flexcon_inventory_balances rename to flexcon_inventory_balances_base;

create view public.flexcon_inventory_balances
with (security_invoker = true)
as
with unassigned_warehouse as (
  select id from public.flexcon_inspection_options
  where option_type = 'warehouse' and name = '倉庫未設定'
  order by created_at limit 1
), delta as (
  select warehouse_id, origin, product_name, grade, unit, quantity as quantity_delta
  from public.flexcon_inventory_balances_base
  union all
  select case when shipment.inventory_from_warehouse_id = unassigned.id then null else shipment.inventory_from_warehouse_id end,
    item.origin_prefecture, item.product_name,
    coalesce(nullif(btrim(item.grade), ''), '対象外'), item.unit, -item.quantity_count::numeric
  from public.flexcon_shipments as shipment
  join public.flexcon_manual_shipment_items as item on item.shipment_id = shipment.id
  cross join unassigned_warehouse as unassigned
  where shipment.shipment_kind = 'manual_record' and shipment.inventory_from_warehouse_id is not null
)
select delta.warehouse_id,
  case when delta.warehouse_id is null then '倉庫未設定' else warehouse.name end as warehouse_name,
  delta.origin, delta.product_name, delta.grade, delta.unit,
  sum(delta.quantity_delta)::numeric(14, 3) as quantity
from delta
left join public.flexcon_inspection_options as warehouse
  on warehouse.id = delta.warehouse_id and warehouse.option_type = 'warehouse'
group by delta.warehouse_id, warehouse.name, delta.origin, delta.product_name, delta.grade, delta.unit
having sum(delta.quantity_delta) <> 0;

create view public.flexcon_inventory_ledger
with (security_invoker = true)
as
select * from public.flexcon_inventory_ledger_base
union all
select 'shipment-record:' || item.id::text, null::bigint, 'shipment_record', 'outbound',
  shipment.shipped_at::date, coalesce(worker.worker_name, '登録者不明'), ''::text, ''::text,
  item.origin_prefecture, item.product_name,
  coalesce(nullif(btrim(item.grade), ''), '対象外'), item.quantity_count::numeric, item.unit,
  shipment.inventory_from_warehouse_id, null::uuid, coalesce(warehouse.name, '倉庫未設定'), destination.name,
  shipment.created_at, shipment.purchase_price_per_bale
from public.flexcon_shipments as shipment
join public.flexcon_manual_shipment_items as item on item.shipment_id = shipment.id
join public.flexcon_destinations as destination on destination.id = shipment.destination_id
left join public.workers as worker on worker.worker_id = shipment.created_by_worker_id
left join public.flexcon_inspection_options as warehouse on warehouse.id = shipment.inventory_from_warehouse_id
where shipment.shipment_kind = 'manual_record' and shipment.inventory_from_warehouse_id is not null;

grant select on public.flexcon_inventory_balances, public.flexcon_inventory_ledger to anon, authenticated;
notify pgrst, 'reload schema';

commit;
