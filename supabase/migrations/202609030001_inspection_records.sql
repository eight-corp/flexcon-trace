-- 検査記録の入力・一覧表示に必要なテーブルと保存RPCを追加します。
-- 202609020006_authorization_validation.sql の実行後に適用してください。

create table if not exists public.flexcon_inspection_records (
  id uuid primary key default gen_random_uuid(),
  record_no integer not null check (record_no > 0),
  fiscal_year integer not null check (fiscal_year between 1 and 99),
  purchase_date date,
  inspection_date date,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 120),
  prefecture text,
  municipality text,
  inspection_location text,
  authorization_no text,
  brand text,
  recommended_flexcon integer check (recommended_flexcon is null or recommended_flexcon >= 0),
  paper_bags integer check (paper_bags is null or paper_bags >= 0),
  bulk_quantity integer check (bulk_quantity is null or bulk_quantity >= 0),
  total_quantity bigint check (total_quantity is null or total_quantity >= 0),
  grade text,
  moisture numeric(5, 2) check (moisture is null or moisture between 0 and 100),
  reason text,
  moisture_values numeric(5, 2)[] not null default '{}'::numeric[],
  created_by_worker_id text not null references public.workers(worker_id),
  updated_by_worker_id text not null references public.workers(worker_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fiscal_year, record_no),
  check (cardinality(moisture_values) <= 100)
);

create index if not exists flexcon_inspection_records_date_idx
  on public.flexcon_inspection_records (inspection_date desc, record_no desc);
create index if not exists flexcon_inspection_records_name_idx
  on public.flexcon_inspection_records (full_name);
create index if not exists flexcon_inspection_records_authorization_idx
  on public.flexcon_inspection_records (authorization_no);

alter table public.flexcon_inspection_records enable row level security;

drop policy if exists flexcon_read_inspection_records
  on public.flexcon_inspection_records;
create policy flexcon_read_inspection_records on public.flexcon_inspection_records
  for select to anon, authenticated using (true);

create or replace function public.flexcon_set_inspection_moisture_average()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select round(avg(measured.value), 1)
  into new.moisture
  from unnest(new.moisture_values) as measured(value)
  where measured.value is not null;

  return new;
end;
$$;

drop trigger if exists flexcon_inspection_moisture_average
  on public.flexcon_inspection_records;

create trigger flexcon_inspection_moisture_average
before insert or update of moisture_values
on public.flexcon_inspection_records
for each row
execute function public.flexcon_set_inspection_moisture_average();

update public.flexcon_inspection_records as inspection
set moisture = (
  select round(avg(measured.value), 1)
  from unnest(inspection.moisture_values) as measured(value)
  where measured.value is not null
);

