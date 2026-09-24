create or replace function public.flexcon_delete_memo(p_worker_id text, p_memo_no bigint)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_worker public.workers%rowtype;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);

  delete from public.flexcon_memos as memo
  where memo.memo_no = p_memo_no
    and memo.created_by_worker_id = v_worker.worker_id;

  if not found then
    raise exception '作成者本人のメモのみ削除できます。';
  end if;
end;
$$;

revoke all on function public.flexcon_delete_memo(text, bigint) from public;
grant execute on function public.flexcon_delete_memo(text, bigint) to anon, authenticated;
