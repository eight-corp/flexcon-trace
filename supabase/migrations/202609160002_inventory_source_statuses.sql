-- 手入力・検査記録・出荷履歴を一つの入出庫記録として表示します。

begin;

drop view if exists public.flexcon_inventory_source_statuses;
drop view if exists public.flexcon_inventory_ledger;

create view public.flexcon_inventory_ledger
with (security_invoker = true)
as
with manual_movements as (
  select
    movement.id::text as id,
    'manual'::text as source_type,
    case
      when movement.from_warehouse_id is null then 'inbound'
      when movement.to_warehouse_id is null then 'outbound'
      else 'transfer'
    end as movement_type,
    movement.movement_date,
    movement.worker_name,
    movement.origin,
    movement.product_name,
    coalesce(nullif(btrim(movement.grade), ''), '対象外') as grade,
    movement.quantity,
    movement.unit,
    movement.from_warehouse_id,
    movement.to_warehouse_id,
    movement.movement_from,
    movement.movement_to,
    movement.created_at
  from public.flexcon_inventory_movements as movement
),
inspection_flexcons as (
  select
    'inspection-flexcon:' || flexcon.id::text as id,
    'inspection_flexcon'::text as source_type,
    'inbound'::text as movement_type,
    coalesce(flexcon.purchase_date, flexcon.created_at::date) as movement_date,
    coalesce(worker.worker_name, '登録者不明') as worker_name,
    case
      when nullif(btrim(auth_record.prefecture), '') is null then '産地未登録'
      when right(btrim(auth_record.prefecture), 1) in ('都', '道', '府', '県') then btrim(auth_record.prefecture)
      else btrim(auth_record.prefecture) || '県'
    end as origin,
    coalesce(nullif(btrim(flexcon.brand), ''), '名称未登録') as product_name,
    coalesce(nullif(btrim(flexcon.grade), ''), '未入力') as grade,
    case when flexcon.record_kind = 'bulk' then flexcon.quantity_kg::numeric else 1::numeric end as quantity,
    case when flexcon.record_kind = 'bulk' then 'kg' else '本' end as unit,
    null::uuid as from_warehouse_id,
    null::uuid as to_warehouse_id,
    '検査記録'::text as movement_from,
    '在庫'::text as movement_to,
    flexcon.created_at
  from public.flexcon_inspection_flexcons as flexcon
  join public.flexcon_authorizations as auth_record on auth_record.id = flexcon.authorization_id
  left join public.workers as worker on worker.worker_id = flexcon.created_by_worker_id
),
inspection_paper_bags as (
  select
    'inspection-paper:' || paper.id::text as id,
    'inspection_paper_bag'::text as source_type,
    'inbound'::text as movement_type,
    coalesce(paper.purchase_date, paper.created_at::date) as movement_date,
    coalesce(worker.worker_name, '登録者不明') as worker_name,
    case
      when nullif(btrim(auth_record.prefecture), '') is null then '産地未登録'
      when right(btrim(auth_record.prefecture), 1) in ('都', '道', '府', '県') then btrim(auth_record.prefecture)
      else btrim(auth_record.prefecture) || '県'
    end as origin,
    coalesce(nullif(btrim(paper.brand), ''), '名称未登録') as product_name,
    coalesce(nullif(btrim(paper.grade), ''), '未入力') as grade,
    paper.bag_count::numeric as quantity,
    '袋'::text as unit,
    null::uuid as from_warehouse_id,
    null::uuid as to_warehouse_id,
    '検査記録'::text as movement_from,
    '在庫'::text as movement_to,
    paper.created_at
  from public.flexcon_inspection_paper_bags as paper
  join public.flexcon_authorizations as auth_record on auth_record.id = paper.authorization_id
  left join public.workers as worker on worker.worker_id = paper.created_by_worker_id
),
qr_shipments as (
  select
    'shipment-flexcon:' || shipment.id::text || ':' || item.flexcon_id::text as id,
    'shipment_flexcon'::text as source_type,
    'outbound'::text as movement_type,
    shipment.shipped_at::date as movement_date,
    coalesce(worker.worker_name, '登録者不明') as worker_name,
    case
      when nullif(btrim(item.origin_prefecture), '') is null then '産地未登録'
      when right(btrim(item.origin_prefecture), 1) in ('都', '道', '府', '県') then btrim(item.origin_prefecture)
      else btrim(item.origin_prefecture) || '県'
    end as origin,
    coalesce(nullif(btrim(item.product_name), ''), '名称未登録') as product_name,
    coalesce(nullif(btrim(item.grade), ''), '未入力') as grade,
    case when source.record_kind = 'bulk' then source.quantity_kg else 1::numeric end as quantity,
    case when source.record_kind = 'bulk' then 'kg' else '本' end as unit,
    null::uuid as from_warehouse_id,
    null::uuid as to_warehouse_id,
    '在庫'::text as movement_from,
    coalesce(nullif(btrim(destination.name), ''), '出荷') as movement_to,
    shipment.created_at
  from public.flexcon_shipments as shipment
  join public.flexcon_shipment_items as item on item.shipment_id = shipment.id
  join public.flexcon_destinations as destination on destination.id = shipment.destination_id
  left join public.workers as worker on worker.worker_id = shipment.created_by_worker_id
  left join lateral (
    select flexcon.record_kind, flexcon.quantity_kg
    from public.flexcon_inspection_flexcons as flexcon
    where flexcon.lot_number = item.lot_number
       or (char_length(flexcon.lot_number) = 11 and substring(flexcon.lot_number from 5) = item.lot_number)
       or (char_length(item.lot_number) = 11 and substring(item.lot_number from 5) = flexcon.lot_number)
    order by case when flexcon.lot_number = item.lot_number then 0 else 1 end, flexcon.updated_at desc
    limit 1
  ) as source on true
  where shipment.shipment_kind = 'qr_flexcon'
),
manual_shipments as (
  select
    'shipment-manual:' || item.id::text as id,
    'shipment_manual'::text as source_type,
    'outbound'::text as movement_type,
    shipment.shipped_at::date as movement_date,
    coalesce(worker.worker_name, '登録者不明') as worker_name,
    case
      when nullif(btrim(item.origin_prefecture), '') is null then '産地未登録'
      when right(btrim(item.origin_prefecture), 1) in ('都', '道', '府', '県') then btrim(item.origin_prefecture)
      else btrim(item.origin_prefecture) || '県'
    end as origin,
    coalesce(nullif(btrim(item.product_name), ''), '名称未登録') as product_name,
    case
      when shipment.shipment_kind = 'other_rice' then '対象外'
      else coalesce(nullif(btrim(item.grade), ''), '未入力')
    end as grade,
    item.quantity_count::numeric as quantity,
    case when shipment.shipment_kind = 'paper_bag' then '袋' else '本' end as unit,
    null::uuid as from_warehouse_id,
    null::uuid as to_warehouse_id,
    '在庫'::text as movement_from,
    coalesce(nullif(btrim(destination.name), ''), '出荷') as movement_to,
    shipment.created_at
  from public.flexcon_shipments as shipment
  join public.flexcon_manual_shipment_items as item on item.shipment_id = shipment.id
  join public.flexcon_destinations as destination on destination.id = shipment.destination_id
  left join public.workers as worker on worker.worker_id = shipment.created_by_worker_id
  where shipment.shipment_kind in ('paper_bag', 'other_rice')
)
select * from manual_movements
union all select * from inspection_flexcons
union all select * from inspection_paper_bags
union all select * from qr_shipments
union all select * from manual_shipments;

grant select on public.flexcon_inventory_ledger to anon, authenticated;

commit;

notify pgrst, 'reload schema';
