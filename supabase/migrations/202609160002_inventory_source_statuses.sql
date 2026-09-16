-- 検査記録と出荷履歴を、在庫画面の状態別数量として集計します。

begin;

create or replace view public.flexcon_inventory_source_statuses
with (security_invoker = true)
as
with inspection_flexcons as (
  select
    flexcon.fiscal_year,
    case
      when nullif(btrim(authorization.prefecture), '') is null then '産地未登録'
      when right(btrim(authorization.prefecture), 1) in ('都', '道', '府', '県') then btrim(authorization.prefecture)
      else btrim(authorization.prefecture) || '県'
    end as origin,
    coalesce(nullif(btrim(flexcon.brand), ''), '名称未登録') as product_name,
    coalesce(nullif(btrim(flexcon.grade), ''), '未入力') as grade,
    case when
      flexcon.fiscal_year > 0
      and flexcon.purchase_date is not null
      and flexcon.inspection_date is not null
      and nullif(btrim(flexcon.inspector_name), '') is not null
      and nullif(btrim(flexcon.inspection_location), '') is not null
      and nullif(btrim(flexcon.brand), '') is not null
      and flexcon.quantity_kg > 0
      and flexcon.moisture is not null
      and nullif(btrim(flexcon.grade), '') is not null
      and ((btrim(flexcon.brand) = '飼料用玄米' and btrim(flexcon.grade) = '合格')
        or (btrim(flexcon.brand) <> '飼料用玄米' and btrim(flexcon.grade) <> '合格'))
      and (btrim(flexcon.grade) in ('1等', '合格') or nullif(btrim(flexcon.reason), '') is not null)
      then '検査' else '未検査'
    end as status,
    case when flexcon.record_kind = 'bulk' then flexcon.quantity_kg::numeric else 1::numeric end as quantity,
    case when flexcon.record_kind = 'bulk' then 'kg' else '本' end as unit
  from public.flexcon_inspection_flexcons as flexcon
  join public.flexcon_authorizations as authorization on authorization.id = flexcon.authorization_id
),
inspection_paper_bags as (
  select
    paper.fiscal_year,
    case
      when nullif(btrim(authorization.prefecture), '') is null then '産地未登録'
      when right(btrim(authorization.prefecture), 1) in ('都', '道', '府', '県') then btrim(authorization.prefecture)
      else btrim(authorization.prefecture) || '県'
    end as origin,
    coalesce(nullif(btrim(paper.brand), ''), '名称未登録') as product_name,
    coalesce(nullif(btrim(paper.grade), ''), '未入力') as grade,
    case when
      paper.fiscal_year > 0
      and paper.purchase_date is not null
      and paper.inspection_date is not null
      and nullif(btrim(paper.inspector_name), '') is not null
      and nullif(btrim(paper.inspection_location), '') is not null
      and nullif(btrim(paper.brand), '') is not null
      and paper.bag_count > 0
      and paper.moisture is not null
      and nullif(btrim(paper.grade), '') is not null
      and ((btrim(paper.brand) = '飼料用玄米' and btrim(paper.grade) = '合格')
        or (btrim(paper.brand) <> '飼料用玄米' and btrim(paper.grade) <> '合格'))
      and (btrim(paper.grade) in ('1等', '合格') or nullif(btrim(paper.reason), '') is not null)
      then '検査' else '未検査'
    end as status,
    paper.bag_count::numeric as quantity,
    '袋'::text as unit
  from public.flexcon_inspection_paper_bags as paper
  join public.flexcon_authorizations as authorization on authorization.id = paper.authorization_id
),
qr_shipments as (
  select
    coalesce(source.fiscal_year, extract(year from shipment.shipped_at)::integer) as fiscal_year,
    case
      when nullif(btrim(item.origin_prefecture), '') is null then '産地未登録'
      when right(btrim(item.origin_prefecture), 1) in ('都', '道', '府', '県') then btrim(item.origin_prefecture)
      else btrim(item.origin_prefecture) || '県'
    end as origin,
    coalesce(nullif(btrim(item.product_name), ''), '名称未登録') as product_name,
    coalesce(nullif(btrim(item.grade), ''), '未入力') as grade,
    '出荷'::text as status,
    case when source.record_kind = 'bulk' then source.quantity_kg else 1::numeric end as quantity,
    case when source.record_kind = 'bulk' then 'kg' else '本' end as unit
  from public.flexcon_shipments as shipment
  join public.flexcon_shipment_items as item on item.shipment_id = shipment.id
  left join lateral (
    select flexcon.fiscal_year, flexcon.record_kind, flexcon.quantity_kg
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
    extract(year from shipment.shipped_at)::integer as fiscal_year,
    case
      when nullif(btrim(item.origin_prefecture), '') is null then '産地未登録'
      when right(btrim(item.origin_prefecture), 1) in ('都', '道', '府', '県') then btrim(item.origin_prefecture)
      else btrim(item.origin_prefecture) || '県'
    end as origin,
    coalesce(nullif(btrim(item.product_name), ''), '名称未登録') as product_name,
    coalesce(nullif(btrim(item.grade), ''), '対象外') as grade,
    '出荷'::text as status,
    item.quantity_count::numeric as quantity,
    case when shipment.shipment_kind = 'paper_bag' then '袋' else '本' end as unit
  from public.flexcon_shipments as shipment
  join public.flexcon_manual_shipment_items as item on item.shipment_id = shipment.id
  where shipment.shipment_kind in ('paper_bag', 'other_rice')
),
all_statuses as (
  select * from inspection_flexcons
  union all select * from inspection_paper_bags
  union all select * from qr_shipments
  union all select * from manual_shipments
)
select
  fiscal_year,
  origin,
  product_name,
  grade,
  status,
  sum(quantity)::numeric(14, 3) as quantity,
  unit
from all_statuses
group by fiscal_year, origin, product_name, grade, status, unit
having sum(quantity) <> 0;

grant select on public.flexcon_inventory_source_statuses to anon, authenticated;

commit;

notify pgrst, 'reload schema';
