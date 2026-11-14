begin;

create schema if not exists flexcon_queue_private;
revoke all on schema flexcon_queue_private from public, anon, authenticated;
create table if not exists flexcon_queue_private.settings (
  singleton boolean primary key default true check(singleton),
  secret text not null default (gen_random_uuid()::text || gen_random_uuid()::text),
  endpoint text not null default 'https://gkazhcddknmgzglcdwtk.supabase.co/functions/v1/purchase-statement-queue'
);
alter table flexcon_queue_private.settings add column if not exists gateway_key text not null default '';
insert into flexcon_queue_private.settings(singleton) values(true) on conflict do nothing;
alter table flexcon_queue_private.settings enable row level security;
revoke all on flexcon_queue_private.settings from public, anon, authenticated;

create table if not exists public.flexcon_purchase_statement_jobs (
  id uuid primary key,
  created_by_worker_id text not null references public.workers(worker_id),
  created_by_worker_name text not null,
  fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
  upload_id uuid not null default gen_random_uuid(),
  status text not null default 'uploading',
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  last_error text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);
alter table public.flexcon_purchase_statement_jobs add column if not exists undo_operation_id uuid;
alter table public.flexcon_purchase_statement_jobs drop constraint if exists flexcon_purchase_statement_jobs_status_check;
alter table public.flexcon_purchase_statement_jobs add constraint flexcon_purchase_statement_jobs_status_check
  check(status in ('uploading','queued','processing','succeeded','failed','cancelled'));
create index if not exists flexcon_purchase_statement_jobs_active on public.flexcon_purchase_statement_jobs(status,created_at);
alter table public.flexcon_purchase_statement_jobs enable row level security;
revoke all on public.flexcon_purchase_statement_jobs from public, anon, authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('purchase-statement-queue','purchase-statement-queue',false,32000000,array['application/json'])
on conflict(id) do nothing;

create or replace function flexcon_queue_private.dispatch()
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_settings flexcon_queue_private.settings;
begin
  if not exists(select 1 from public.flexcon_purchase_statement_jobs where status='queued'
    or (status='processing' and lease_until<clock_timestamp())) then return; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  select * into v_settings from flexcon_queue_private.settings where singleton;
  if v_settings.gateway_key='' then return; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 10000)'
    using v_settings.endpoint, jsonb_build_object('action','work'),
      jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_settings.gateway_key,'x-queue-secret',v_settings.secret);
end; $$;

create or replace function public.flexcon_purchase_queue_reserve(p_worker_id text,p_job_id uuid,p_fingerprint text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_worker public.workers; v_job public.flexcon_purchase_statement_jobs;
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id,'operator');
  v_worker:=public.flexcon_require_active_worker(p_worker_id);
  if p_job_id is null or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then raise exception '画像IDが不正です。'; end if;
  insert into public.flexcon_purchase_statement_jobs(id,created_by_worker_id,created_by_worker_name,fingerprint)
    values(p_job_id,v_worker.worker_id,v_worker.worker_name,p_fingerprint) on conflict do nothing;
  select * into v_job from public.flexcon_purchase_statement_jobs where id=p_job_id for update;
  if v_job.created_by_worker_id<>p_worker_id or v_job.fingerprint<>p_fingerprint then raise exception '同じ画像IDの内容が一致しません。'; end if;
  return jsonb_build_object('id',v_job.id,'status',v_job.status,'uploadId',v_job.upload_id);
end; $$;

