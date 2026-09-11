-- 在庫の入出庫記録と倉庫別在庫に等級を追加します。

begin;

alter table public.flexcon_inventory_movements
  add column if not exists grade text not null default ''
  check (char_length(btrim(grade)) <= 120);

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
  from public.flexcon_inventory_movements as movement
  where movement.to_warehouse_id is not null
  union all
  select movement.from_warehouse_id as warehouse_id, movement.origin, movement.product_name, movement.grade, movement.unit, -movement.quantity as quantity_delta
  from public.flexcon_inventory_movements as movement
  where movement.from_warehouse_id is not null
) as inventory_delta
join public.flexcon_inspection_options as warehouse
  on warehouse.id = inventory_delta.warehouse_id and warehouse.option_type = 'warehouse'
group by inventory_delta.warehouse_id, warehouse.name, inventory_delta.origin, inventory_delta.product_name, inventory_delta.grade, inventory_delta.unit
having sum(inventory_delta.quantity_delta) <> 0;

drop function if exists public.flexcon_add_inventory_movement(text, date, text, text, numeric, text, uuid, uuid);

create or replace function public.flexcon_add_inventory_movement(
  p_worker_id text,
  p_movement_date date,
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
  if not exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'origin' and active = true and name = v_origin
  ) then
    raise exception '産地をマスタから選択してください。';
  end if;
  if not exists (
    select 1 from public.flexcon_inspection_options
    where active = true
      and name = v_product_name
      and (
        option_type = 'shipment_product'
        or (v_origin = '青森県' and option_type in ('brand', 'brand_aomori'))
        or (v_origin = '岩手県' and option_type = 'brand_iwate')
      )
  ) then
    raise exception '名称をマスタから選択してください。';
  end if;
  if not exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'grade' and active = true and name = v_grade
  ) then
    raise exception '等級をマスタから選択してください。';
  end if;
  if v_product_name = '飼料用玄米' and v_grade <> '合格' then
    raise exception '飼料用玄米の等級は合格を選択してください。';
  end if;
  if v_product_name <> '飼料用玄米' and v_grade = '合格' then
    raise exception '飼料用玄米以外では合格を選択できません。';
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception '量は0より大きい数値で入力してください。'; end if;
  if v_unit not in ('本', '袋', 'kg') then raise exception '単位を本・袋・kgから選択してください。'; end if;
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
    perform pg_advisory_xact_lock(hashtextextended(concat_ws(chr(31), p_from_warehouse_id::text, v_origin, v_product_name, v_grade, v_unit), 0));
    select coalesce(sum(case when movement.to_warehouse_id = p_from_warehouse_id then movement.quantity when movement.from_warehouse_id = p_from_warehouse_id then -movement.quantity else 0 end), 0)::numeric(14, 3)
    into v_available
    from public.flexcon_inventory_movements as movement
    where (movement.to_warehouse_id = p_from_warehouse_id or movement.from_warehouse_id = p_from_warehouse_id)
      and movement.origin = v_origin and movement.product_name = v_product_name and movement.grade = v_grade and movement.unit = v_unit;
    if v_available < p_quantity then
      raise exception '移動元の在庫が不足しています。在庫 % % に対して、% % は出庫できません。', v_available, v_unit, p_quantity, v_unit;
    end if;
  end if;

  insert into public.flexcon_inventory_movements (
    movement_date, worker_id, worker_name, origin, product_name, grade, quantity, unit,
    from_warehouse_id, to_warehouse_id, movement_from, movement_to
  ) values (
    p_movement_date, v_worker.worker_id, v_worker.worker_name, v_origin, v_product_name, v_grade,
    round(p_quantity, 3), v_unit, p_from_warehouse_id, p_to_warehouse_id, v_from_name, v_to_name
  ) returning id into v_movement_id;
  return v_movement_id;
end;
$$;

grant select on public.flexcon_inventory_balances to anon, authenticated;
revoke all on function public.flexcon_add_inventory_movement(text, date, text, text, text, numeric, text, uuid, uuid) from public;
grant execute on function public.flexcon_add_inventory_movement(text, date, text, text, text, numeric, text, uuid, uuid) to anon, authenticated;

commit;
