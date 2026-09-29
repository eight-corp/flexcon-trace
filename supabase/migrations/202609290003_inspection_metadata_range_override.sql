begin;

create or replace function public.flexcon_set_inspection_registration_metadata_range(
  p_worker_id text, p_registration_id uuid,
  p_inspection_date date, p_inspector_name text, p_inspection_location text, p_grade text,
  p_target_kind text, p_start_no integer, p_end_no integer, p_overwrite boolean default false
)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_inspector text := nullif(btrim(p_inspector_name), '');
  v_location text := nullif(btrim(p_inspection_location), '');
  v_grade text := nullif(btrim(p_grade), '');
  v_overwrite boolean := coalesce(p_overwrite, false);
  v_flexcons uuid[];
  v_papers uuid[];
  v_count integer;
  v_updated integer := 0;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  perform 1 from public.flexcon_inspection_registrations where id = p_registration_id for update;
  if not found then raise exception '一括設定する検査記録が見つかりません。'; end if;
  if p_target_kind is null or p_target_kind not in ('all', 'standard', 'paper') then
    raise exception '一括設定の対象は推フレ・紙袋から選択してください。バラは対象外です。';
  end if;
  if (p_start_no is not null and p_start_no < 1) or (p_end_no is not null and p_end_no < 1)
     or (p_start_no is not null and p_end_no is not null and p_start_no > p_end_no) then
    raise exception '番号範囲は1以上で、開始№が終了№以下になるよう指定してください。';
  end if;
  if p_target_kind <> 'standard' and (p_start_no is not null or p_end_no is not null) then
    raise exception '番号範囲を指定できるのは推フレだけです。';
  end if;
  if p_inspection_date is null and v_inspector is null and v_location is null and v_grade is null then
    raise exception '反映する項目を1つ以上入力してください。';
  end if;
  if v_inspector is not null and not exists (
    select 1 from public.flexcon_inspection_options where option_type = 'inspector' and active and name = v_inspector
  ) then raise exception '選択した検査員はマスタに登録されていません。'; end if;
  if v_location is not null and not exists (
    select 1 from public.flexcon_inspection_options where option_type = 'location' and active and name = v_location
  ) then raise exception '選択した検査場所はマスタに登録されていません。'; end if;
  if v_grade is not null and not exists (
    select 1 from public.flexcon_inspection_options where option_type = 'grade' and active and name = v_grade
  ) then raise exception '選択した等級はマスタに登録されていません。'; end if;

  -- Select and lock only the requested details. Bulk records are never targets.
  select coalesce(array_agg(detail.id), array[]::uuid[]) into v_flexcons
  from (
    select id from public.flexcon_inspection_flexcons
    where registration_id = p_registration_id and record_kind = 'standard'
      and p_target_kind in ('all', 'standard')
      and (p_start_no is null or flexcon_no >= p_start_no)
      and (p_end_no is null or flexcon_no <= p_end_no)
    order by id for update
  ) as detail;
  select coalesce(array_agg(detail.id), array[]::uuid[]) into v_papers
  from (
    select id from public.flexcon_inspection_paper_bags
    where registration_id = p_registration_id and p_target_kind in ('all', 'paper')
    order by id for update
  ) as detail;
  if cardinality(v_flexcons) + cardinality(v_papers) = 0 then
    raise exception '指定した対象・番号範囲に明細がありません。';
  end if;
  if v_grade is not null and exists (
    select 1 from (
      select brand, grade from public.flexcon_inspection_flexcons where id = any(v_flexcons)
      union all
      select brand, grade from public.flexcon_inspection_paper_bags where id = any(v_papers)
    ) as detail
    where (v_overwrite or nullif(btrim(detail.grade), '') is null)
      and ((v_grade = '合格' and btrim(coalesce(detail.brand, '')) <> '飼料用玄米')
        or (v_grade <> '合格' and btrim(coalesce(detail.brand, '')) = '飼料用玄米'))
  ) then raise exception '対象の明細の銘柄に設定できない等級が選択されています。'; end if;

  update public.flexcon_inspection_flexcons
  set inspection_date = case when v_overwrite then coalesce(p_inspection_date, inspection_date) else coalesce(inspection_date, p_inspection_date) end,
      inspector_name = case when v_inspector is not null and (v_overwrite or nullif(btrim(inspector_name), '') is null) then v_inspector else inspector_name end,
      inspection_location = case when v_location is not null and (v_overwrite or nullif(btrim(inspection_location), '') is null) then v_location else inspection_location end,
      grade = case when v_grade is not null and (v_overwrite or nullif(btrim(grade), '') is null) then v_grade else grade end,
      reason = case when v_grade in ('1等', '合格') and (v_overwrite or nullif(btrim(grade), '') is null) then null else reason end,
      updated_by_worker_id = p_worker_id, updated_at = now()
  where id = any(v_flexcons)
    and ((p_inspection_date is not null and ((v_overwrite and inspection_date is distinct from p_inspection_date) or inspection_date is null))
      or (v_inspector is not null and ((v_overwrite and inspector_name is distinct from v_inspector) or nullif(btrim(inspector_name), '') is null))
      or (v_location is not null and ((v_overwrite and inspection_location is distinct from v_location) or nullif(btrim(inspection_location), '') is null))
      or (v_grade is not null and ((v_overwrite and (grade is distinct from v_grade or (v_grade in ('1等', '合格') and reason is not null))) or nullif(btrim(grade), '') is null)));
  get diagnostics v_count = row_count;
  v_updated := v_count;

  update public.flexcon_inspection_paper_bags
  set inspection_date = case when v_overwrite then coalesce(p_inspection_date, inspection_date) else coalesce(inspection_date, p_inspection_date) end,
      inspector_name = case when v_inspector is not null and (v_overwrite or nullif(btrim(inspector_name), '') is null) then v_inspector else inspector_name end,
      inspection_location = case when v_location is not null and (v_overwrite or nullif(btrim(inspection_location), '') is null) then v_location else inspection_location end,
      grade = case when v_grade is not null and (v_overwrite or nullif(btrim(grade), '') is null) then v_grade else grade end,
      reason = case when v_grade in ('1等', '合格') and (v_overwrite or nullif(btrim(grade), '') is null) then null else reason end,
      updated_by_worker_id = p_worker_id, updated_at = now()
  where id = any(v_papers)
    and ((p_inspection_date is not null and ((v_overwrite and inspection_date is distinct from p_inspection_date) or inspection_date is null))
      or (v_inspector is not null and ((v_overwrite and inspector_name is distinct from v_inspector) or nullif(btrim(inspector_name), '') is null))
      or (v_location is not null and ((v_overwrite and inspection_location is distinct from v_location) or nullif(btrim(inspection_location), '') is null))
      or (v_grade is not null and ((v_overwrite and (grade is distinct from v_grade or (v_grade in ('1等', '合格') and reason is not null))) or nullif(btrim(grade), '') is null)));
  get diagnostics v_count = row_count;
  return v_updated + v_count;
end;
$$;

-- Keep older clients compatible while also excluding bulk from their batch requests.
create or replace function public.flexcon_set_inspection_registration_metadata(
  p_worker_id text, p_registration_id uuid, p_inspection_date date,
  p_inspector_name text, p_inspection_location text, p_grade text
)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.flexcon_set_inspection_registration_metadata_range(
    p_worker_id, p_registration_id, p_inspection_date, p_inspector_name,
    p_inspection_location, p_grade, 'all', null, null, false
  );
end;
$$;

revoke all on function public.flexcon_set_inspection_registration_metadata_range(text,uuid,date,text,text,text,text,integer,integer,boolean) from public;
grant execute on function public.flexcon_set_inspection_registration_metadata_range(text,uuid,date,text,text,text,text,integer,integer,boolean) to anon, authenticated;
revoke all on function public.flexcon_set_inspection_registration_metadata(text,uuid,date,text,text,text) from public;
grant execute on function public.flexcon_set_inspection_registration_metadata(text,uuid,date,text,text,text) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
