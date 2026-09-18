-- 仕切書読込みアプリ専用の伝票・明細・入力候補マスタを追加します。

begin;

create table if not exists public.flexcon_purchase_statements (
  id uuid primary key default gen_random_uuid(),
  statement_date date not null,
  document_number text not null,
  recipient text not null default '',
  issuer text not null default '',
  payment_method text not null default '' check (payment_method in ('', 'cash', 'transfer')),
  tax_rate numeric(6, 3),
  tax_amount numeric(14, 2),
  total_amount numeric(14, 2),
  invoice_number text not null default '',
  source_type text not null default 'manual' check (source_type in ('camera', 'manual')),
  created_by_worker_id text not null references public.workers(worker_id),
  created_by_worker_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (tax_rate is null or tax_rate >= 0),
  check (tax_amount is null or tax_amount >= 0),
  check (total_amount is null or total_amount >= 0)
);

create table if not exists public.flexcon_purchase_statement_items (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references public.flexcon_purchase_statements(id) on delete cascade,
  line_no integer not null check (line_no > 0),
  crop_year integer check (crop_year between 1900 and 2100),
  product_name text not null,
  package_type text not null default '',
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null default '',
  unit_price numeric(14, 2) check (unit_price is null or unit_price >= 0),
  amount numeric(14, 2) check (amount is null or amount >= 0),
  created_at timestamptz not null default now(),
  unique (statement_id, line_no)
);

create table if not exists public.flexcon_purchase_statement_master_values (
  id uuid primary key default gen_random_uuid(),
  value_type text not null check (value_type in ('recipient', 'issuer', 'product', 'package')),
  name text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists flexcon_purchase_statement_master_value_key
  on public.flexcon_purchase_statement_master_values (value_type, lower(btrim(name)));

create index if not exists flexcon_purchase_statements_date_idx
  on public.flexcon_purchase_statements (statement_date desc, document_number);
create index if not exists flexcon_purchase_statement_items_statement_idx
  on public.flexcon_purchase_statement_items (statement_id, line_no);

alter table public.flexcon_purchase_statements enable row level security;
alter table public.flexcon_purchase_statement_items enable row level security;
alter table public.flexcon_purchase_statement_master_values enable row level security;
revoke all on public.flexcon_purchase_statements, public.flexcon_purchase_statement_items, public.flexcon_purchase_statement_master_values from public, anon, authenticated;

create or replace function public.flexcon_list_purchase_statements(p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', statement.id,
    'statement_date', statement.statement_date,
    'document_number', statement.document_number,
    'recipient', statement.recipient,
    'issuer', statement.issuer,
    'payment_method', statement.payment_method,
    'tax_rate', statement.tax_rate,
    'tax_amount', statement.tax_amount,
    'total_amount', statement.total_amount,
    'invoice_number', statement.invoice_number,
    'source_type', statement.source_type,
    'created_by_worker_name', statement.created_by_worker_name,
    'created_at', statement.created_at,
    'updated_at', statement.updated_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'line_no', item.line_no,
        'crop_year', item.crop_year,
        'product_name', item.product_name,
        'package_type', item.package_type,
        'quantity', item.quantity,
        'unit', item.unit,
        'unit_price', item.unit_price,
        'amount', item.amount
      ) order by item.line_no)
      from public.flexcon_purchase_statement_items as item
      where item.statement_id = statement.id
    ), '[]'::jsonb)
  ) order by statement.statement_date desc, statement.created_at desc), '[]'::jsonb)
  into v_result
  from public.flexcon_purchase_statements as statement;
  return v_result;
end;
$$;

