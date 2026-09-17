-- 手入力と仕切り書取込に共通の登録順を保存し、編集後も順番を維持します。

begin;

create sequence if not exists public.flexcon_inventory_registration_order_seq;

alter table public.flexcon_inventory_movements
  add column if not exists registration_order bigint;
alter table public.flexcon_purchase_statement_lines
  add column if not exists registration_order bigint;

create temporary table flexcon_inventory_order_backfill (
  source_type text not null,
  source_id uuid not null,
  registration_order bigint not null,
  primary key (source_type, source_id)
) on commit drop;

insert into flexcon_inventory_order_backfill (source_type, source_id, registration_order)
select source_type, source_id,
  row_number() over (
    order by created_at, source_type, settlement_no, detail_no, part_no, source_id
  )::bigint
from (
  select
    'manual'::text as source_type,
    movement.id as source_id,
    movement.created_at,
    ''::text as settlement_no,
    0::integer as detail_no,
    0::integer as part_no
  from public.flexcon_inventory_movements as movement
  where movement.registration_order is null
  union all
  select
    'settlement'::text,
    line.id,
    line.created_at,
    line.settlement_no,
    line.detail_no,
    line.part_no
  from public.flexcon_purchase_statement_lines as line
  where line.registration_order is null
) as existing;

update public.flexcon_inventory_movements as movement
set registration_order = backfill.registration_order
from flexcon_inventory_order_backfill as backfill
where backfill.source_type = 'manual' and backfill.source_id = movement.id;

update public.flexcon_purchase_statement_lines as line
set registration_order = backfill.registration_order
from flexcon_inventory_order_backfill as backfill
where backfill.source_type = 'settlement' and backfill.source_id = line.id;

select setval(
  'public.flexcon_inventory_registration_order_seq',
  greatest(coalesce((
    select max(registration_order) from (
      select registration_order from public.flexcon_inventory_movements
      union all
      select registration_order from public.flexcon_purchase_statement_lines
    ) as all_orders
  ), 0), 1),
  exists (
    select 1 from public.flexcon_inventory_movements where registration_order is not null
    union all
    select 1 from public.flexcon_purchase_statement_lines where registration_order is not null
  )
);

alter table public.flexcon_inventory_movements
  alter column registration_order set default nextval('public.flexcon_inventory_registration_order_seq'),
  alter column registration_order set not null;
alter table public.flexcon_purchase_statement_lines
  alter column registration_order set default nextval('public.flexcon_inventory_registration_order_seq'),
  alter column registration_order set not null;

create unique index if not exists flexcon_inventory_movements_registration_order_key
  on public.flexcon_inventory_movements (registration_order);
create unique index if not exists flexcon_purchase_statement_lines_registration_order_key
  on public.flexcon_purchase_statement_lines (registration_order);

