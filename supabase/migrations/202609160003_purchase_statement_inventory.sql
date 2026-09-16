-- 在庫を手動入出庫と仕切り書Excel取込を基礎にして再構成します。

begin;

alter table public.flexcon_inventory_movements
  add column if not exists producer_name text;

create table if not exists public.flexcon_purchase_import_batches (
  id uuid primary key default gen_random_uuid(),
  file_name text not null check (char_length(btrim(file_name)) between 1 and 255),
  imported_by_worker_id text not null references public.workers(worker_id),
  imported_by_worker_name text not null,
  imported_at timestamptz not null default now()
);

create table if not exists public.flexcon_purchase_statement_lines (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.flexcon_purchase_import_batches(id) on delete cascade,
  settlement_no text not null check (char_length(btrim(settlement_no)) between 1 and 80),
  detail_no integer not null check (detail_no > 0),
  part_no integer not null default 1 check (part_no > 0),
  source_import_id text,
  crop_year integer,
  purchased_at timestamptz not null,
  origin text not null,
  raw_product_name text not null,
  product_name text not null,
  producer_name text not null,
  raw_quantity numeric(14, 3) not null check (raw_quantity > 0),
  raw_unit text not null,
  grade text not null default '未検査',
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null check (unit in ('本', '袋', 'kg', '俵')),
  to_warehouse_id uuid not null references public.flexcon_inspection_options(id),
  to_warehouse_name text not null,
  created_at timestamptz not null default now(),
  unique (settlement_no, detail_no, part_no)
);

create index if not exists flexcon_purchase_statement_lines_date_idx
  on public.flexcon_purchase_statement_lines (purchased_at desc, settlement_no, detail_no, part_no);
create index if not exists flexcon_purchase_statement_lines_warehouse_idx
  on public.flexcon_purchase_statement_lines (to_warehouse_id, origin, product_name, grade, unit);

alter table public.flexcon_purchase_import_batches enable row level security;
alter table public.flexcon_purchase_statement_lines enable row level security;

drop policy if exists flexcon_read_purchase_import_batches on public.flexcon_purchase_import_batches;
create policy flexcon_read_purchase_import_batches on public.flexcon_purchase_import_batches
  for select to anon, authenticated using (true);
drop policy if exists flexcon_read_purchase_statement_lines on public.flexcon_purchase_statement_lines;
create policy flexcon_read_purchase_statement_lines on public.flexcon_purchase_statement_lines
  for select to anon, authenticated using (true);

create or replace function public.flexcon_validate_inventory_selection(
  p_origin text,
  p_product_name text,
  p_grade text,
  p_quantity numeric,
  p_unit text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_other_rice boolean;
begin
  if not exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'origin' and active = true and name = p_origin
  ) then raise exception '産地をマスタから選択してください。'; end if;

  select exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'shipment_product' and active = true and name = p_product_name
  ) into v_is_other_rice;

  if not v_is_other_rice and not exists (
    select 1 from public.flexcon_inspection_options
    where active = true and name = p_product_name
      and ((p_origin = '青森県' and option_type in ('brand', 'brand_aomori'))
        or (p_origin = '岩手県' and option_type = 'brand_iwate'))
  ) then raise exception '名称をマスタから選択してください。'; end if;

  if v_is_other_rice then
    if p_grade <> '' then raise exception '銘柄米以外の種類に等級は入力できません。'; end if;
  elsif p_grade <> '未検査' then
    if not exists (
      select 1 from public.flexcon_inspection_options
      where option_type = 'grade' and active = true and name = p_grade
    ) then raise exception '等級をマスタから選択してください。'; end if;
    if p_product_name = '飼料用玄米' and p_grade <> '合格' then raise exception '飼料用玄米の等級は合格を選択してください。'; end if;
    if p_product_name <> '飼料用玄米' and p_grade = '合格' then raise exception '飼料用玄米以外では合格を選択できません。'; end if;
  end if;

  if p_quantity is null or p_quantity <= 0 then raise exception '量は0より大きい数値で入力してください。'; end if;
  if p_unit not in ('本', '袋', 'kg') then raise exception '単位を本・袋・kgから選択してください。'; end if;
end;
$$;

