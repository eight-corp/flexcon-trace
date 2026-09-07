-- 複数生産者の玄米をまとめた混在フレコンと、その検査記録を管理します。
-- 202609070001_paper_bag_shipment_products.sql の実行後に適用してください。

begin;

create table if not exists public.flexcon_mixed_flexcons (
  id uuid primary key default gen_random_uuid(),
  mixed_no integer not null unique check (mixed_no between 1 and 4999),
  fiscal_year integer not null check (fiscal_year between 1 and 99),
  origin_prefecture text not null check (char_length(btrim(origin_prefecture)) between 1 and 40),
  brand text not null check (char_length(btrim(brand)) between 1 and 120),
  quantity_kg integer not null check (quantity_kg > 0),
  lot_number text not null unique check (lot_number ~ '^[0-9]{11}$'),
  purchase_date date,
  inspection_date date,
  inspector_name text,
  inspection_location text,
  grade text,
  reason text,
  moisture numeric(4,1) check (moisture is null or moisture between 0 and 100),
  notes text,
  certificate_print_count integer not null default 0 check (certificate_print_count >= 0),
  certificate_last_printed_at timestamptz,
  certificate_last_printed_by_worker_id text references public.workers(worker_id),
  created_by_worker_id text not null references public.workers(worker_id),
  updated_by_worker_id text not null references public.workers(worker_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.flexcon_mixed_flexcon_members (
  id uuid primary key default gen_random_uuid(),
  mixed_flexcon_id uuid not null references public.flexcon_mixed_flexcons(id) on delete cascade,
  authorization_id uuid not null references public.flexcon_authorizations(id),
  quantity_kg integer not null check (quantity_kg > 0),
  sort_order integer not null check (sort_order >= 0),
  created_at timestamptz not null default now(),
  unique (mixed_flexcon_id, authorization_id),
  unique (mixed_flexcon_id, sort_order)
);

create index if not exists flexcon_mixed_flexcons_origin_brand_idx
  on public.flexcon_mixed_flexcons (origin_prefecture, brand, mixed_no);
create index if not exists flexcon_mixed_members_authorization_idx
  on public.flexcon_mixed_flexcon_members (authorization_id, mixed_flexcon_id);

alter table public.flexcon_mixed_flexcons enable row level security;
alter table public.flexcon_mixed_flexcon_members enable row level security;

drop policy if exists flexcon_read_mixed_flexcons on public.flexcon_mixed_flexcons;
create policy flexcon_read_mixed_flexcons on public.flexcon_mixed_flexcons
  for select to anon, authenticated using (true);
drop policy if exists flexcon_read_mixed_flexcon_members on public.flexcon_mixed_flexcon_members;
create policy flexcon_read_mixed_flexcon_members on public.flexcon_mixed_flexcon_members
  for select to anon, authenticated using (true);

create or replace function public.flexcon_add_mixed_flexcon(
  p_worker_id text,
  p_fiscal_year integer,
  p_origin_prefecture text,
  p_brand text,
  p_quantity_kg integer,
  p_notes text,
  p_members jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mixed_no integer;
  v_lot_number text;
  v_id uuid;
  v_member jsonb;
  v_member_count integer;
  v_member_total integer;
  v_authorization_id uuid;
  v_member_quantity integer;
  v_sort_order integer := 0;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then
    raise exception '年度は1から99の整数で入力してください。';
  end if;
  if char_length(btrim(coalesce(p_origin_prefecture, ''))) = 0 then
    raise exception '産地を選択してください。';
  end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then
    raise exception '銘柄を選択してください。';
  end if;
  if p_quantity_kg is null or p_quantity_kg <= 0 then
    raise exception '量目が正しくありません。';
  end if;
  if jsonb_typeof(p_members) <> 'array' then
    raise exception '生産者別の数量が正しくありません。';
  end if;

  select count(*) into v_member_count from jsonb_array_elements(p_members);
  if v_member_count < 2 then
    raise exception '生産者を2名以上登録してください。';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_members) as member
    where coalesce(member->>'authorization_id', '') !~ '^[0-9a-fA-F-]{36}$'
       or coalesce(member->>'quantity_kg', '') !~ '^[1-9][0-9]*$'
  ) then
    raise exception '生産者別の数量を1kg以上の整数で入力してください。';
  end if;
  if (
    select count(distinct member->>'authorization_id')
    from jsonb_array_elements(p_members) as member
  ) <> v_member_count then
    raise exception '同じ生産者が重複しています。';
  end if;

  select sum((member->>'quantity_kg')::integer)
  into v_member_total
  from jsonb_array_elements(p_members) as member;
  if v_member_total <> p_quantity_kg then
    raise exception '生産者別数量の合計を量目%kgに合わせてください。', p_quantity_kg;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_members) as member
    left join public.flexcon_authorizations as auth_record
      on auth_record.id = (member->>'authorization_id')::uuid
    where auth_record.id is null
       or regexp_replace(btrim(coalesce(auth_record.prefecture, '')), '[都道府県]$', '')
          <> regexp_replace(btrim(p_origin_prefecture), '[都道府県]$', '')
  ) then
    raise exception '選択した産地と一致しない生産者が含まれています。';
  end if;

  perform pg_advisory_xact_lock(hashtext('flexcon_mixed_flexcons_mixed_no'));
  select coalesce(max(mixed_no), 0) + 1 into v_mixed_no
  from public.flexcon_mixed_flexcons;
  if v_mixed_no > 4999 then
    raise exception '混在フレコン№が上限に達しました。';
  end if;

  v_lot_number := lpad((p_fiscal_year + 2018)::text, 4, '0')
    || lpad((v_mixed_no + 5000)::text, 4, '0') || '001';

  insert into public.flexcon_mixed_flexcons (
    mixed_no, fiscal_year, origin_prefecture, brand, quantity_kg, lot_number, notes,
    created_by_worker_id, updated_by_worker_id
  ) values (
    v_mixed_no, p_fiscal_year, btrim(p_origin_prefecture), btrim(p_brand),
    p_quantity_kg, v_lot_number, nullif(btrim(p_notes), ''), p_worker_id, p_worker_id
  ) returning id into v_id;

  for v_member in select value from jsonb_array_elements(p_members) loop
    v_authorization_id := (v_member->>'authorization_id')::uuid;
    v_member_quantity := (v_member->>'quantity_kg')::integer;
    insert into public.flexcon_mixed_flexcon_members (
      mixed_flexcon_id, authorization_id, quantity_kg, sort_order
    ) values (v_id, v_authorization_id, v_member_quantity, v_sort_order);
    v_sort_order := v_sort_order + 1;
  end loop;

  insert into public.flexcon_flexcons (lot_number)
  values (v_lot_number)
  on conflict (lot_number) do nothing;

  return jsonb_build_object('id', v_id, 'mixed_no', v_mixed_no, 'lot_number', v_lot_number);
