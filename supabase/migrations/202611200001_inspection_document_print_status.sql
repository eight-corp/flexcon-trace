begin;

create table if not exists public.flexcon_inspection_document_prints (
  authorization_id uuid not null references public.flexcon_authorizations(id) on delete cascade,
  document_kind text not null check (document_kind in ('grading_notice', 'inspection_ledger')),
  print_count integer not null check (print_count > 0),
  last_printed_at timestamptz not null,
  last_printed_by_worker_id text not null references public.workers(worker_id),
  primary key (authorization_id, document_kind)
);

alter table public.flexcon_inspection_document_prints enable row level security;
revoke all on table public.flexcon_inspection_document_prints from public, anon, authenticated;

create or replace function public.flexcon_inspection_document_print_status(
  p_worker_id text,
  p_authorization_id uuid,
  p_printed_document text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if p_printed_document is not null then
    insert into public.flexcon_inspection_document_prints as status
      (authorization_id, document_kind, print_count, last_printed_at, last_printed_by_worker_id)
    values (p_authorization_id, p_printed_document, 1, now(), p_worker_id)
    on conflict (authorization_id, document_kind) do update
    set print_count = status.print_count + 1,
        last_printed_at = excluded.last_printed_at,
        last_printed_by_worker_id = excluded.last_printed_by_worker_id;
  end if;

  return coalesce((
    select jsonb_object_agg(document_kind, print_count)
    from public.flexcon_inspection_document_prints
    where authorization_id = p_authorization_id
  ), '{}'::jsonb);
end;
$$;

revoke all on function public.flexcon_inspection_document_print_status(text, uuid, text) from public;
grant execute on function public.flexcon_inspection_document_print_status(text, uuid, text) to anon, authenticated;

commit;
