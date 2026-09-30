begin;

create or replace view public.flexcon_inventory_shipped_quantities_by_crop_year
with (security_invoker = true)
as
with unassigned_warehouse as (
  select id
  from public.flexcon_inspection_options
  where option_type = 'warehouse' and name = '倉庫未設定'
  order by created_at
  limit 1
), shipped as (
  select case when ledger.from_warehouse_id = unassigned.id then null::uuid else ledger.from_warehouse_id end as warehouse_id,
    coalesce(ledger.crop_year, flexcon.fiscal_year + 2018) as crop_year,
    ledger.origin, ledger.product_name, ledger.unit, ledger.quantity
  from public.flexcon_inventory_ledger as ledger
  cross join unassigned_warehouse as unassigned
  left join public.flexcon_inspection_flexcons as flexcon
    on ledger.source_type = 'shipment_flexcon'
    and flexcon.id::text = split_part(ledger.id, ':', 3)
  where ledger.source_type in ('shipment_flexcon', 'shipment_manual', 'shipment_record')
    and ledger.from_warehouse_id is not null
)
select warehouse_id, crop_year, origin, product_name, unit,
  sum(quantity)::numeric(14, 3) as shipped_quantity
from shipped
group by warehouse_id, crop_year, origin, product_name, unit;

grant select on public.flexcon_inventory_shipped_quantities_by_crop_year to anon, authenticated;
notify pgrst, 'reload schema';

commit;
