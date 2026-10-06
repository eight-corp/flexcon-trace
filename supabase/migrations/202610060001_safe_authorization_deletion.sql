-- 検査記録・在庫の連鎖削除を防ぎます。
begin;

create or replace function public.flexcon_delete_authorization(
  p_worker_id text,
  p_authorization_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  -- FK inserts acquire a key-share lock, so new records cannot race this check.
  perform 1 from public.flexcon_authorizations
  where id = p_authorization_id for update;
  if not found then
    raise exception '委任状情報が見つかりません。';
  end if;

  if exists (select 1 from public.flexcon_inspection_registrations where authorization_id = p_authorization_id)
    or exists (select 1 from public.flexcon_inspection_flexcons where authorization_id = p_authorization_id)
    or exists (select 1 from public.flexcon_inspection_paper_bags where authorization_id = p_authorization_id) then
    raise exception '検査記録がある委任状は削除できません。';
  end if;

  delete from public.flexcon_authorizations where id = p_authorization_id;
exception
  when foreign_key_violation then
    raise exception '関連する記録がある委任状は削除できません。';
end;
$$;

revoke all on function public.flexcon_delete_authorization(text, uuid) from public;
grant execute on function public.flexcon_delete_authorization(text, uuid) to anon, authenticated;

commit;