drop function if exists public.flexcon_add_inventory_movement(text, date, text, text, text, numeric, text, uuid, uuid);
drop function if exists public.flexcon_update_inventory_movement(text, uuid, date, text, text, text, numeric, text, uuid, uuid);

create function public.flexcon_add_inventory_movement(
  p_worker_id text,
  p_movement_date date,
  p_producer_name text,
  p_origin text,
  p_product_name text,
  p_grade text,
  p_quantity numeric,
  p_unit text,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_producer_name text := btrim(coalesce(p_producer_name, ''));
  v_origin text := btrim(coalesce(p_origin, ''));
  v_product_name text := btrim(coalesce(p_product_name, ''));
  v_grade text := btrim(coalesce(p_grade, ''));
  v_unit text := btrim(coalesce(p_unit, ''));
  v_from_name text := '外部';
  v_to_name text := '外部';
  v_available numeric(14, 3);
  v_movement_id uuid;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if p_movement_date is null then raise exception '日付を入力してください。'; end if;
  if p_from_warehouse_id is null and nullif(v_producer_name, '') is null then
    raise exception '手動入庫では生産者名を入力してください。';
  end if;
  if char_length(v_producer_name) > 120 then raise exception '生産者名は120文字以内で入力してください。'; end if;
  perform public.flexcon_validate_inventory_selection(v_origin, v_product_name, v_grade, p_quantity, v_unit);
  if p_from_warehouse_id is null and p_to_warehouse_id is null then raise exception '移動元または移動先の倉庫を選択してください。'; end if;
  if p_from_warehouse_id is not null and p_from_warehouse_id = p_to_warehouse_id then raise exception '移動元と移動先には別の倉庫を選択してください。'; end if;

  if p_from_warehouse_id is not null then
    select name into v_from_name from public.flexcon_inspection_options
    where id = p_from_warehouse_id and option_type = 'warehouse';
    if v_from_name is null then raise exception '移動元の倉庫が見つかりません。'; end if;
  end if;
  if p_to_warehouse_id is not null then
    select name into v_to_name from public.flexcon_inspection_options
    where id = p_to_warehouse_id and option_type = 'warehouse' and active = true;
    if v_to_name is null then raise exception '移動先の倉庫は利用できません。'; end if;
  end if;

  if p_from_warehouse_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(concat_ws(chr(31), p_from_warehouse_id::text, v_origin, v_product_name, v_grade, v_unit), 0));
    select coalesce(sum(case when to_warehouse_id = p_from_warehouse_id then quantity when from_warehouse_id = p_from_warehouse_id then -quantity else 0 end), 0)::numeric(14, 3)
    into v_available from public.flexcon_inventory_movements
    where (to_warehouse_id = p_from_warehouse_id or from_warehouse_id = p_from_warehouse_id)
      and origin = v_origin and product_name = v_product_name and grade = v_grade and unit = v_unit;
    v_available := v_available + coalesce((
      select sum(line.quantity) from public.flexcon_purchase_statement_lines as line
      where line.to_warehouse_id = p_from_warehouse_id and line.origin = v_origin
        and line.product_name = v_product_name and line.grade = v_grade and line.unit = v_unit
    ), 0);
    if v_available < p_quantity then
      raise exception '移動元の在庫が不足しています。在庫 % % に対して、% % は出庫できません。', v_available, v_unit, p_quantity, v_unit;
    end if;
  end if;

  insert into public.flexcon_inventory_movements (
    movement_date, worker_id, worker_name, producer_name, origin, product_name, grade, quantity, unit,
    from_warehouse_id, to_warehouse_id, movement_from, movement_to
  ) values (
    p_movement_date, v_worker.worker_id, v_worker.worker_name, nullif(v_producer_name, ''), v_origin, v_product_name, v_grade,
    round(p_quantity, 3), v_unit, p_from_warehouse_id, p_to_warehouse_id, v_from_name, v_to_name
  ) returning id into v_movement_id;
  return v_movement_id;
end;
$$;

