-- 仕切書に支払方法を追加し、一覧・保存RPCへ反映します。

begin;

alter table public.flexcon_purchase_statements
  add column if not exists payment_method text not null default ''
  check (payment_method in ('', 'cash', 'transfer'));
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
commit;

notify pgrst, 'reload schema';
