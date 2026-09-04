-- 生産者・仕入日単位の検査記録へ移行します。
-- このSQLを実行すると、旧 flexcon_inspection_records のデータは消去されます。

begin;

do $$
begin
  if to_regclass('public.flexcon_inspection_records') is not null then
    delete from public.flexcon_inspection_records;
  end if;
end;
$$;

create table if not exists public.flexcon_inspection_batches (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid not null references public.flexcon_authorizations(id) on delete cascade,
  purchase_date date not null,
  fiscal_year integer not null check (fiscal_year between 1 and 99),
  inspection_date date,
  inspection_location text,
  brand text,
  created_by_worker_id text not null references public.workers(worker_id),
  updated_by_worker_id text not null references public.workers(worker_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (authorization_id, purchase_date)
);

create table if not exists public.flexcon_inspection_flexcons (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.flexcon_inspection_batches(id) on delete cascade,
  flexcon_no integer not null check (flexcon_no between 1 and 999),
  lot_number text not null unique check (lot_number ~ '^[0-9]{6}$'),
  quantity_kg integer not null check (quantity_kg > 0),
  grade text,
  reason text,
  moisture numeric(5, 1) check (moisture is null or moisture between 0 and 100),
  moisture_values numeric(5, 2)[] not null default '{}'::numeric[],
  created_by_worker_id text not null references public.workers(worker_id),
  updated_by_worker_id text not null references public.workers(worker_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(moisture_values) <= 100)
);

create table if not exists public.flexcon_inspection_paper_bags (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null unique references public.flexcon_inspection_batches(id) on delete cascade,
  bag_count integer not null check (bag_count >= 0),
  grade text,
  reason text,
  moisture numeric(5, 1) check (moisture is null or moisture between 0 and 100),
  moisture_values numeric(5, 2)[] not null default '{}'::numeric[],
  created_by_worker_id text not null references public.workers(worker_id),
  updated_by_worker_id text not null references public.workers(worker_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(moisture_values) <= 100)
);

create index if not exists flexcon_inspection_batches_authorization_date_idx
  on public.flexcon_inspection_batches (authorization_id, purchase_date desc);
create index if not exists flexcon_inspection_flexcons_batch_idx
  on public.flexcon_inspection_flexcons (batch_id, flexcon_no);

alter table public.flexcon_inspection_batches enable row level security;
alter table public.flexcon_inspection_flexcons enable row level security;
alter table public.flexcon_inspection_paper_bags enable row level security;

drop policy if exists flexcon_read_inspection_batches on public.flexcon_inspection_batches;
create policy flexcon_read_inspection_batches on public.flexcon_inspection_batches
  for select to anon, authenticated using (true);

drop policy if exists flexcon_read_inspection_flexcons on public.flexcon_inspection_flexcons;
create policy flexcon_read_inspection_flexcons on public.flexcon_inspection_flexcons
  for select to anon, authenticated using (true);

drop policy if exists flexcon_read_inspection_paper_bags on public.flexcon_inspection_paper_bags;
create policy flexcon_read_inspection_paper_bags on public.flexcon_inspection_paper_bags
  for select to anon, authenticated using (true);

grant select on public.flexcon_inspection_batches to anon, authenticated;
grant select on public.flexcon_inspection_flexcons to anon, authenticated;
grant select on public.flexcon_inspection_paper_bags to anon, authenticated;

create or replace function public.flexcon_inspection_moisture_average(p_values numeric[])
returns numeric
language sql
immutable
set search_path = public
as $$
  select round(avg(measured.value), 1)
  from unnest(coalesce(p_values, '{}'::numeric[])) as measured(value)
  where measured.value is not null;
$$;

create or replace function public.flexcon_save_inspection_batch(
  p_worker_id text,
  p_batch_id uuid,
  p_authorization_id uuid,
  p_purchase_date date,
  p_fiscal_year integer,
  p_inspection_date date,
  p_inspection_location text,
  p_brand text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if p_purchase_date is null then
    raise exception '仕入日を入力してください。';
  end if;
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then
    raise exception '年度は1から99の整数で入力してください。';
  end if;
  if not exists (select 1 from public.flexcon_authorizations where id = p_authorization_id) then
    raise exception '委任状情報が見つかりません。';
  end if;

  if p_batch_id is null then
    insert into public.flexcon_inspection_batches (
      authorization_id, purchase_date, fiscal_year, inspection_date,
      inspection_location, brand, created_by_worker_id, updated_by_worker_id
    ) values (
      p_authorization_id, p_purchase_date, p_fiscal_year, p_inspection_date,
      nullif(btrim(p_inspection_location), ''), nullif(btrim(p_brand), ''),
      p_worker_id, p_worker_id
    ) returning id into v_id;
  else
    update public.flexcon_inspection_batches
    set purchase_date = p_purchase_date,
        fiscal_year = p_fiscal_year,
        inspection_date = p_inspection_date,
        inspection_location = nullif(btrim(p_inspection_location), ''),
        brand = nullif(btrim(p_brand), ''),
        updated_by_worker_id = p_worker_id,
        updated_at = now()
    where id = p_batch_id and authorization_id = p_authorization_id
    returning id into v_id;
  end if;

  if v_id is null then
    raise exception '仕入日別の検査記録を保存できませんでした。';
  end if;
  return v_id;
end;
$$;

create or replace function public.flexcon_save_inspection_flexcon(
  p_worker_id text,
  p_flexcon_id uuid,
  p_batch_id uuid,
  p_flexcon_no integer,
  p_quantity_kg integer,
  p_grade text,
  p_reason text,
  p_moisture_values numeric[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_authorization_no text;
  v_lot_number text;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select auth_record.authorization_no
  into v_authorization_no
  from public.flexcon_inspection_batches as batch
  join public.flexcon_authorizations as auth_record on auth_record.id = batch.authorization_id
  where batch.id = p_batch_id;

  if v_authorization_no is null then
    raise exception '仕入日別の検査記録が見つかりません。';
  end if;
  if v_authorization_no !~ '^[0-9]{1,3}$' then
    raise exception '委任状№は3桁以内の数字にしてください。';
  end if;
  if p_flexcon_no is null or p_flexcon_no not between 1 and 999 then
    raise exception 'フレコン№は1から999で入力してください。';
  end if;
  if p_quantity_kg is null or p_quantity_kg <= 0 then
    raise exception '数量は1kg以上で入力してください。';
  end if;
  if cardinality(coalesce(p_moisture_values, '{}'::numeric[])) > 100 then
    raise exception '水分測定値は100件以内で入力してください。';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_moisture_values, '{}'::numeric[])) as measured(value)
    where measured.value is not null and measured.value not between 0 and 100
  ) then
    raise exception '水分1から水分100は0から100の範囲で入力してください。';
  end if;

  v_lot_number := lpad(v_authorization_no, 3, '0') || lpad(p_flexcon_no::text, 3, '0');

  if p_flexcon_id is null then
    insert into public.flexcon_inspection_flexcons (
      batch_id, flexcon_no, lot_number, quantity_kg, grade, reason,
      moisture, moisture_values, created_by_worker_id, updated_by_worker_id
    ) values (
      p_batch_id, p_flexcon_no, v_lot_number, p_quantity_kg,
      nullif(btrim(p_grade), ''), nullif(btrim(p_reason), ''),
      public.flexcon_inspection_moisture_average(p_moisture_values),
      coalesce(p_moisture_values, '{}'::numeric[]), p_worker_id, p_worker_id
    ) returning id into v_id;
  else
    update public.flexcon_inspection_flexcons
    set flexcon_no = p_flexcon_no,
        lot_number = v_lot_number,
        quantity_kg = p_quantity_kg,
        grade = nullif(btrim(p_grade), ''),
        reason = nullif(btrim(p_reason), ''),
        moisture = public.flexcon_inspection_moisture_average(p_moisture_values),
        moisture_values = coalesce(p_moisture_values, '{}'::numeric[]),
        updated_by_worker_id = p_worker_id,
        updated_at = now()
    where id = p_flexcon_id and batch_id = p_batch_id
    returning id into v_id;
  end if;

  if v_id is null then
    raise exception 'フレコン検査記録を保存できませんでした。';
  end if;
  return v_id;
end;
$$;

create or replace function public.flexcon_save_inspection_paper_bags(
  p_worker_id text,
  p_paper_bag_id uuid,
  p_batch_id uuid,
  p_bag_count integer,
  p_grade text,
  p_reason text,
  p_moisture_values numeric[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if not exists (select 1 from public.flexcon_inspection_batches where id = p_batch_id) then
    raise exception '仕入日別の検査記録が見つかりません。';
  end if;
  if p_bag_count is null or p_bag_count < 0 then
    raise exception '紙袋数は0以上で入力してください。';
  end if;
  if cardinality(coalesce(p_moisture_values, '{}'::numeric[])) > 100 then
    raise exception '水分測定値は100件以内で入力してください。';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_moisture_values, '{}'::numeric[])) as measured(value)
    where measured.value is not null and measured.value not between 0 and 100
  ) then
    raise exception '水分1から水分100は0から100の範囲で入力してください。';
  end if;

  insert into public.flexcon_inspection_paper_bags (
    id, batch_id, bag_count, grade, reason, moisture, moisture_values,
    created_by_worker_id, updated_by_worker_id
  ) values (
    coalesce(p_paper_bag_id, gen_random_uuid()), p_batch_id, p_bag_count,
    nullif(btrim(p_grade), ''), nullif(btrim(p_reason), ''),
    public.flexcon_inspection_moisture_average(p_moisture_values),
    coalesce(p_moisture_values, '{}'::numeric[]), p_worker_id, p_worker_id
  )
  on conflict (batch_id) do update
  set bag_count = excluded.bag_count,
      grade = excluded.grade,
      reason = excluded.reason,
      moisture = excluded.moisture,
      moisture_values = excluded.moisture_values,
      updated_by_worker_id = excluded.updated_by_worker_id,
      updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.flexcon_delete_inspection_flexcon(
  p_worker_id text,
  p_flexcon_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  delete from public.flexcon_inspection_flexcons where id = p_flexcon_id;
end;
$$;

create or replace function public.flexcon_delete_inspection_batch(
  p_worker_id text,
  p_batch_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  delete from public.flexcon_inspection_batches where id = p_batch_id;
end;
$$;

revoke all on function public.flexcon_save_inspection_batch(text, uuid, uuid, date, integer, date, text, text) from public;
revoke all on function public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, integer, text, text, numeric[]) from public;
revoke all on function public.flexcon_save_inspection_paper_bags(text, uuid, uuid, integer, text, text, numeric[]) from public;
revoke all on function public.flexcon_delete_inspection_flexcon(text, uuid) from public;
revoke all on function public.flexcon_delete_inspection_batch(text, uuid) from public;

grant execute on function public.flexcon_save_inspection_batch(text, uuid, uuid, date, integer, date, text, text) to anon, authenticated;
grant execute on function public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, integer, text, text, numeric[]) to anon, authenticated;
grant execute on function public.flexcon_save_inspection_paper_bags(text, uuid, uuid, integer, text, text, numeric[]) to anon, authenticated;
grant execute on function public.flexcon_delete_inspection_flexcon(text, uuid) to anon, authenticated;
grant execute on function public.flexcon_delete_inspection_batch(text, uuid) to anon, authenticated;

commit;