create or replace function public.flexcon_purchase_queue_ready(p_worker_id text,p_job_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.flexcon_purchase_statement_jobs; v_operation uuid;
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id,'operator');
  perform public.flexcon_require_active_worker(p_worker_id);
  perform pg_advisory_xact_lock(19661016,1);
  select * into v_job from public.flexcon_purchase_statement_jobs where id=p_job_id and created_by_worker_id=p_worker_id for update;
  if not found then raise exception '読取画像が見つかりません。'; end if;
  if v_job.status='uploading' then
    -- A hidden receipt lets the existing one-step Undo cancel even an in-flight analysis.
    perform public.flexcon_submit_purchase_statement(p_worker_id,p_job_id,'camera','{}','[{}]','[]');
    if to_regprocedure('public.flexcon_attach_purchase_statement_image(text,uuid,text)') is not null then
      perform public.flexcon_attach_purchase_statement_image(p_worker_id,p_job_id,p_job_id::text||'/'||v_job.upload_id::text||'.jpg');
    else
      update public.flexcon_purchase_statement_drafts set image_path=p_job_id::text||'/'||v_job.upload_id::text||'.jpg' where id=p_job_id;
    end if;
    if to_regclass('flexcon_undo_private.heads') is not null then
      execute 'select operation_id from flexcon_undo_private.heads where worker_id=$1' into v_operation using p_worker_id;
    end if;
    update public.flexcon_purchase_statement_jobs set status='queued',undo_operation_id=v_operation,updated_at=clock_timestamp() where id=p_job_id;
  end if;
  perform flexcon_queue_private.dispatch();
end; $$;

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
    where j.status not in ('succeeded','cancelled') or coalesce(j.finished_at,j.updated_at)>clock_timestamp()-interval '1 day'),'[]'::jsonb);
end; $$;

create or replace function public.flexcon_purchase_queue_image(p_worker_id text,p_job_id uuid)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_path text;
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id,'viewer');
  perform public.flexcon_require_active_worker(p_worker_id);
  select id::text||'/'||upload_id::text||'.jpg' into v_path from public.flexcon_purchase_statement_jobs
    where id=p_job_id and status<>'uploading';
  if not found then raise exception '保存済みの画像がありません。'; end if;
  return v_path;
end; $$;

create or replace function public.flexcon_retry_purchase_statement_job(p_worker_id text,p_job_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id,'operator');
  perform public.flexcon_require_active_worker(p_worker_id);
  update public.flexcon_purchase_statement_jobs set status='queued',attempts=0,last_error='',updated_at=clock_timestamp(),lease_token=null,lease_until=null
    where id=p_job_id and status='failed';
  if not found then raise exception '再試行できる画像がありません。一覧を再読み込みしてください。'; end if;
  perform flexcon_queue_private.dispatch();
end; $$;

