begin;

create or replace function public.flexcon_list_inspection_document_print_status(p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  return coalesce((
    select jsonb_object_agg(authorization_id, counts)
    from (
      select authorization_id, jsonb_object_agg(document_kind, print_count) as counts
      from public.flexcon_inspection_document_prints
      group by authorization_id
    ) as documents
  ), '{}'::jsonb);
end;
$$;

revoke all on function public.flexcon_list_inspection_document_print_status(text) from public;
grant execute on function public.flexcon_list_inspection_document_print_status(text) to anon, authenticated;

commit;
