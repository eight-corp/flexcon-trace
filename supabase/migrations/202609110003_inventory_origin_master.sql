-- 在庫管理で使用する産地をマスタ項目に追加します。

begin;

alter table public.flexcon_inspection_options
  drop constraint if exists flexcon_inspection_options_option_type_check;

alter table public.flexcon_inspection_options
  add constraint flexcon_inspection_options_option_type_check
  check (
    option_type in (
      'location',
      'inspector',
      'brand_aomori',
      'brand_iwate',
      'grade',
      'grade_reason',
      'shipment_product',
      'warehouse',
      'origin'
    )
  );

insert into public.flexcon_inspection_options (option_type, name, sort_order)
values
  ('origin', '青森県', 10),
  ('origin', '岩手県', 20)
on conflict (option_type, name) do nothing;

create or replace function public.flexcon_save_inspection_option(
  p_worker_id text,
  p_option_id uuid,
  p_option_type text,
  p_name text,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_id uuid;
  v_name text;
  v_description text;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_name := btrim(coalesce(p_name, ''));
  v_description := nullif(btrim(coalesce(p_description, '')), '');

  if p_option_type not in (
    'location',
    'inspector',
    'brand_aomori',
    'brand_iwate',
    'grade',
    'grade_reason',
    'shipment_product',
    'warehouse',
    'origin'
  ) then
    raise exception 'マスタ項目の種類が正しくありません。';
  end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception '名称を1文字から120文字で入力してください。';
  end if;
  if v_description is not null and char_length(v_description) > 1000 then
    raise exception '説明文は1000文字以内で入力してください。';
  end if;
  if p_option_type not in ('grade', 'grade_reason') and v_description is not null then
    raise exception '説明文を登録できるのは等級と等級の理由だけです。';
  end if;
  if exists (
    select 1
    from public.flexcon_inspection_options as inspection_option
    where inspection_option.option_type = p_option_type
      and lower(btrim(inspection_option.name)) = lower(v_name)
      and (p_option_id is null or inspection_option.id <> p_option_id)
  ) then
    raise exception '同じ名称がすでに登録されています。';
  end if;

  if p_option_id is null then
    insert into public.flexcon_inspection_options (
      option_type,
      name,
      description,
      created_by_worker_id,
      updated_by_worker_id
    ) values (
      p_option_type,
      v_name,
      v_description,
      v_worker.worker_id,
      v_worker.worker_id
    ) returning id into v_id;
  else
    update public.flexcon_inspection_options
    set name = v_name,
        description = v_description,
        updated_by_worker_id = v_worker.worker_id,
        updated_at = now()
    where id = p_option_id
      and option_type = p_option_type
    returning id into v_id;

    if v_id is null then
      raise exception 'マスタ項目が見つかりません。';
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function public.flexcon_save_inspection_option(text, uuid, text, text, text) from public;
grant execute on function public.flexcon_save_inspection_option(text, uuid, text, text, text) to anon, authenticated;

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

revoke all on function public.flexcon_add_inventory_movement(text, date, text, text, numeric, text, uuid, uuid) from public;
grant execute on function public.flexcon_add_inventory_movement(text, date, text, text, numeric, text, uuid, uuid) to anon, authenticated;

commit;