create or replace function public.flexcon_save_inspection_record(
  p_worker_id text,
  p_record_id uuid,
  p_record jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_id uuid;
  v_record_no integer;
  v_fiscal_year integer;
  v_full_name text;
  v_recommended_flexcon integer;
  v_paper_bags integer;
  v_bulk_quantity integer;
  v_moisture_values numeric(5, 2)[];
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);

  v_record_no := nullif(p_record->>'record_no', '')::integer;
  v_fiscal_year := nullif(p_record->>'fiscal_year', '')::integer;
  v_full_name := btrim(coalesce(p_record->>'full_name', ''));
  v_recommended_flexcon := nullif(p_record->>'recommended_flexcon', '')::integer;
  v_paper_bags := nullif(p_record->>'paper_bags', '')::integer;
  v_bulk_quantity := nullif(p_record->>'bulk_quantity', '')::integer;

  select coalesce(
    array_agg(
      case
        when jsonb_typeof(item.value) = 'null' then null
        else (item.value #>> '{}')::numeric
      end
      order by item.ordinality
    ),
    '{}'::numeric[]
  )
  into v_moisture_values
  from jsonb_array_elements(coalesce(p_record->'moisture_values', '[]'::jsonb))
    with ordinality as item(value, ordinality);

  if v_record_no is null or v_record_no <= 0 then
    raise exception 'ナンバーは1以上の整数で入力してください。';
  end if;
  if v_fiscal_year is null or v_fiscal_year not between 1 and 99 then
    raise exception '年度は1から99の整数で入力してください。';
  end if;
  if char_length(v_full_name) not between 1 and 120 then
    raise exception '氏名を1文字から120文字で入力してください。';
  end if;
  if coalesce(v_recommended_flexcon, 0) < 0
     or coalesce(v_paper_bags, 0) < 0
     or coalesce(v_bulk_quantity, 0) < 0 then
    raise exception '推フレ、紙袋、バラは0以上で入力してください。';
  end if;
  if cardinality(v_moisture_values) > 100 then
    raise exception '水分測定値は100件以内で入力してください。';
  end if;
  if exists (
    select 1 from unnest(v_moisture_values) as measured(value)
    where measured.value is not null
      and measured.value not between 0 and 100
  ) then
    raise exception '水分1から水分100は0から100の範囲で入力してください。';
  end if;
  if exists (
    select 1
    from public.flexcon_inspection_records as inspection
    where inspection.fiscal_year = v_fiscal_year
      and inspection.record_no = v_record_no
      and (p_record_id is null or inspection.id <> p_record_id)
  ) then
    raise exception '同じ年度とナンバーの検査記録がすでに登録されています。';
  end if;

  if p_record_id is null then
    insert into public.flexcon_inspection_records (
      record_no,
      fiscal_year,
      purchase_date,
      inspection_date,
      full_name,
      prefecture,
      municipality,
      inspection_location,
      authorization_no,
      brand,
      recommended_flexcon,
      paper_bags,
      bulk_quantity,
      grade,
      reason,
      moisture_values,
      created_by_worker_id,
      updated_by_worker_id
    ) values (
      v_record_no,
      v_fiscal_year,
      nullif(p_record->>'purchase_date', '')::date,
      nullif(p_record->>'inspection_date', '')::date,
      v_full_name,
      nullif(btrim(p_record->>'prefecture'), ''),
      nullif(btrim(p_record->>'municipality'), ''),
      nullif(btrim(p_record->>'inspection_location'), ''),
      nullif(btrim(p_record->>'authorization_no'), ''),
      nullif(btrim(p_record->>'brand'), ''),
      v_recommended_flexcon,
      v_paper_bags,
      v_bulk_quantity,
      nullif(btrim(p_record->>'grade'), ''),
      nullif(btrim(p_record->>'reason'), ''),
      v_moisture_values,
      v_worker.worker_id,
      v_worker.worker_id
    )
    returning id into v_id;
  else
    update public.flexcon_inspection_records
    set record_no = v_record_no,
        fiscal_year = v_fiscal_year,
        purchase_date = nullif(p_record->>'purchase_date', '')::date,
        inspection_date = nullif(p_record->>'inspection_date', '')::date,
        full_name = v_full_name,
        prefecture = nullif(btrim(p_record->>'prefecture'), ''),
        municipality = nullif(btrim(p_record->>'municipality'), ''),
        inspection_location = nullif(btrim(p_record->>'inspection_location'), ''),
        authorization_no = nullif(btrim(p_record->>'authorization_no'), ''),
        brand = nullif(btrim(p_record->>'brand'), ''),
        recommended_flexcon = v_recommended_flexcon,
        paper_bags = v_paper_bags,
        bulk_quantity = v_bulk_quantity,
        grade = nullif(btrim(p_record->>'grade'), ''),
        reason = nullif(btrim(p_record->>'reason'), ''),
        moisture_values = v_moisture_values,
        updated_by_worker_id = v_worker.worker_id,
        updated_at = now()
    where id = p_record_id
    returning id into v_id;

    if v_id is null then
      raise exception '検査記録が見つかりません。';
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function public.flexcon_save_inspection_record(text, uuid, jsonb)
  from public;
revoke all on function public.flexcon_set_inspection_moisture_average()
  from public;

grant select on public.flexcon_inspection_records to anon, authenticated;
grant execute on function public.flexcon_save_inspection_record(text, uuid, jsonb)
  to anon, authenticated;
