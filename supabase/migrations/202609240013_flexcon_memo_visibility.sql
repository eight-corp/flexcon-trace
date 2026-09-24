begin;

-- Existing memos were shared with all workers; keep their current visibility.
alter table public.flexcon_memos
  add column if not exists is_public boolean not null default true;
alter table public.flexcon_memos
  alter column is_public set default false;

drop function if exists public.flexcon_list_memos(text);

create function public.flexcon_list_memos(p_worker_id text)
returns table (
  memo_no bigint,
  body text,
  created_by_worker_id text,
  created_by_worker_name text,
  created_at timestamptz,
  updated_at timestamptz,
  is_public boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_worker public.workers%rowtype;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  return query
    select memo.memo_no, memo.body, memo.created_by_worker_id,
           memo.created_by_worker_name, memo.created_at, memo.updated_at,
           memo.is_public
    from public.flexcon_memos as memo
    where memo.is_public or memo.created_by_worker_id = v_worker.worker_id
    order by memo.memo_no desc;
end;
$$;

create or replace function public.flexcon_add_memo_visible(
  p_worker_id text, p_body text, p_is_public boolean
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_worker public.workers%rowtype;
  v_memo_no bigint;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 10000 then
    raise exception 'メモは1文字から10000文字で入力してください。';
  end if;

  insert into public.flexcon_memos (body, is_public, created_by_worker_id, created_by_worker_name)
  values (p_body, coalesce(p_is_public, false), v_worker.worker_id, v_worker.worker_name)
  returning memo_no into v_memo_no;
  return v_memo_no;
end;
$$;

create or replace function public.flexcon_update_memo_visible(
  p_worker_id text, p_memo_no bigint, p_body text, p_is_public boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_worker public.workers%rowtype;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 10000 then
    raise exception 'メモは1文字から10000文字で入力してください。';
  end if;

  update public.flexcon_memos as memo
  set body = p_body, is_public = coalesce(p_is_public, false), updated_at = now()
  where memo.memo_no = p_memo_no
    and memo.created_by_worker_id = v_worker.worker_id;

  if not found then
    raise exception '作成者本人のメモのみ編集できます。';
  end if;
end;
$$;

create or replace function public.flexcon_set_memo_visibility(
  p_worker_id text, p_memo_no bigint, p_is_public boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_worker public.workers%rowtype;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);

  update public.flexcon_memos as memo
  set is_public = coalesce(p_is_public, false), updated_at = now()
  where memo.memo_no = p_memo_no
    and memo.created_by_worker_id = v_worker.worker_id;

  if not found then
    raise exception '作成者本人のメモのみ公開設定を変更できます。';
  end if;
end;
$$;

revoke all on function public.flexcon_list_memos(text) from public;
revoke all on function public.flexcon_add_memo_visible(text, text, boolean) from public;
revoke all on function public.flexcon_update_memo_visible(text, bigint, text, boolean) from public;
revoke all on function public.flexcon_set_memo_visibility(text, bigint, boolean) from public;
grant execute on function public.flexcon_list_memos(text) to anon, authenticated;
grant execute on function public.flexcon_add_memo_visible(text, text, boolean) to anon, authenticated;
grant execute on function public.flexcon_update_memo_visible(text, bigint, text, boolean) to anon, authenticated;
grant execute on function public.flexcon_set_memo_visibility(text, bigint, boolean) to anon, authenticated;

commit;
