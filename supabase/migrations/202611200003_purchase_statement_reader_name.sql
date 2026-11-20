begin;

-- Set the recipient from the authenticated reader recorded at enqueue time.
create or replace function public.flexcon_purchase_queue_complete(p_job_id uuid,p_lease_token uuid,p_header jsonb,p_items jsonb,p_warnings jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.flexcon_purchase_statement_jobs; v_operation uuid;
begin
  -- Match undo's lock order before touching drafts, without changing a user's undo head asynchronously.
  perform pg_advisory_xact_lock(19661016,1);
  select * into v_job from public.flexcon_purchase_statement_jobs where id=p_job_id for update;
  if not found or v_job.status<>'processing' or v_job.lease_token is distinct from p_lease_token or v_job.lease_until<clock_timestamp() then return false; end if;
  if jsonb_typeof(p_header) is distinct from 'object' or jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_typeof(p_warnings) is distinct from 'array' then raise exception '読取結果が不正です。'; end if;
  if jsonb_array_length(p_items)=0 or exists(select 1 from jsonb_array_elements(p_items) item where jsonb_typeof(item)<>'object') then raise exception '読取明細がありません。'; end if;
  if v_job.undo_operation_id is not null and to_regclass('flexcon_undo_private.heads') is not null then
    execute 'select h.operation_id from flexcon_undo_private.heads h join flexcon_undo_private.operations o on o.id=h.operation_id where h.worker_id=$1 and h.operation_id=$2 and o.undone_at is null'
      into v_operation using v_job.created_by_worker_id,v_job.undo_operation_id;
  end if;
  if v_operation is not null then
    perform set_config('flexcon_undo.operation',v_operation::text,true);
    perform set_config('flexcon_undo.worker',v_job.created_by_worker_id,true);
  end if;
  update public.flexcon_purchase_statement_drafts set header=p_header || jsonb_build_object('recipient',v_job.created_by_worker_name),items=p_items,reading_warnings=p_warnings,updated_at=clock_timestamp()
    where id=v_job.id and confirmed_at is null;
  if not found then return false; end if;
  if v_operation is not null then
    perform set_config('flexcon_undo.operation','',true);
    perform set_config('flexcon_undo.worker','',true);
  end if;
  update public.flexcon_purchase_statement_jobs set status='succeeded',finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=null,lease_until=null,last_error='' where id=v_job.id;
  perform flexcon_queue_private.dispatch();
  return true;
end; $$;

commit;