create or replace function public.flexcon_import_purchase_statements(
  p_worker_id text,
  p_file_name text,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_batch_id uuid;
  v_record jsonb;
  v_settlement_count integer;
  v_line_count integer;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if nullif(btrim(coalesce(p_file_name, '')), '') is null then raise exception 'ファイル名を確認できません。'; end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) = 0 then raise exception '取込対象がありません。'; end if;

  for v_record in select value from jsonb_array_elements(p_records)
  loop
    if nullif(btrim(v_record->>'settlement_no'), '') is null then raise exception '仕切り書No.が空欄の明細があります。'; end if;
    if coalesce((v_record->>'detail_no')::integer, 0) <= 0 or coalesce((v_record->>'part_no')::integer, 0) <= 0 then raise exception '仕切り書の明細番号が不正です。'; end if;
    if coalesce((v_record->>'quantity')::numeric, 0) <= 0 then raise exception '数量が不正な明細があります。'; end if;
    if (v_record->>'unit') not in ('本', '袋', 'kg', '俵') then raise exception '単位が不正な明細があります。'; end if;
    if nullif(v_record->>'to_warehouse_id', '') is not null and not exists (
      select 1 from public.flexcon_inspection_options
      where id = (v_record->>'to_warehouse_id')::uuid and option_type = 'warehouse' and active = true
    ) then raise exception '仕切り書No.%の入庫先倉庫が利用できません。', v_record->>'settlement_no'; end if;
    if not exists (
      select 1 from public.flexcon_inspection_options
      where option_type = 'origin' and active = true and name = v_record->>'origin'
    ) then raise exception '産地「%」がマスタにありません。', v_record->>'origin'; end if;
    if not exists (
      select 1 from public.flexcon_inspection_options
      where active = true and name = v_record->>'product_name'
        and (
          option_type = 'shipment_product'
          or ((v_record->>'origin') = '青森県' and option_type in ('brand', 'brand_aomori'))
          or ((v_record->>'origin') = '岩手県' and option_type = 'brand_iwate')
        )
    ) then raise exception '名称「%」がマスタにありません。', v_record->>'product_name'; end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(p_records) as record
    group by record.value->>'settlement_no'
    having count(distinct coalesce(record.value->>'to_warehouse_id', '')) > 1
  ) then raise exception '同じ仕切り書No.には同じ入庫先倉庫を指定してください。'; end if;

  perform pg_advisory_xact_lock(hashtextextended(settlement_no, 0))
  from (
    select distinct value->>'settlement_no' as settlement_no
    from jsonb_array_elements(p_records)
  ) as locks
  order by hashtextextended(settlement_no, 0);

  insert into public.flexcon_purchase_import_batches (file_name, imported_by_worker_id, imported_by_worker_name)
  values (left(btrim(p_file_name), 255), v_worker.worker_id, v_worker.worker_name)
  returning id into v_batch_id;

  delete from public.flexcon_purchase_statement_lines
  where settlement_no in (select distinct value->>'settlement_no' from jsonb_array_elements(p_records));

  for v_record in
    select value from jsonb_array_elements(p_records) with ordinality as ordered(value, source_order)
    order by source_order
  loop
    insert into public.flexcon_purchase_statement_lines (
      batch_id, settlement_no, detail_no, part_no, source_import_id, crop_year, purchased_at,
      origin, raw_product_name, product_name, producer_name, raw_quantity, raw_unit,
      grade, quantity, unit, to_warehouse_id, to_warehouse_name
    )
    select
      v_batch_id,
      btrim(v_record->>'settlement_no'),
      (v_record->>'detail_no')::integer,
      (v_record->>'part_no')::integer,
      nullif(btrim(v_record->>'source_import_id'), ''),
      nullif(v_record->>'crop_year', '')::integer,
      (v_record->>'purchased_at')::timestamptz,
      btrim(v_record->>'origin'),
      btrim(v_record->>'raw_product_name'),
      btrim(v_record->>'product_name'),
      btrim(v_record->>'producer_name'),
      (v_record->>'raw_quantity')::numeric,
      btrim(v_record->>'raw_unit'),
      coalesce(nullif(btrim(v_record->>'grade'), ''), '未検査'),
      (v_record->>'quantity')::numeric,
      btrim(v_record->>'unit'),
      warehouse.id,
      coalesce(warehouse.name, '未指定')
    from (values (1)) as one(dummy)
    left join public.flexcon_inspection_options as warehouse
      on warehouse.id = nullif(v_record->>'to_warehouse_id', '')::uuid
     and warehouse.option_type = 'warehouse'
     and warehouse.active = true;
  end loop;

  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '取込後の在庫がマイナスになるため登録できません。既存の出庫・移動記録を確認してください。';
  end if;

  select count(distinct value->>'settlement_no'), count(*)
  into v_settlement_count, v_line_count
  from jsonb_array_elements(p_records);
  return jsonb_build_object('batch_id', v_batch_id, 'settlement_count', v_settlement_count, 'line_count', v_line_count);
end;
$$;

drop view if exists public.flexcon_inventory_ledger;
create view public.flexcon_inventory_ledger
with (security_invoker = true)
as
select
  movement.id::text as id,
  movement.registration_order,
  'manual'::text as source_type,
  case when movement.from_warehouse_id is null then 'inbound' when movement.to_warehouse_id is null then 'outbound' else 'transfer' end as movement_type,
  movement.movement_date,
  movement.worker_name,
  coalesce(movement.producer_name, '') as producer_name,
  ''::text as settlement_no,
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
union all
select
  line.id::text,
  line.registration_order,
  'settlement'::text,
  'settlement'::text,
  line.purchased_at::date,
  batch.imported_by_worker_name,
  line.producer_name,
  line.settlement_no,
  line.origin,
  line.product_name,
  line.grade,
  line.quantity,
  line.unit,
  null::uuid,
  line.to_warehouse_id,
  '仕切り書'::text,
  line.to_warehouse_name,
  line.created_at
from public.flexcon_purchase_statement_lines as line
join public.flexcon_purchase_import_batches as batch on batch.id = line.batch_id;

grant select on public.flexcon_inventory_ledger to anon, authenticated;

commit;

notify pgrst, 'reload schema';
