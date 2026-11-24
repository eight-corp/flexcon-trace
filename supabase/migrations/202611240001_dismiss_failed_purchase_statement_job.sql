begin;

alter table public.flexcon_purchase_statement_jobs
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by_worker_id text references public.workers(worker_id);

insert into flexcon_undo_private.tables(table_name,pk_columns,foreign_keys)
  values('flexcon_purchase_statement_jobs',array['id'],'[]'::jsonb)
  on conflict(table_name) do nothing;

-- The queue worker must not acquire the undo lock on lease/retry/status updates.
create or replace trigger flexcon_queue_capture_dismissal after update of dismissed_at
  on public.flexcon_purchase_statement_jobs for each row
  when (old.dismissed_at is distinct from new.dismissed_at)
  execute function flexcon_undo_private.capture();

create or replace function public.flexcon_list_purchase_statement_jobs(p_worker_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id,'viewer');
  perform public.flexcon_require_active_worker(p_worker_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',j.id,'status',j.status,'reader_id',j.created_by_worker_id,'reader_name',j.created_by_worker_name,
    'created_at',j.created_at,'updated_at',j.updated_at,'attempts',j.attempts,'error',j.last_error,
    'document_number',coalesce(d.header->>'document_number',''),'confirmed',d.confirmed_at is not null
  ) order by j.created_at,j.id) from public.flexcon_purchase_statement_jobs j
    left join public.flexcon_purchase_statement_drafts d on d.id=j.id
    where j.dismissed_at is null
      and (j.status not in ('succeeded','cancelled') or coalesce(j.finished_at,j.updated_at)>clock_timestamp()-interval '1 day')),'[]'::jsonb);
end; $$;

create or replace function public.flexcon_dismiss_failed_purchase_statement_job(p_worker_id text,p_job_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.flexcon_purchase_statement_jobs; v_root boolean;
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id,'operator');
  perform public.flexcon_require_active_worker(p_worker_id);
  v_root:=flexcon_undo_private.prepare(p_worker_id,'flexcon_dismiss_failed_purchase_statement_job','purchase_statements');
  select * into v_job from public.flexcon_purchase_statement_jobs where id=p_job_id for update;
  if not found or v_job.status<>'failed' or v_job.dismissed_at is not null
    or exists(select 1 from public.flexcon_purchase_statement_drafts where id=p_job_id and confirmed_at is not null) then
    raise exception '待ち行列から外せるのは解析に失敗した画像だけです。一覧を再読み込みしてください。';
  end if;
  if v_job.created_by_worker_id<>p_worker_id then
    perform public.flexcon_require_admin_worker(p_worker_id);
  end if;
  update public.flexcon_purchase_statement_jobs set
    status='cancelled',dismissed_at=clock_timestamp(),dismissed_by_worker_id=p_worker_id,
    updated_at=clock_timestamp(),lease_token=null,lease_until=null
    where id=p_job_id;
  if v_root then perform flexcon_undo_private.finish(); end if;
end; $$;

revoke all on function public.flexcon_dismiss_failed_purchase_statement_job(text,uuid) from public,anon,authenticated;
grant execute on function public.flexcon_dismiss_failed_purchase_statement_job(text,uuid) to anon,authenticated;
notify pgrst,'reload schema';
commit;
