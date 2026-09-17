-- 管理者だけが手動入出庫記録と仕切り書明細をまとめて削除できます。

begin;

create or replace function public.flexcon_bulk_delete_inventory_records(
  p_worker_id text,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested_count integer;
  v_existing_count integer;
  v_manual_count integer := 0;
  v_statement_count integer := 0;
begin
  perform public.flexcon_require_admin_worker(p_worker_id);

  if p_records is null or jsonb_typeof(p_records) <> 'array' then
    raise exception '削除する在庫記録を選択してください。';
  end if;

  select count(*) into v_requested_count
  from (
    select distinct value->>'source_type' as source_type, value->>'id' as id
    from jsonb_array_elements(p_records)
  ) as requested;

  if v_requested_count = 0 then
    raise exception '削除する在庫記録を選択してください。';
  end if;
  if v_requested_count > 1000 then
    raise exception '一度に削除できるのは1000件までです。';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_records) as item
    where item->>'source_type' not in ('manual', 'settlement')
       or nullif(item->>'id', '') is null
  ) then
    raise exception '削除対象に不正な在庫記録が含まれています。';
  end if;

  with requested as (
    select distinct value->>'source_type' as source_type, (value->>'id')::uuid as id
    from jsonb_array_elements(p_records)
  )
  select count(*) into v_existing_count
  from requested
  where (source_type = 'manual' and exists (select 1 from public.flexcon_inventory_movements where id = requested.id))
     or (source_type = 'settlement' and exists (select 1 from public.flexcon_purchase_statement_lines where id = requested.id));

  if v_existing_count <> v_requested_count then
    raise exception '削除対象の一部が見つかりません。画面を更新してからやり直してください。';
  end if;

  with requested as (
    select distinct (value->>'id')::uuid as id
    from jsonb_array_elements(p_records)
    where value->>'source_type' = 'manual'
  ), deleted as (
    delete from public.flexcon_inventory_movements
    where id in (select id from requested)
    returning id
  )
  select count(*) into v_manual_count from deleted;

  with requested as (
    select distinct (value->>'id')::uuid as id
    from jsonb_array_elements(p_records)
    where value->>'source_type' = 'settlement'
  ), deleted as (
    delete from public.flexcon_purchase_statement_lines
    where id in (select id from requested)
    returning id
  )
  select count(*) into v_statement_count from deleted;

  delete from public.flexcon_purchase_import_batches as batch
  where not exists (
    select 1 from public.flexcon_purchase_statement_lines as line where line.batch_id = batch.id
  );

  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '選択した記録を削除すると倉庫在庫が不足するため、削除できません。対象を見直してください。';
  end if;

  return jsonb_build_object(
    'deleted_count', v_manual_count + v_statement_count,
    'manual_count', v_manual_count,
    'statement_count', v_statement_count
  );
end;
$$;

revoke all on function public.flexcon_bulk_delete_inventory_records(text, jsonb) from public;
grant execute on function public.flexcon_bulk_delete_inventory_records(text, jsonb) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