create or replace function public.flexcon_save_purchase_statement(
  p_worker_id text,
  p_statement_id uuid,
  p_source_type text,
  p_header jsonb,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_worker public.workers%rowtype;
  v_statement_id uuid;
  v_item jsonb;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if coalesce(p_source_type, '') not in ('camera', 'manual') then raise exception '登録方法が不正です。'; end if;
  if nullif(btrim(p_header->>'statement_date'), '') is null then raise exception '日付を入力してください。'; end if;
  if nullif(btrim(p_header->>'document_number'), '') is null then raise exception '仕切書№を入力してください。'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception '明細を1行以上入力してください。'; end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if nullif(btrim(v_item->>'product_name'), '') is null then raise exception '品名が空欄の明細があります。'; end if;
    if coalesce((v_item->>'quantity')::numeric, 0) <= 0 then raise exception '数量を確認してください。'; end if;
    if nullif(v_item->>'crop_year', '') is not null and (v_item->>'crop_year')::integer not between 1900 and 2100 then raise exception '産年を確認してください。'; end if;
    if nullif(v_item->>'unit_price', '') is not null and (v_item->>'unit_price')::numeric < 0 then raise exception '単価を確認してください。'; end if;
    if nullif(v_item->>'amount', '') is not null and (v_item->>'amount')::numeric < 0 then raise exception '金額を確認してください。'; end if;
  end loop;

  if p_statement_id is null then
    insert into public.flexcon_purchase_statements (
      statement_date, document_number, recipient, issuer, payment_method, tax_rate, tax_amount,
      total_amount, invoice_number, source_type, created_by_worker_id, created_by_worker_name
    ) values (
      (p_header->>'statement_date')::date,
      btrim(p_header->>'document_number'),
      btrim(coalesce(p_header->>'recipient', '')),
      btrim(coalesce(p_header->>'issuer', '')),
      case when coalesce(p_header->>'payment_method', '') in ('cash', 'transfer') then p_header->>'payment_method' else '' end,
      nullif(p_header->>'tax_rate', '')::numeric,
      nullif(p_header->>'tax_amount', '')::numeric,
      nullif(p_header->>'total_amount', '')::numeric,
      btrim(coalesce(p_header->>'invoice_number', '')),
      p_source_type,
      v_worker.worker_id,
      v_worker.worker_name
    ) returning id into v_statement_id;
  else
    if not exists (select 1 from public.flexcon_purchase_statements where id = p_statement_id) then raise exception '仕切書が見つかりません。'; end if;
    update public.flexcon_purchase_statements
    set statement_date = (p_header->>'statement_date')::date,
        document_number = btrim(p_header->>'document_number'),
        recipient = btrim(coalesce(p_header->>'recipient', '')),
        issuer = btrim(coalesce(p_header->>'issuer', '')),
        payment_method = case when coalesce(p_header->>'payment_method', '') in ('cash', 'transfer') then p_header->>'payment_method' else '' end,
        tax_rate = nullif(p_header->>'tax_rate', '')::numeric,
        tax_amount = nullif(p_header->>'tax_amount', '')::numeric,
        total_amount = nullif(p_header->>'total_amount', '')::numeric,
        invoice_number = btrim(coalesce(p_header->>'invoice_number', '')),
        updated_at = now()
    where id = p_statement_id
    returning id into v_statement_id;
    delete from public.flexcon_purchase_statement_items where statement_id = v_statement_id;
  end if;

  insert into public.flexcon_purchase_statement_items (
    statement_id, line_no, crop_year, product_name, package_type, quantity, unit, unit_price, amount
  )
  select
    v_statement_id,
    item.source_order::integer,
    nullif(item.value->>'crop_year', '')::integer,
    btrim(item.value->>'product_name'),
    btrim(coalesce(item.value->>'package_type', '')),
    (item.value->>'quantity')::numeric,
    btrim(coalesce(item.value->>'unit', '')),
    nullif(item.value->>'unit_price', '')::numeric,
    nullif(item.value->>'amount', '')::numeric
  from jsonb_array_elements(p_items) with ordinality as item(value, source_order)
  order by item.source_order;

  return v_statement_id;
end;
$$;

create or replace function public.flexcon_delete_purchase_statement(p_worker_id text, p_statement_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  delete from public.flexcon_purchase_statements where id = p_statement_id;
  if not found then raise exception '仕切書が見つかりません。'; end if;
end;
$$;

create or replace function public.flexcon_list_purchase_statement_master(p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', value.id, 'value_type', value.value_type, 'name', value.name,
    'active', value.active, 'sort_order', value.sort_order
  ) order by value.value_type, value.sort_order, value.name)
  from public.flexcon_purchase_statement_master_values as value), '[]'::jsonb);
end;
$$;

create or replace function public.flexcon_save_purchase_statement_master(
  p_worker_id text,
  p_value_id uuid,
  p_value_type text,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  if p_value_type not in ('recipient', 'issuer', 'product', 'package') then raise exception 'マスタの種類が不正です。'; end if;
  if nullif(btrim(p_name), '') is null then raise exception '名称を入力してください。'; end if;
  if p_value_id is null then
    insert into public.flexcon_purchase_statement_master_values(value_type, name, sort_order)
    values (p_value_type, btrim(p_name), coalesce((select max(sort_order) + 1 from public.flexcon_purchase_statement_master_values where value_type = p_value_type), 1))
    returning id into v_id;
  else
    update public.flexcon_purchase_statement_master_values
    set name = btrim(p_name), updated_at = now()
    where id = p_value_id and value_type = p_value_type
    returning id into v_id;
    if v_id is null then raise exception 'マスタ項目が見つかりません。'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.flexcon_delete_purchase_statement_master(p_worker_id text, p_value_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  delete from public.flexcon_purchase_statement_master_values where id = p_value_id;
  if not found then raise exception 'マスタ項目が見つかりません。'; end if;
end;
$$;

revoke all on function public.flexcon_list_purchase_statements(text) from public;
revoke all on function public.flexcon_save_purchase_statement(text, uuid, text, jsonb, jsonb) from public;
revoke all on function public.flexcon_delete_purchase_statement(text, uuid) from public;
revoke all on function public.flexcon_list_purchase_statement_master(text) from public;
revoke all on function public.flexcon_save_purchase_statement_master(text, uuid, text, text) from public;
revoke all on function public.flexcon_delete_purchase_statement_master(text, uuid) from public;
grant execute on function public.flexcon_list_purchase_statements(text) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_statement(text, uuid, text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.flexcon_delete_purchase_statement(text, uuid) to anon, authenticated;
grant execute on function public.flexcon_list_purchase_statement_master(text) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_statement_master(text, uuid, text, text) to anon, authenticated;
grant execute on function public.flexcon_delete_purchase_statement_master(text, uuid) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
