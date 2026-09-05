-- Add master deletion without changing existing inspection or shipment records.
begin;

create or replace function public.flexcon_delete_destination(
  p_worker_id text,
  p_destination_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  delete from public.flexcon_destinations
  where id = p_destination_id;

  if not found then
    raise exception '納品先が見つかりません。一覧を再読み込みしてください。';
  end if;
exception
  when foreign_key_violation then
    raise exception '納品先は履歴で使用されているため削除できません。使用を停止する場合は無効にしてください。';
end;
$$;

revoke all on function public.flexcon_delete_destination(text, uuid) from public;
grant execute on function public.flexcon_delete_destination(text, uuid) to anon, authenticated;

create or replace function public.flexcon_delete_transport_profile(
  p_worker_id text,
  p_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  delete from public.flexcon_transport_profiles
  where id = p_profile_id;

  if not found then
    raise exception '運送会社が見つかりません。一覧を再読み込みしてください。';
  end if;
exception
  when foreign_key_violation then
    raise exception '運送会社は履歴で使用されているため削除できません。使用を停止する場合は無効にしてください。';
end;
$$;

revoke all on function public.flexcon_delete_transport_profile(text, uuid) from public;
grant execute on function public.flexcon_delete_transport_profile(text, uuid) to anon, authenticated;

create or replace function public.flexcon_delete_inspection_option(
  p_worker_id text,
  p_option_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  delete from public.flexcon_inspection_options
  where id = p_option_id;

  if not found then
    raise exception '検査項目が見つかりません。一覧を再読み込みしてください。';
  end if;
exception
  when foreign_key_violation then
    raise exception '検査項目は履歴で使用されているため削除できません。使用を停止する場合は無効にしてください。';
end;
$$;

revoke all on function public.flexcon_delete_inspection_option(text, uuid) from public;
grant execute on function public.flexcon_delete_inspection_option(text, uuid) to anon, authenticated;

commit;

