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
  perform 1 from public.flexcon_inspection_registrations
  where id = p_registration_id for update;
  if not found then
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

  -- Lock details before validation so concurrent edits cannot change the grade targets.
  perform 1 from public.flexcon_inspection_flexcons
  where registration_id = p_registration_id order by id for update;
  perform 1 from public.flexcon_inspection_paper_bags
  where registration_id = p_registration_id order by id for update;
  if v_grade is not null and exists (
    select 1 from (
      select brand, grade from public.flexcon_inspection_flexcons where registration_id = p_registration_id
      union all
      select brand, grade from public.flexcon_inspection_paper_bags where registration_id = p_registration_id
    ) as detail
    where nullif(btrim(detail.grade), '') is null
      and ((v_grade = '合格' and btrim(coalesce(detail.brand, '')) <> '飼料用玄米')
        or (v_grade <> '合格' and btrim(coalesce(detail.brand, '')) = '飼料用玄米'))
  ) then
    raise exception '未設定の明細の銘柄に設定できない等級が選択されています。';
  end if;

  update public.flexcon_inspection_flexcons
  set inspection_date = coalesce(inspection_date, p_inspection_date),
      inspector_name = case when nullif(btrim(inspector_name), '') is null then coalesce(v_inspector_name, inspector_name) else inspector_name end,
      inspection_location = case when nullif(btrim(inspection_location), '') is null then coalesce(v_inspection_location, inspection_location) else inspection_location end,
      grade = case when nullif(btrim(grade), '') is null then coalesce(v_grade, grade) else grade end,
      reason = case when nullif(btrim(grade), '') is null and v_grade in ('1等', '合格') then null else reason end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where registration_id = p_registration_id
    and ((p_inspection_date is not null and inspection_date is null)
      or (v_inspector_name is not null and nullif(btrim(inspector_name), '') is null)
      or (v_inspection_location is not null and nullif(btrim(inspection_location), '') is null)
      or (v_grade is not null and nullif(btrim(grade), '') is null));

  update public.flexcon_inspection_paper_bags
  set inspection_date = coalesce(inspection_date, p_inspection_date),
      inspector_name = case when nullif(btrim(inspector_name), '') is null then coalesce(v_inspector_name, inspector_name) else inspector_name end,
      inspection_location = case when nullif(btrim(inspection_location), '') is null then coalesce(v_inspection_location, inspection_location) else inspection_location end,
      grade = case when nullif(btrim(grade), '') is null then coalesce(v_grade, grade) else grade end,
      reason = case when nullif(btrim(grade), '') is null and v_grade in ('1等', '合格') then null else reason end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where registration_id = p_registration_id
    and ((p_inspection_date is not null and inspection_date is null)
      or (v_inspector_name is not null and nullif(btrim(inspector_name), '') is null)
      or (v_inspection_location is not null and nullif(btrim(inspection_location), '') is null)
      or (v_grade is not null and nullif(btrim(grade), '') is null));
end;
$$;

revoke all on function public.flexcon_set_inspection_registration_metadata(text, uuid, date, text, text, text) from public;
grant execute on function public.flexcon_set_inspection_registration_metadata(text, uuid, date, text, text, text) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
