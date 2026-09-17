-- 同じ仕切り書No.の全明細を一つの処理でまとめて更新します。

begin;

create or replace function public.flexcon_bulk_update_purchase_statement(
  p_worker_id text,
  p_original_settlement_no text,
  p_movement_date date,
  p_settlement_no text,
  p_producer_name text,
  p_to_warehouse_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original_settlement_no text := btrim(coalesce(p_original_settlement_no, ''));
  v_line jsonb;
  v_line_count integer;
  v_source_count integer;
  v_updated_count integer := 0;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if nullif(v_original_settlement_no, '') is null then
    raise exception '編集元の仕切り書No.が不明です。';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception '更新する仕切り書明細がありません。';
  end if;

  select count(*) into v_line_count
  from (
    select distinct value->>'id' as id from jsonb_array_elements(p_lines)
  ) as requested;

  select count(*) into v_source_count
  from public.flexcon_purchase_statement_lines
  where settlement_no = v_original_settlement_no;

  if v_line_count = 0 or v_source_count = 0 then
    raise exception '更新する仕切り書明細が見つかりません。';
  end if;
  if v_line_count <> v_source_count then
    raise exception '仕切り書の明細数が変わりました。画面を閉じてからやり直してください。';
  end if;
  if btrim(coalesce(p_settlement_no, '')) <> v_original_settlement_no and exists (
    select 1 from public.flexcon_purchase_statement_lines
    where settlement_no = btrim(coalesce(p_settlement_no, ''))
  ) then
    raise exception '変更後の仕切り書No.は既に使用されています。';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as item
    where nullif(item->>'id', '') is null
       or not exists (
         select 1 from public.flexcon_purchase_statement_lines as line
         where line.id = (item->>'id')::uuid
           and line.settlement_no = v_original_settlement_no
       )
  ) then
    raise exception '別の仕切り書の明細が含まれています。画面を閉じてからやり直してください。';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    perform public.flexcon_update_purchase_statement_line(
      p_worker_id,
      (v_line->>'id')::uuid,
      p_movement_date,
      p_settlement_no,
      p_producer_name,
      v_line->>'origin',
      v_line->>'product_name',
      (v_line->>'quantity')::numeric,
      v_line->>'unit',
      p_to_warehouse_id
    );
    v_updated_count := v_updated_count + 1;
  end loop;

  return jsonb_build_object('updated_count', v_updated_count);
end;
$$;

revoke all on function public.flexcon_bulk_update_purchase_statement(text, text, date, text, text, uuid, jsonb) from public;
grant execute on function public.flexcon_bulk_update_purchase_statement(text, text, date, text, text, uuid, jsonb) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
