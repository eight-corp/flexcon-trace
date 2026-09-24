-- 一括設定で指定しなかった検査項目は既存値を維持します。

begin;

create or replace function public.flexcon_set_inspection_registration_metadata(
  p_worker_id text,
  p_registration_id uuid,
  p_inspection_date date,
  p_inspector_name text,
  p_inspection_location text,
  p_grade text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inspector_name text := nullif(btrim(p_inspector_name), '');
  v_inspection_location text := nullif(btrim(p_inspection_location), '');
  v_grade text := nullif(btrim(p_grade), '');
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if not exists (
    select 1 from public.flexcon_inspection_registrations
    where id = p_registration_id
  ) then
    raise exception '一括設定する検査記録が見つかりません。';
  end if;

  if p_inspection_date is null and v_inspector_name is null
     and v_inspection_location is null and v_grade is null then
    raise exception '反映する項目を1つ以上入力してください。';
  end if;

  if v_inspector_name is not null and not exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'inspector' and active = true and name = v_inspector_name
  ) then
    raise exception '選択した検査員はマスタに登録されていません。';
  end if;

  if v_inspection_location is not null and not exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'location' and active = true and name = v_inspection_location
  ) then
    raise exception '選択した検査場所はマスタに登録されていません。';
  end if;

  if v_grade is not null and not exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'grade' and active = true and name = v_grade
  ) then
    raise exception '選択した等級はマスタに登録されていません。';
  end if;

  if v_grade = '合格' and (
    exists (
      select 1 from public.flexcon_inspection_flexcons
      where registration_id = p_registration_id and btrim(coalesce(brand, '')) <> '飼料用玄米'
    ) or exists (
      select 1 from public.flexcon_inspection_paper_bags
      where registration_id = p_registration_id and btrim(coalesce(brand, '')) <> '飼料用玄米'
    )
  ) then
    raise exception '飼料用玄米以外には合格を設定できません。';
  end if;

  if v_grade is not null and v_grade <> '合格' and (
    exists (
      select 1 from public.flexcon_inspection_flexcons
      where registration_id = p_registration_id and btrim(coalesce(brand, '')) = '飼料用玄米'
    ) or exists (
      select 1 from public.flexcon_inspection_paper_bags
      where registration_id = p_registration_id and btrim(coalesce(brand, '')) = '飼料用玄米'
    )
  ) then
    raise exception '飼料用玄米には合格だけを設定できます。';
  end if;

  update public.flexcon_inspection_flexcons
  set inspection_date = coalesce(p_inspection_date, inspection_date),
      inspector_name = coalesce(v_inspector_name, inspector_name),
      inspection_location = coalesce(v_inspection_location, inspection_location),
      grade = coalesce(v_grade, grade),
      reason = case when v_grade in ('1等', '合格') then null else reason end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where registration_id = p_registration_id;

  update public.flexcon_inspection_paper_bags
  set inspection_date = coalesce(p_inspection_date, inspection_date),
      inspector_name = coalesce(v_inspector_name, inspector_name),
      inspection_location = coalesce(v_inspection_location, inspection_location),
      grade = coalesce(v_grade, grade),
      reason = case when v_grade in ('1等', '合格') then null else reason end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where registration_id = p_registration_id;
end;
$$;

revoke all on function public.flexcon_set_inspection_registration_metadata(text, uuid, date, text, text, text) from public;
grant execute on function public.flexcon_set_inspection_registration_metadata(text, uuid, date, text, text, text) to anon, authenticated;

commit;