create function public.flexcon_update_inventory_movement(
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
  p_to_warehouse_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.flexcon_inventory_movements%rowtype;
  v_producer_name text := btrim(coalesce(p_producer_name, ''));
  v_origin text := btrim(coalesce(p_origin, ''));
  v_product_name text := btrim(coalesce(p_product_name, ''));
  v_grade text := btrim(coalesce(p_grade, ''));
  v_unit text := btrim(coalesce(p_unit, ''));
  v_from_name text := '外部';
  v_to_name text := '外部';
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  select * into v_current from public.flexcon_inventory_movements where id = p_movement_id for update;
  if v_current.id is null then raise exception '入出庫記録が見つかりません。'; end if;
  if p_movement_date is null then raise exception '日付を入力してください。'; end if;
  if p_from_warehouse_id is null and nullif(v_producer_name, '') is null then raise exception '手動入庫では生産者名を入力してください。'; end if;
  if char_length(v_producer_name) > 120 then raise exception '生産者名は120文字以内で入力してください。'; end if;
  perform public.flexcon_validate_inventory_selection(v_origin, v_product_name, v_grade, p_quantity, v_unit);
  if p_from_warehouse_id is null and p_to_warehouse_id is null then raise exception '移動元または移動先の倉庫を選択してください。'; end if;
  if p_from_warehouse_id is not null and p_from_warehouse_id = p_to_warehouse_id then raise exception '移動元と移動先には別の倉庫を選択してください。'; end if;

  if p_from_warehouse_id is not null then
    select name into v_from_name from public.flexcon_inspection_options where id = p_from_warehouse_id and option_type = 'warehouse';
    if v_from_name is null then raise exception '移動元の倉庫が見つかりません。'; end if;
  end if;
  if p_to_warehouse_id is not null then
    select name into v_to_name from public.flexcon_inspection_options where id = p_to_warehouse_id and option_type = 'warehouse' and active = true;
    if v_to_name is null then raise exception '移動先の倉庫は利用できません。'; end if;
  end if;

  update public.flexcon_inventory_movements
  set movement_date = p_movement_date,
      producer_name = nullif(v_producer_name, ''),
      origin = v_origin,
      product_name = v_product_name,
      grade = v_grade,
      quantity = round(p_quantity, 3),
      unit = v_unit,
      from_warehouse_id = p_from_warehouse_id,
      to_warehouse_id = p_to_warehouse_id,
      movement_from = v_from_name,
      movement_to = v_to_name
  where id = p_movement_id;

  if exists (
    select 1 from public.flexcon_inventory_balances where quantity < 0
  ) then
    raise exception 'この変更を保存すると倉庫在庫が不足するため、編集できません。';
  end if;
end;
$$;

create or replace function public.flexcon_import_purchase_statements(
  p_worker_id text,
  p_file_name text,
  p_to_warehouse_id uuid,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_warehouse_name text;
  v_batch_id uuid;
  v_record jsonb;
  v_settlement_count integer;
  v_line_count integer;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if nullif(btrim(coalesce(p_file_name, '')), '') is null then raise exception 'ファイル名を確認できません。'; end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) = 0 then raise exception '取込対象がありません。'; end if;
  select name into v_warehouse_name from public.flexcon_inspection_options
  where id = p_to_warehouse_id and option_type = 'warehouse' and active = true;
  if v_warehouse_name is null then raise exception '入庫先倉庫を選択してください。'; end if;

  for v_record in select value from jsonb_array_elements(p_records)
  loop
    if nullif(btrim(v_record->>'settlement_no'), '') is null then raise exception '仕切り書Noが空欄の明細があります。'; end if;
    if coalesce((v_record->>'detail_no')::integer, 0) <= 0 or coalesce((v_record->>'part_no')::integer, 0) <= 0 then raise exception '仕切り書の明細番号が不正です。'; end if;
    if coalesce((v_record->>'quantity')::numeric, 0) <= 0 then raise exception '数量が不正な明細があります。'; end if;
    if (v_record->>'unit') not in ('本', '袋', 'kg', '俵') then raise exception '単位が不正な明細があります。'; end if;
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

  insert into public.flexcon_purchase_import_batches (file_name, imported_by_worker_id, imported_by_worker_name)
  values (left(btrim(p_file_name), 255), v_worker.worker_id, v_worker.worker_name)
  returning id into v_batch_id;

  delete from public.flexcon_purchase_statement_lines
  where settlement_no in (select distinct value->>'settlement_no' from jsonb_array_elements(p_records));

  insert into public.flexcon_purchase_statement_lines (
    batch_id, settlement_no, detail_no, part_no, source_import_id, crop_year, purchased_at,
    origin, raw_product_name, product_name, producer_name, raw_quantity, raw_unit,
    grade, quantity, unit, to_warehouse_id, to_warehouse_name
  )
  select
    v_batch_id,
    btrim(value->>'settlement_no'),
    (value->>'detail_no')::integer,
    (value->>'part_no')::integer,
    nullif(btrim(value->>'source_import_id'), ''),
    nullif(value->>'crop_year', '')::integer,
    (value->>'purchased_at')::timestamptz,
    btrim(value->>'origin'),
    btrim(value->>'raw_product_name'),
    btrim(value->>'product_name'),
    btrim(value->>'producer_name'),
    (value->>'raw_quantity')::numeric,
    btrim(value->>'raw_unit'),
    coalesce(nullif(btrim(value->>'grade'), ''), '未検査'),
    (value->>'quantity')::numeric,
    btrim(value->>'unit'),
    p_to_warehouse_id,
    v_warehouse_name
  from jsonb_array_elements(p_records);

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

drop view if exists public.flexcon_inventory_balances;
create view public.flexcon_inventory_balances
with (security_invoker = true)
as
select
  inventory_delta.warehouse_id,
  warehouse.name as warehouse_name,
  inventory_delta.origin,
  inventory_delta.product_name,
  inventory_delta.grade,
  inventory_delta.unit,
  sum(inventory_delta.quantity_delta)::numeric(14, 3) as quantity
from (
  select movement.to_warehouse_id as warehouse_id, movement.origin, movement.product_name, movement.grade, movement.unit, movement.quantity as quantity_delta
  from public.flexcon_inventory_movements as movement where movement.to_warehouse_id is not null
  union all
  select movement.from_warehouse_id, movement.origin, movement.product_name, movement.grade, movement.unit, -movement.quantity
  from public.flexcon_inventory_movements as movement where movement.from_warehouse_id is not null
  union all
  select line.to_warehouse_id, line.origin, line.product_name, line.grade, line.unit, line.quantity
  from public.flexcon_purchase_statement_lines as line
) as inventory_delta
join public.flexcon_inspection_options as warehouse on warehouse.id = inventory_delta.warehouse_id and warehouse.option_type = 'warehouse'
group by inventory_delta.warehouse_id, warehouse.name, inventory_delta.origin, inventory_delta.product_name, inventory_delta.grade, inventory_delta.unit
having sum(inventory_delta.quantity_delta) <> 0;

create or replace function public.flexcon_delete_inventory_movement(
  p_worker_id text,
  p_movement_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  if not exists (select 1 from public.flexcon_inventory_movements where id = p_movement_id) then
    raise exception '入出庫記録が見つかりません。';
  end if;
  delete from public.flexcon_inventory_movements where id = p_movement_id;
  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception 'この記録を削除すると倉庫在庫が不足するため、削除できません。先に後続の出庫・移動記録を修正してください。';
  end if;
end;
$$;

grant select on public.flexcon_purchase_import_batches, public.flexcon_purchase_statement_lines, public.flexcon_inventory_ledger, public.flexcon_inventory_balances to anon, authenticated;
revoke all on function public.flexcon_add_inventory_movement(text, date, text, text, text, text, numeric, text, uuid, uuid) from public;
revoke all on function public.flexcon_update_inventory_movement(text, uuid, date, text, text, text, text, numeric, text, uuid, uuid) from public;
revoke all on function public.flexcon_import_purchase_statements(text, text, uuid, jsonb) from public;
revoke all on function public.flexcon_delete_inventory_movement(text, uuid) from public;
grant execute on function public.flexcon_add_inventory_movement(text, date, text, text, text, text, numeric, text, uuid, uuid) to anon, authenticated;
grant execute on function public.flexcon_update_inventory_movement(text, uuid, date, text, text, text, text, numeric, text, uuid, uuid) to anon, authenticated;
grant execute on function public.flexcon_import_purchase_statements(text, text, uuid, jsonb) to anon, authenticated;
grant execute on function public.flexcon_delete_inventory_movement(text, uuid) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
