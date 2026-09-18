-- 撮影した仕切書画像を非公開Storageへ保存し、仕切書と紐付けます。

begin;

alter table public.flexcon_purchase_statements
  add column if not exists image_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'purchase-statement-images',
  'purchase-statement-images',
  false,
  9000000,
  array['image/jpeg']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

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
    'image_path', statement.image_path,
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

commit;

notify pgrst, 'reload schema';
