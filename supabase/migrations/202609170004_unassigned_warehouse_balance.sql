-- 入庫先未設定の仕切り書明細も、倉庫別在庫へ独立した行として表示します。

begin;

create or replace view public.flexcon_inventory_balances
with (security_invoker = true)
as
select
  inventory_delta.warehouse_id,
  case when inventory_delta.warehouse_id is null then '倉庫未設定' else warehouse.name end as warehouse_name,
  inventory_delta.origin,
  inventory_delta.product_name,
  inventory_delta.grade,
  inventory_delta.unit,
  sum(inventory_delta.quantity_delta)::numeric(14, 3) as quantity
from (
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
) as inventory_delta
left join public.flexcon_inspection_options as warehouse
  on warehouse.id = inventory_delta.warehouse_id
 and warehouse.option_type = 'warehouse'
group by inventory_delta.warehouse_id, warehouse.name, inventory_delta.origin, inventory_delta.product_name, inventory_delta.grade, inventory_delta.unit
having sum(inventory_delta.quantity_delta) <> 0;

grant select on public.flexcon_inventory_balances to anon, authenticated;

commit;

notify pgrst, 'reload schema';
