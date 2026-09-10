-- 米穀出荷管理を共通ユーザー・共通PIN・アプリ別権限へ切り替えます。
begin;

create or replace function public.flexcon_require_active_worker(p_worker_id text)
returns public.workers
language plpgsql
security definer
set search_path = pg_catalog, public, business_private
as $$
declare
  v_worker public.workers%rowtype;
begin
  select * into v_worker
  from public.workers
  where worker_id = btrim(coalesce(p_worker_id, ''))
    and active = true;

  if not found then
    raise exception '作業者が無効です。もう一度ログインしてください。';
  end if;

  perform business_private.require_app('rice_shipping', 'operator', v_worker.worker_id);
  return v_worker;
end;
$$;

create or replace function public.flexcon_require_admin_worker(p_worker_id text)
returns public.workers
language plpgsql
security definer
set search_path = pg_catalog, public, business_private
as $$
declare
  v_worker public.workers%rowtype;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  perform business_private.require_app('rice_shipping', 'admin', v_worker.worker_id);
  return v_worker;
end;
$$;

update business_private.apps
set migrated = true
where app_id = 'rice_shipping';

commit;
