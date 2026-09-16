-- 在庫入出庫記録を、削除後の在庫不足を防ぎながら削除できるようにします。

begin;

create or replace function public.flexcon_delete_inventory_movement(
  p_worker_id text,
  p_movement_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.flexcon_inventory_movements%rowtype;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select * into v_current
  from public.flexcon_inventory_movements
  where id = p_movement_id
  for update;

  if v_current.id is null then
    raise exception '入出庫記録が見つかりません。';
  end if;

  perform pg_advisory_xact_lock(lock_key)
  from (
    select distinct hashtextextended(
      concat_ws(chr(31), warehouse_id::text, v_current.origin, v_current.product_name, v_current.grade, v_current.unit),
      0
    ) as lock_key
    from (values (v_current.from_warehouse_id), (v_current.to_warehouse_id)) as affected(warehouse_id)
    where warehouse_id is not null
  ) as locks
  order by lock_key;

  delete from public.flexcon_inventory_movements
  where id = v_current.id;

  if exists (
    select 1
    from (values (v_current.from_warehouse_id), (v_current.to_warehouse_id)) as affected(warehouse_id)
    cross join lateral (
      select coalesce(sum(
        case
          when movement.to_warehouse_id = affected.warehouse_id then movement.quantity
          when movement.from_warehouse_id = affected.warehouse_id then -movement.quantity
          else 0
        end
      ), 0) as balance
      from public.flexcon_inventory_movements as movement
      where (movement.to_warehouse_id = affected.warehouse_id or movement.from_warehouse_id = affected.warehouse_id)
        and movement.origin = v_current.origin
        and movement.product_name = v_current.product_name
        and movement.grade = v_current.grade
        and movement.unit = v_current.unit
    ) as stock
    where affected.warehouse_id is not null
      and stock.balance < 0
  ) then
    raise exception 'この記録を削除すると倉庫在庫が不足するため、削除できません。先に後続の出庫・移動記録を修正してください。';
  end if;
end;
$$;

revoke all on function public.flexcon_delete_inventory_movement(text, uuid) from public;
grant execute on function public.flexcon_delete_inventory_movement(text, uuid) to anon, authenticated;

commit;
