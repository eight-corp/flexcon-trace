-- 登録No.に含まれる推フレ・バラ・紙袋へ、共通の検査情報を一括設定します。

begin;

create or replace function public.flexcon_set_inspection_registration_metadata(
  p_worker_id text,
  p_registration_id uuid,
  p_inspection_date date,
  p_inspector_name text,
  p_inspection_location text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inspector_name text := nullif(btrim(p_inspector_name), '');
  v_inspection_location text := nullif(btrim(p_inspection_location), '');
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if not exists (
    select 1
    from public.flexcon_inspection_registrations as registration
    where registration.id = p_registration_id
  ) then
    raise exception '一括設定する検査記録が見つかりません。';
  end if;

  if p_inspection_date is null then
    raise exception '検査日を入力してください。';
  end if;
  if v_inspector_name is null then
    raise exception '検査員を選択してください。';
  end if;
  if v_inspection_location is null then
    raise exception '検査場所を選択してください。';
  end if;

  if not exists (
    select 1
    from public.flexcon_inspection_options as inspection_option
    where inspection_option.option_type = 'inspector'
      and inspection_option.active = true
      and inspection_option.name = v_inspector_name
  ) then
    raise exception '選択した検査員はマスタに登録されていません。';
  end if;

  if not exists (
    select 1
    from public.flexcon_inspection_options as inspection_option
    where inspection_option.option_type = 'location'
      and inspection_option.active = true
      and inspection_option.name = v_inspection_location
  ) then
    raise exception '選択した検査場所はマスタに登録されていません。';
  end if;

  update public.flexcon_inspection_flexcons
  set inspection_date = p_inspection_date,
      inspector_name = v_inspector_name,
      inspection_location = v_inspection_location,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where registration_id = p_registration_id;

  update public.flexcon_inspection_paper_bags
  set inspection_date = p_inspection_date,
      inspector_name = v_inspector_name,
      inspection_location = v_inspection_location,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where registration_id = p_registration_id;
end;
$$;

revoke all on function public.flexcon_set_inspection_registration_metadata(text, uuid, date, text, text) from public;
grant execute on function public.flexcon_set_inspection_registration_metadata(text, uuid, date, text, text) to anon, authenticated;

commit;