end;
$$;

create or replace function public.flexcon_save_mixed_flexcon_inspection(
  p_worker_id text,
  p_mixed_flexcon_id uuid,
  p_purchase_date date,
  p_inspection_date date,
  p_inspector_name text,
  p_inspection_location text,
  p_grade text,
  p_reason text,
  p_moisture numeric,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_brand text;
  v_inspector_name text;
  v_grade text := nullif(btrim(coalesce(p_grade, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select brand into v_brand
  from public.flexcon_mixed_flexcons
  where id = p_mixed_flexcon_id;
  if v_brand is null then raise exception '混在フレコンが見つかりません。'; end if;
  if p_moisture is not null and p_moisture not between 0 and 100 then
    raise exception '水分は0から100の範囲で入力してください。';
  end if;
  if v_brand = '飼料用玄米' and v_grade is not null and v_grade <> '合格' then
    raise exception '飼料用玄米の等級は合格だけ選択できます。';
  end if;
  if v_brand <> '飼料用玄米' and v_grade = '合格' then
    raise exception '飼料用玄米以外では合格を選択できません。';
  end if;
  if v_grade in ('1等', '合格') and v_reason is not null then
    raise exception '1等と合格には理由を入力できません。';
  end if;

  v_inspector_name := nullif(btrim(coalesce(p_inspector_name, '')), '');
  if v_inspector_name is not null and not exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'inspector' and active = true and name = v_inspector_name
  ) then
    raise exception '有効な検査員を選択してください。';
  end if;

  update public.flexcon_mixed_flexcons
  set purchase_date = p_purchase_date,
      inspection_date = p_inspection_date,
      inspector_name = v_inspector_name,
      inspection_location = nullif(btrim(p_inspection_location), ''),
      grade = v_grade,
      reason = case when v_grade in ('1等', '合格') then null else v_reason end,
      moisture = round(p_moisture, 1),
      notes = nullif(btrim(p_notes), ''),
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where id = p_mixed_flexcon_id
  returning id into v_id;

  if v_id is null then raise exception '混在フレコンの検査記録を保存できませんでした。'; end if;
  return v_id;
end;
$$;

create or replace function public.flexcon_brand_for_lot(p_lot_number text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select result.brand
  from (
    select coalesce(nullif(btrim(flexcon.brand), ''), '品名未登録') as brand,
      case when flexcon.lot_number = p_lot_number then 0 else 1 end as priority,
      flexcon.updated_at
    from public.flexcon_inspection_flexcons as flexcon
    where flexcon.lot_number = p_lot_number
       or (char_length(flexcon.lot_number) = 11 and substring(flexcon.lot_number from 5) = p_lot_number)
       or (char_length(flexcon.lot_number) = 11 and ltrim(substring(flexcon.lot_number from 5), '0') = p_lot_number)
       or (char_length(p_lot_number) = 11 and substring(p_lot_number from 5) = flexcon.lot_number)
       or (char_length(p_lot_number) = 11 and ltrim(substring(p_lot_number from 5), '0') = flexcon.lot_number)
    union all
    select coalesce(nullif(btrim(mixed.brand), ''), '品名未登録'), 0, mixed.updated_at
    from public.flexcon_mixed_flexcons as mixed
    where mixed.lot_number = p_lot_number
  ) as result
  order by result.priority, result.updated_at desc
  limit 1;
$$;

create or replace function public.flexcon_origin_for_lot(p_lot_number text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select result.origin_prefecture
  from (
    select nullif(btrim(auth_record.prefecture), '') as origin_prefecture,
      case when flexcon.lot_number = p_lot_number then 0 else 1 end as priority,
      flexcon.updated_at
    from public.flexcon_inspection_flexcons as flexcon
    join public.flexcon_authorizations as auth_record on auth_record.id = flexcon.authorization_id
    where flexcon.lot_number = p_lot_number
       or (char_length(flexcon.lot_number) = 11 and substring(flexcon.lot_number from 5) = p_lot_number)
       or (char_length(flexcon.lot_number) = 11 and ltrim(substring(flexcon.lot_number from 5), '0') = p_lot_number)
       or (char_length(p_lot_number) = 11 and substring(p_lot_number from 5) = flexcon.lot_number)
       or (char_length(p_lot_number) = 11 and ltrim(substring(p_lot_number from 5), '0') = flexcon.lot_number)
    union all
    select nullif(btrim(mixed.origin_prefecture), ''), 0, mixed.updated_at
    from public.flexcon_mixed_flexcons as mixed
    where mixed.lot_number = p_lot_number
  ) as result
  order by result.priority, result.updated_at desc
  limit 1;
$$;

revoke all on function public.flexcon_add_mixed_flexcon(text, integer, text, text, integer, text, jsonb) from public;
revoke all on function public.flexcon_save_mixed_flexcon_inspection(text, uuid, date, date, text, text, text, text, numeric, text) from public;
revoke all on function public.flexcon_brand_for_lot(text) from public;
revoke all on function public.flexcon_origin_for_lot(text) from public;

grant select on public.flexcon_mixed_flexcons, public.flexcon_mixed_flexcon_members to anon, authenticated;
grant execute on function public.flexcon_add_mixed_flexcon(text, integer, text, text, integer, text, jsonb) to anon, authenticated;
grant execute on function public.flexcon_save_mixed_flexcon_inspection(text, uuid, date, date, text, text, text, text, numeric, text) to anon, authenticated;

commit;
