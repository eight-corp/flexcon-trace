-- 検査員マスタと、フレコン・紙袋ごとの検査員を追加します。
begin;

alter table public.flexcon_inspection_flexcons
  add column if not exists inspector_name text;

alter table public.flexcon_inspection_paper_bags
  add column if not exists inspector_name text;

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
      'shipment_product'
    )
  );

insert into public.flexcon_inspection_options (option_type, name, active, sort_order)
values
  ('inspector', '小林遼平', true, 10),
  ('inspector', '久保英雄', true, 20),
  ('inspector', '山田真純', true, 30),
  ('inspector', '富樫聖也', true, 40)
on conflict (option_type, name) do update
set active = true,
    sort_order = excluded.sort_order,
    updated_at = now();

create or replace function public.flexcon_save_inspection_option(
  p_worker_id text,
  p_option_id uuid,
  p_option_type text,
  p_name text
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
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_name := btrim(coalesce(p_name, ''));

  if p_option_type not in (
    'location',
    'inspector',
    'brand_aomori',
    'brand_iwate',
    'grade',
    'grade_reason',
    'shipment_product'
  ) then
    raise exception 'マスタ項目の種類が正しくありません。';
  end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception '名称を1文字から120文字で入力してください。';
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
      option_type, name, created_by_worker_id, updated_by_worker_id
    ) values (
      p_option_type, v_name, v_worker.worker_id, v_worker.worker_id
    ) returning id into v_id;
  else
    update public.flexcon_inspection_options
    set name = v_name,
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

drop function if exists public.flexcon_save_inspection_flexcon(
  text, uuid, uuid, integer, date, date, text, integer, text, integer, text, text, numeric
);

