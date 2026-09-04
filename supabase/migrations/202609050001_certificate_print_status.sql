-- 検査証明書PDFの印刷回数と最終印刷情報をフレコンごとに記録します。

begin;

alter table public.flexcon_inspection_flexcons
  add column if not exists certificate_print_count integer not null default 0,
  add column if not exists certificate_last_printed_at timestamptz,
  add column if not exists certificate_last_printed_by_worker_id text references public.workers(worker_id);

alter table public.flexcon_inspection_flexcons
  drop constraint if exists flexcon_inspection_flexcons_print_count_check;

alter table public.flexcon_inspection_flexcons
  add constraint flexcon_inspection_flexcons_print_count_check
  check (certificate_print_count >= 0);

create or replace function public.flexcon_mark_certificates_printed(
  p_worker_id text,
  p_flexcon_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested_count integer;
  v_updated_count integer;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  v_requested_count := coalesce(cardinality(p_flexcon_ids), 0);
  if v_requested_count = 0 then
    raise exception '印刷したフレコンを指定してください。';
  end if;

  update public.flexcon_inspection_flexcons
  set certificate_print_count = certificate_print_count + 1,
      certificate_last_printed_at = now(),
      certificate_last_printed_by_worker_id = p_worker_id
  where id = any(p_flexcon_ids);

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_requested_count then
    raise exception '一部のフレコンが見つからないため、印刷済みにできませんでした。';
  end if;

  return v_updated_count;
end;
$$;

revoke all on function public.flexcon_mark_certificates_printed(text, uuid[]) from public;
grant execute on function public.flexcon_mark_certificates_printed(text, uuid[]) to anon, authenticated;

commit;
