-- 米穀の入庫・出庫・倉庫間移動と、倉庫別在庫集計を追加します。

begin;

create table if not exists public.flexcon_inventory_movements (
  id uuid primary key default gen_random_uuid(),
  movement_date date not null,
  worker_id text not null references public.workers(worker_id),
  worker_name text not null check (char_length(btrim(worker_name)) between 1 and 120),
  origin text not null check (char_length(btrim(origin)) between 1 and 120),
  product_name text not null check (char_length(btrim(product_name)) between 1 and 120),
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null check (char_length(btrim(unit)) between 1 and 20),
  from_warehouse_id uuid references public.flexcon_inspection_options(id),
  to_warehouse_id uuid references public.flexcon_inspection_options(id),
  movement_from text not null check (char_length(btrim(movement_from)) between 1 and 120),
  movement_to text not null check (char_length(btrim(movement_to)) between 1 and 120),
  created_at timestamptz not null default now(),
  constraint flexcon_inventory_movement_route_check check (
    (from_warehouse_id is not null or to_warehouse_id is not null)
    and (from_warehouse_id is null or to_warehouse_id is null or from_warehouse_id <> to_warehouse_id)
  )
);

create index if not exists flexcon_inventory_movements_date_idx
  on public.flexcon_inventory_movements (movement_date desc, created_at desc);
create index if not exists flexcon_inventory_movements_from_idx
  on public.flexcon_inventory_movements (from_warehouse_id, origin, product_name, unit);
create index if not exists flexcon_inventory_movements_to_idx
  on public.flexcon_inventory_movements (to_warehouse_id, origin, product_name, unit);

alter table public.flexcon_inventory_movements enable row level security;

drop policy if exists flexcon_read_inventory_movements on public.flexcon_inventory_movements;
create policy flexcon_read_inventory_movements on public.flexcon_inventory_movements
  for select to anon, authenticated using (true);

create or replace view public.flexcon_inventory_balances
with (security_invoker = true)
as
select
  inventory_delta.warehouse_id,
  warehouse.name as warehouse_name,
  inventory_delta.origin,
  inventory_delta.product_name,
  inventory_delta.unit,
  sum(inventory_delta.quantity_delta)::numeric(14, 3) as quantity
from (
  select movement.to_warehouse_id as warehouse_id, movement.origin, movement.product_name, movement.unit, movement.quantity as quantity_delta
  from public.flexcon_inventory_movements as movement
  where movement.to_warehouse_id is not null
  union all
  select movement.from_warehouse_id as warehouse_id, movement.origin, movement.product_name, movement.unit, -movement.quantity as quantity_delta
  from public.flexcon_inventory_movements as movement
  where movement.from_warehouse_id is not null
) as inventory_delta
join public.flexcon_inspection_options as warehouse
  on warehouse.id = inventory_delta.warehouse_id and warehouse.option_type = 'warehouse'
group by inventory_delta.warehouse_id, warehouse.name, inventory_delta.origin, inventory_delta.product_name, inventory_delta.unit
having sum(inventory_delta.quantity_delta) <> 0;

create or replace function public.flexcon_add_inventory_movement(
  p_worker_id text,
  p_movement_date date,
  p_origin text,
  p_product_name text,
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
  v_origin text := btrim(coalesce(p_origin, ''));
  v_product_name text := btrim(coalesce(p_product_name, ''));
  v_unit text := btrim(coalesce(p_unit, ''));
  v_from_name text := '外部';
  v_to_name text := '外部';
  v_available numeric(14, 3);
  v_movement_id uuid;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);

  if p_movement_date is null then raise exception '日付を入力してください。'; end if;
  if char_length(v_origin) not between 1 and 120 then raise exception '産地を1文字から120文字で入力してください。'; end if;
  if char_length(v_product_name) not between 1 and 120 then raise exception '名称を1文字から120文字で入力してください。'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception '量は0より大きい数値で入力してください。'; end if;
  if char_length(v_unit) not between 1 and 20 then raise exception '単位を1文字から20文字で入力してください。'; end if;
  if p_from_warehouse_id is null and p_to_warehouse_id is null then raise exception '移動元または移動先の倉庫を選択してください。'; end if;
  if p_from_warehouse_id is not null and p_from_warehouse_id = p_to_warehouse_id then raise exception '移動元と移動先には別の倉庫を選択してください。'; end if;

  if p_from_warehouse_id is not null then
    select warehouse.name into v_from_name
    from public.flexcon_inspection_options as warehouse
    where warehouse.id = p_from_warehouse_id and warehouse.option_type = 'warehouse';
    if v_from_name is null then raise exception '移動元の倉庫が見つかりません。'; end if;
  end if;

  if p_to_warehouse_id is not null then
    select warehouse.name into v_to_name
    from public.flexcon_inspection_options as warehouse
    where warehouse.id = p_to_warehouse_id and warehouse.option_type = 'warehouse' and warehouse.active = true;
    if v_to_name is null then raise exception '移動先の倉庫は利用できません。'; end if;
  end if;

  if p_from_warehouse_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(concat_ws(chr(31), p_from_warehouse_id::text, v_origin, v_product_name, v_unit), 0));
    select coalesce(sum(case when movement.to_warehouse_id = p_from_warehouse_id then movement.quantity when movement.from_warehouse_id = p_from_warehouse_id then -movement.quantity else 0 end), 0)::numeric(14, 3)
    into v_available
    from public.flexcon_inventory_movements as movement
    where (movement.to_warehouse_id = p_from_warehouse_id or movement.from_warehouse_id = p_from_warehouse_id)
      and movement.origin = v_origin and movement.product_name = v_product_name and movement.unit = v_unit;
    if v_available < p_quantity then
      raise exception '移動元の在庫が不足しています。在庫 % % に対して、% % は出庫できません。', v_available, v_unit, p_quantity, v_unit;
    end if;
  end if;

  insert into public.flexcon_inventory_movements (
    movement_date, worker_id, worker_name, origin, product_name, quantity, unit,
    from_warehouse_id, to_warehouse_id, movement_from, movement_to
  ) values (
    p_movement_date, v_worker.worker_id, v_worker.worker_name, v_origin, v_product_name,
    round(p_quantity, 3), v_unit, p_from_warehouse_id, p_to_warehouse_id, v_from_name, v_to_name
  ) returning id into v_movement_id;
  return v_movement_id;
end;
$$;

grant select on public.flexcon_inventory_movements, public.flexcon_inventory_balances to anon, authenticated;
revoke all on function public.flexcon_add_inventory_movement(text, date, text, text, numeric, text, uuid, uuid) from public;
grant execute on function public.flexcon_add_inventory_movement(text, date, text, text, numeric, text, uuid, uuid) to anon, authenticated;

commit;