create or replace function public.flexcon_save_inspection_flexcon(
  p_worker_id text,
  p_flexcon_id uuid,
  p_authorization_id uuid,
  p_fiscal_year integer,
  p_purchase_date date,
  p_inspection_date date,
  p_inspector_name text,
  p_inspection_location text,
  p_flexcon_no integer,
  p_brand text,
  p_quantity_kg integer,
  p_grade text,
  p_reason text,
  p_moisture numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_authorization_no text;
  v_lot_number text;
  v_id uuid;
  v_inspector_name text;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select authorization_no into v_authorization_no
  from public.flexcon_authorizations
  where id = p_authorization_id;

  if v_authorization_no is null then raise exception '委任状情報が見つかりません。'; end if;
  if v_authorization_no !~ '^[0-9]{1,3}$' then raise exception '委任状№は3桁以内の数字にしてください。'; end if;
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then raise exception '年度は1から99の整数で入力してください。'; end if;
  if p_purchase_date is null then raise exception '仕入日を入力してください。'; end if;
  if p_flexcon_no is null or p_flexcon_no not between 1 and 999 then raise exception 'フレコン№は1から999で入力してください。'; end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then raise exception '銘柄を選択してください。'; end if;
  if p_quantity_kg is null or p_quantity_kg <= 0 then raise exception '数量は1kg以上で入力してください。'; end if;
  if p_moisture is not null and p_moisture not between 0 and 100 then raise exception '水分は0から100の範囲で入力してください。'; end if;
  if btrim(coalesce(p_grade, '')) in ('1等', '合格') and nullif(btrim(coalesce(p_reason, '')), '') is not null then
    raise exception '1等と合格には理由を入力できません。';
  end if;

  v_inspector_name := nullif(btrim(coalesce(p_inspector_name, '')), '');
  if v_inspector_name is not null and not exists (
    select 1
    from public.flexcon_inspection_options as option_item
    where option_item.option_type = 'inspector'
      and option_item.active = true
      and option_item.name = v_inspector_name
  ) then
    raise exception '有効な検査員を選択してください。';
  end if;

  v_lot_number := lpad((p_fiscal_year + 2018)::text, 4, '0')
      || lpad(v_authorization_no, 4, '0')
      || lpad(p_flexcon_no::text, 3, '0');

  update public.flexcon_inspection_flexcons
  set fiscal_year = p_fiscal_year,
      purchase_date = p_purchase_date,
      inspection_date = p_inspection_date,
      inspector_name = v_inspector_name,
      inspection_location = nullif(btrim(p_inspection_location), ''),
      flexcon_no = p_flexcon_no,
      lot_number = v_lot_number,
      brand = btrim(p_brand),
      quantity_kg = p_quantity_kg,
      grade = nullif(btrim(p_grade), ''),
      reason = nullif(btrim(p_reason), ''),
      moisture = round(p_moisture, 1),
      moisture_values = case when p_moisture is null then '{}'::numeric[] else array[p_moisture] end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where id = p_flexcon_id and authorization_id = p_authorization_id
  returning id into v_id;

  if v_id is null then raise exception 'フレコン検査記録を更新できませんでした。'; end if;
  return v_id;
end;
$$;

drop function if exists public.flexcon_save_inspection_paper_bags(
  text, uuid, uuid, integer, date, date, text, text, integer, text, text, numeric
);

create or replace function public.flexcon_save_inspection_paper_bags(
  p_worker_id text,
  p_paper_bag_id uuid,
  p_authorization_id uuid,
  p_fiscal_year integer,
  p_purchase_date date,
  p_inspection_date date,
  p_inspector_name text,
  p_inspection_location text,
  p_brand text,
  p_bag_count integer,
  p_grade text,
  p_reason text,
  p_moisture numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_inspector_name text;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if not exists (select 1 from public.flexcon_authorizations where id = p_authorization_id) then raise exception '委任状情報が見つかりません。'; end if;
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then raise exception '年度は1から99の整数で入力してください。'; end if;
  if p_purchase_date is null then raise exception '仕入日を入力してください。'; end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then raise exception '銘柄を選択してください。'; end if;
  if p_bag_count is null or p_bag_count <= 0 then raise exception '紙袋数は1以上で入力してください。'; end if;
  if p_moisture is not null and p_moisture not between 0 and 100 then raise exception '水分は0から100の範囲で入力してください。'; end if;
  if btrim(coalesce(p_grade, '')) in ('1等', '合格') and nullif(btrim(coalesce(p_reason, '')), '') is not null then
    raise exception '1等と合格には理由を入力できません。';
  end if;

  v_inspector_name := nullif(btrim(coalesce(p_inspector_name, '')), '');
  if v_inspector_name is not null and not exists (
    select 1
    from public.flexcon_inspection_options as option_item
    where option_item.option_type = 'inspector'
      and option_item.active = true
      and option_item.name = v_inspector_name
  ) then
    raise exception '有効な検査員を選択してください。';
  end if;

  update public.flexcon_inspection_paper_bags
  set fiscal_year = p_fiscal_year,
      purchase_date = p_purchase_date,
      inspection_date = p_inspection_date,
      inspector_name = v_inspector_name,
      inspection_location = nullif(btrim(p_inspection_location), ''),
      brand = btrim(p_brand),
      bag_count = p_bag_count,
      grade = nullif(btrim(p_grade), ''),
      reason = nullif(btrim(p_reason), ''),
      moisture = round(p_moisture, 1),
      moisture_values = case when p_moisture is null then '{}'::numeric[] else array[p_moisture] end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where id = p_paper_bag_id and authorization_id = p_authorization_id
  returning id into v_id;

  if v_id is null then raise exception '紙袋検査記録を更新できませんでした。'; end if;
  return v_id;
end;
$$;

create or replace function public.flexcon_split_inspection_paper_bags(
  p_worker_id text,
  p_paper_bag_id uuid,
  p_first_bag_count integer,
  p_second_bag_count integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.flexcon_inspection_paper_bags%rowtype;
  v_new_id uuid;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select * into v_source
  from public.flexcon_inspection_paper_bags
  where id = p_paper_bag_id
  for update;

  if v_source.id is null then raise exception '分割する紙袋検査記録が見つかりません。'; end if;
  if p_first_bag_count is null or p_first_bag_count <= 0
     or p_second_bag_count is null or p_second_bag_count <= 0 then
    raise exception '分割後の袋数はどちらも1以上で入力してください。';
  end if;
  if p_first_bag_count + p_second_bag_count <> v_source.bag_count then
    raise exception '分割後の合計を元の袋数に合わせてください。';
  end if;

  update public.flexcon_inspection_paper_bags
  set bag_count = p_first_bag_count,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where id = v_source.id;

  insert into public.flexcon_inspection_paper_bags (
    authorization_id,
    fiscal_year,
    purchase_date,
    inspection_date,
    inspector_name,
    inspection_location,
    brand,
    bag_count,
    grade,
    reason,
    moisture,
    moisture_values,
    created_by_worker_id,
    updated_by_worker_id
  ) values (
    v_source.authorization_id,
    v_source.fiscal_year,
    v_source.purchase_date,
    v_source.inspection_date,
    v_source.inspector_name,
    v_source.inspection_location,
    v_source.brand,
    p_second_bag_count,
    v_source.grade,
    v_source.reason,
    v_source.moisture,
    v_source.moisture_values,
    p_worker_id,
    p_worker_id
  ) returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public.flexcon_save_inspection_option(text, uuid, text, text) from public;
revoke all on function public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, date, date, text, text, integer, text, integer, text, text, numeric) from public;
revoke all on function public.flexcon_save_inspection_paper_bags(text, uuid, uuid, integer, date, date, text, text, text, integer, text, text, numeric) from public;
revoke all on function public.flexcon_split_inspection_paper_bags(text, uuid, integer, integer) from public;

grant execute on function public.flexcon_save_inspection_option(text, uuid, text, text) to anon, authenticated;
grant execute on function public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, date, date, text, text, integer, text, integer, text, text, numeric) to anon, authenticated;
grant execute on function public.flexcon_save_inspection_paper_bags(text, uuid, uuid, integer, date, date, text, text, text, integer, text, text, numeric) to anon, authenticated;
grant execute on function public.flexcon_split_inspection_paper_bags(text, uuid, integer, integer) to anon, authenticated;

commit;
