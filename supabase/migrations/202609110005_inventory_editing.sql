-- 銘柄米以外の等級省略と、在庫入出庫記録の編集を追加します。

begin;

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
  ) then
    raise exception '産地をマスタから選択してください。';
  end if;

  select exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'shipment_product' and active = true and name = p_product_name
  ) into v_is_other_rice;

  if not v_is_other_rice and not exists (
    select 1 from public.flexcon_inspection_options
    where active = true
      and name = p_product_name
      and (
        (p_origin = '青森県' and option_type in ('brand', 'brand_aomori'))
        or (p_origin = '岩手県' and option_type = 'brand_iwate')
      )
  ) then
    raise exception '名称をマスタから選択してください。';
  end if;

  if v_is_other_rice then
    if p_grade <> '' then raise exception '銘柄米以外の種類に等級は入力できません。'; end if;
  else
    if not exists (
      select 1 from public.flexcon_inspection_options
      where option_type = 'grade' and active = true and name = p_grade
    ) then
      raise exception '等級をマスタから選択してください。';
    end if;
    if p_product_name = '飼料用玄米' and p_grade <> '合格' then
      raise exception '飼料用玄米の等級は合格を選択してください。';
    end if;
    if p_product_name <> '飼料用玄米' and p_grade = '合格' then
      raise exception '飼料用玄米以外では合格を選択できません。';
    end if;
  end if;

  if p_quantity is null or p_quantity <= 0 then raise exception '量は0より大きい数値で入力してください。'; end if;
  if p_unit not in ('本', '袋', 'kg') then raise exception '単位を本・袋・kgから選択してください。'; end if;
end;
$$;

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

create or replace function public.flexcon_update_inventory_movement(
  p_worker_id text,
  p_movement_id uuid,
  p_movement_date date,
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

  perform pg_advisory_xact_lock(lock_key)
  from (
    select distinct hashtextextended(concat_ws(chr(31), warehouse_id::text, origin, product_name, grade, unit), 0) as lock_key
    from (values
      (v_current.from_warehouse_id, v_current.origin, v_current.product_name, v_current.grade, v_current.unit),
      (v_current.to_warehouse_id, v_current.origin, v_current.product_name, v_current.grade, v_current.unit),
      (p_from_warehouse_id, v_origin, v_product_name, v_grade, v_unit),
      (p_to_warehouse_id, v_origin, v_product_name, v_grade, v_unit)
    ) as affected(warehouse_id, origin, product_name, grade, unit)
    where warehouse_id is not null
  ) as locks
  order by lock_key;

  update public.flexcon_inventory_movements
  set movement_date = p_movement_date,
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
    select 1
    from (
      select distinct warehouse_id, origin, product_name, grade, unit
      from (values
        (v_current.from_warehouse_id, v_current.origin, v_current.product_name, v_current.grade, v_current.unit),
        (v_current.to_warehouse_id, v_current.origin, v_current.product_name, v_current.grade, v_current.unit),
        (p_from_warehouse_id, v_origin, v_product_name, v_grade, v_unit),
        (p_to_warehouse_id, v_origin, v_product_name, v_grade, v_unit)
      ) as changed(warehouse_id, origin, product_name, grade, unit)
      where warehouse_id is not null
    ) as affected
    cross join lateral (
      select coalesce(sum(case when movement.to_warehouse_id = affected.warehouse_id then movement.quantity when movement.from_warehouse_id = affected.warehouse_id then -movement.quantity else 0 end), 0) as balance
      from public.flexcon_inventory_movements as movement
      where (movement.to_warehouse_id = affected.warehouse_id or movement.from_warehouse_id = affected.warehouse_id)
        and movement.origin = affected.origin
        and movement.product_name = affected.product_name
        and movement.grade = affected.grade
        and movement.unit = affected.unit
    ) as stock
    where stock.balance < 0
  ) then
    raise exception 'この変更を保存すると倉庫在庫が不足するため、編集できません。';
  end if;
end;
$$;

revoke all on function public.flexcon_validate_inventory_selection(text, text, text, numeric, text) from public;
revoke all on function public.flexcon_add_inventory_movement(text, date, text, text, text, numeric, text, uuid, uuid) from public;
revoke all on function public.flexcon_update_inventory_movement(text, uuid, date, text, text, text, numeric, text, uuid, uuid) from public;
grant execute on function public.flexcon_add_inventory_movement(text, date, text, text, text, numeric, text, uuid, uuid) to anon, authenticated;
grant execute on function public.flexcon_update_inventory_movement(text, uuid, date, text, text, text, numeric, text, uuid, uuid) to anon, authenticated;

commit;