-- These worker RPCs are callable only with the server-side service role.
create or replace function public.flexcon_purchase_queue_claim(p_secret text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.flexcon_purchase_statement_jobs;
begin
  if p_secret is null or not exists(select 1 from flexcon_queue_private.settings where secret=p_secret) then raise exception 'unauthorized'; end if;
  perform pg_advisory_xact_lock(19661114,1);
  update public.flexcon_purchase_statement_jobs set status='failed',last_error='解析が時間内に完了しませんでした。再試行してください。',lease_token=null,lease_until=null,updated_at=clock_timestamp()
    where status='processing' and lease_until<clock_timestamp() and attempts>=3;
  if exists(select 1 from public.flexcon_purchase_statement_jobs where status='processing' and lease_until>=clock_timestamp()) then return null; end if;
  select * into v_job from public.flexcon_purchase_statement_jobs
    where status='queued' or (status='processing' and lease_until<clock_timestamp())
    order by created_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.flexcon_purchase_statement_jobs set status='processing',attempts=attempts+1,
    lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '3 minutes',updated_at=clock_timestamp()
    where id=v_job.id returning * into v_job;
  return jsonb_build_object('id',v_job.id,'leaseToken',v_job.lease_token,'payloadPath',v_job.id::text||'/'||v_job.upload_id::text||'.json',
    'imagePath',v_job.id::text||'/'||v_job.upload_id::text||'.jpg');
end; $$;

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
  update public.flexcon_purchase_statement_drafts set header=p_header,items=p_items,reading_warnings=p_warnings,updated_at=clock_timestamp()
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

create or replace function flexcon_queue_private.guard_draft()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' then
    update public.flexcon_purchase_statement_jobs set status='cancelled',lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=old.id;
    return old;
  elsif tg_op='INSERT' then
    update public.flexcon_purchase_statement_jobs set status='succeeded',updated_at=clock_timestamp()
      where id=new.id and status='cancelled' and finished_at is not null;
  elsif new.confirmed_at is not null and exists(select 1 from public.flexcon_purchase_statement_jobs where id=new.id and status<>'succeeded') then
    raise exception '画像の解析が完了していません。';
  end if;
  return new;
end; $$;
drop trigger if exists flexcon_queue_draft_confirm_guard on public.flexcon_purchase_statement_drafts;
create trigger flexcon_queue_draft_confirm_guard before update on public.flexcon_purchase_statement_drafts
  for each row execute function flexcon_queue_private.guard_draft();
drop trigger if exists flexcon_queue_draft_lifecycle on public.flexcon_purchase_statement_drafts;
create trigger flexcon_queue_draft_lifecycle after insert or delete on public.flexcon_purchase_statement_drafts
  for each row execute function flexcon_queue_private.guard_draft();

create or replace function public.flexcon_list_pending_purchase_statements(p_worker_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id,'viewer');
  perform public.flexcon_require_active_worker(p_worker_id);
  return coalesce((select jsonb_agg(draft.header || jsonb_build_object(
      'id',draft.id,'pending',true,'source_type',draft.source_type,'image_path',coalesce(draft.image_path,''),'warnings',draft.reading_warnings,
      'created_by_worker_id',draft.created_by_worker_id,'created_by_worker_name',draft.created_by_worker_name,
      'created_at',draft.created_at,'updated_at',draft.updated_at,
      'items',(select jsonb_agg(item.value || jsonb_build_object('id',draft.id::text||':'||item.position,'line_no',item.position) order by item.position)
        from jsonb_array_elements(draft.items) with ordinality item(value,position))
    ) order by draft.created_at desc,draft.id)
    from public.flexcon_purchase_statement_drafts draft where draft.confirmed_at is null
      and not exists(select 1 from public.flexcon_purchase_statement_jobs j where j.id=draft.id and j.status<>'succeeded')),'[]'::jsonb);
end; $$;

create or replace function public.flexcon_purchase_queue_fail(p_job_id uuid,p_lease_token uuid,p_error text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.flexcon_purchase_statement_jobs set status='failed',last_error=left(coalesce(p_error,'解析を完了できませんでした。'),1000),
    lease_token=null,lease_until=null,updated_at=clock_timestamp()
    where id=p_job_id and status='processing' and lease_token=p_lease_token and lease_until>=clock_timestamp();
  if not found then return false; end if;
  perform flexcon_queue_private.dispatch();
  return true;
end; $$;

revoke all on all functions in schema flexcon_queue_private from public,anon,authenticated;
revoke all on function public.flexcon_purchase_queue_reserve(text,uuid,text) from public;
revoke all on function public.flexcon_purchase_queue_ready(text,uuid) from public;
revoke all on function public.flexcon_list_purchase_statement_jobs(text) from public;
revoke all on function public.flexcon_retry_purchase_statement_job(text,uuid) from public;
revoke all on function public.flexcon_purchase_queue_image(text,uuid) from public;
grant execute on function public.flexcon_purchase_queue_reserve(text,uuid,text),public.flexcon_purchase_queue_ready(text,uuid),
  public.flexcon_list_purchase_statement_jobs(text),public.flexcon_retry_purchase_statement_job(text,uuid),public.flexcon_purchase_queue_image(text,uuid) to anon,authenticated;
revoke all on function public.flexcon_purchase_queue_claim(text),public.flexcon_purchase_queue_complete(uuid,uuid,jsonb,jsonb,jsonb),public.flexcon_purchase_queue_fail(uuid,uuid,text) from public,anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function public.flexcon_purchase_queue_claim(text),public.flexcon_purchase_queue_complete(uuid,uuid,jsonb,jsonb,jsonb),public.flexcon_purchase_queue_fail(uuid,uuid,text) to service_role;
  end if;
end; $$;
notify pgrst,'reload schema';
commit;
