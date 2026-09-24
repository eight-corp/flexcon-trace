-- Shared worker sessions can read memos; only the creator can change one.
create table if not exists public.flexcon_memos (
  memo_no bigint generated always as identity primary key,
  body text not null check (char_length(btrim(body)) between 1 and 10000),
  created_by_worker_id text not null references public.workers(worker_id),
  created_by_worker_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.flexcon_memos enable row level security;
revoke all on public.flexcon_memos from anon, authenticated;

create or replace function public.flexcon_list_memos(p_worker_id text)
returns table (
  memo_no bigint,
  body text,
  created_by_worker_id text,
  created_by_worker_name text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  return query
    select memo.memo_no, memo.body, memo.created_by_worker_id,
           memo.created_by_worker_name, memo.created_at, memo.updated_at
    from public.flexcon_memos as memo
    order by memo.memo_no desc;
end;
$$;

create or replace function public.flexcon_add_memo(p_worker_id text, p_body text)
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

  insert into public.flexcon_memos (body, created_by_worker_id, created_by_worker_name)
  values (p_body, v_worker.worker_id, v_worker.worker_name)
  returning memo_no into v_memo_no;
  return v_memo_no;
end;
$$;

create or replace function public.flexcon_update_memo(p_worker_id text, p_memo_no bigint, p_body text)
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
  set body = p_body, updated_at = now()
  where memo.memo_no = p_memo_no
    and memo.created_by_worker_id = v_worker.worker_id;

  if not found then
    raise exception '作成者本人のメモのみ編集できます。';
  end if;
end;
$$;

revoke all on function public.flexcon_list_memos(text) from public;
revoke all on function public.flexcon_add_memo(text, text) from public;
revoke all on function public.flexcon_update_memo(text, bigint, text) from public;
grant execute on function public.flexcon_list_memos(text) to anon, authenticated;
grant execute on function public.flexcon_add_memo(text, text) to anon, authenticated;
grant execute on function public.flexcon_update_memo(text, bigint, text) to anon, authenticated;
