begin;

create or replace view public.flexcon_inventory_balances_by_crop_year
with (security_invoker = true)
as
with unassigned_warehouse as (
  select id
  from public.flexcon_inspection_options
  where option_type = 'warehouse' and name = '倉庫未設定'
  order by created_at
  limit 1
), yearly_ledger as (
  select ledger.*,
    coalesce(ledger.crop_year, flexcon.fiscal_year + 2018, paper.fiscal_year + 2018) as inventory_crop_year
  from public.flexcon_inventory_ledger as ledger
  left join public.flexcon_inspection_flexcons as flexcon
    on ledger.source_type in ('inspection_flexcon', 'shipment_flexcon')
    and flexcon.id::text = split_part(ledger.id, ':', case when ledger.source_type = 'shipment_flexcon' then 3 else 2 end)
  left join public.flexcon_inspection_paper_bags as paper
    on ledger.source_type = 'inspection_paper_bag'
    and paper.id::text = split_part(ledger.id, ':', 2)
), inventory_delta as (
  select to_warehouse_id as warehouse_id, inventory_crop_year as crop_year,
    origin, product_name, grade, unit, quantity as quantity_delta
  from yearly_ledger
  where to_warehouse_id is not null or source_type = 'settlement'
  union all
  select from_warehouse_id, inventory_crop_year,
    origin, product_name, grade, unit, -quantity
  from yearly_ledger
  where from_warehouse_id is not null
), normalized_delta as (
  select case when delta.warehouse_id = unassigned.id then null::uuid else delta.warehouse_id end as warehouse_id,
    delta.crop_year, delta.origin, delta.product_name,
    coalesce(nullif(btrim(delta.grade), ''), '対象外') as grade,
    delta.unit, delta.quantity_delta
  from inventory_delta as delta
  cross join unassigned_warehouse as unassigned
)
select normalized.warehouse_id,
  case when normalized.warehouse_id is null then '倉庫未設定' else warehouse.name end as warehouse_name,
  normalized.crop_year, normalized.origin, normalized.product_name,
  normalized.grade, normalized.unit,
  sum(normalized.quantity_delta)::numeric(14, 3) as quantity
from normalized_delta as normalized
left join public.flexcon_inspection_options as warehouse
  on warehouse.id = normalized.warehouse_id and warehouse.option_type = 'warehouse'
group by normalized.warehouse_id, warehouse.name, normalized.crop_year,
  normalized.origin, normalized.product_name, normalized.grade, normalized.unit
having sum(normalized.quantity_delta) <> 0;

grant select on public.flexcon_inventory_balances_by_crop_year to anon, authenticated;
notify pgrst, 'reload schema';

commit;
