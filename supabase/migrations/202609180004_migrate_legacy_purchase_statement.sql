-- 旧在庫取込に保存された仕切書を、仕切書読込みアプリ専用テーブルへ移行します。
-- 旧テーブルのデータは削除・変更しません。

begin;

with source_headers as (
  select
    line.settlement_no as document_number,
    min(line.purchased_at)::date as statement_date,
    min(line.producer_name) as issuer,
    max(line.purchase_price) as total_amount,
    min(batch.imported_by_worker_id) as worker_id,
    min(batch.imported_by_worker_name) as worker_name,
    min(batch.imported_at) as imported_at
  from public.flexcon_purchase_statement_lines as line
  join public.flexcon_purchase_import_batches as batch on batch.id = line.batch_id
  group by line.settlement_no
), inserted as (
  insert into public.flexcon_purchase_statements (
    statement_date, document_number, recipient, issuer, payment_method,
    tax_rate, tax_amount, total_amount, invoice_number, source_type,
    created_by_worker_id, created_by_worker_name, created_at, updated_at
  )
  select
    source.statement_date,
    source.document_number,
    '',
    source.issuer,
    '',
    null,
    null,
    source.total_amount,
    '',
    'camera',
    source.worker_id,
    source.worker_name,
    source.imported_at,
    source.imported_at
  from source_headers as source
  where not exists (
    select 1
    from public.flexcon_purchase_statements as current
    where current.document_number = source.document_number
      and current.statement_date = source.statement_date
  )
  returning id, document_number, statement_date
)
insert into public.flexcon_purchase_statement_items (
  statement_id, line_no, crop_year, product_name, package_type,
  quantity, unit, unit_price, amount, created_at
)
select
  inserted.id,
  row_number() over (
    partition by line.settlement_no
    order by line.detail_no, line.part_no, line.created_at, line.id
  )::integer,
  line.crop_year,
  line.product_name,
  coalesce((regexp_match(line.raw_product_name, '\(([^()]*)\)\s*$'))[1], ''),
  line.raw_quantity,
  line.raw_unit,
  null,
  null,
  line.created_at
from inserted
join public.flexcon_purchase_statement_lines as line
  on line.settlement_no = inserted.document_number
 and line.purchased_at::date = inserted.statement_date
order by line.settlement_no, line.detail_no, line.part_no;

commit;

notify pgrst, 'reload schema';
