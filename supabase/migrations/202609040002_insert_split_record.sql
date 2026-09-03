-- 分割後2を分割後1の直後へ挿入し、後続ナンバーを1つずつ繰り下げます。
-- 202609040001_split_inspection_records.sql の実行後に適用してください。

create or replace function public.flexcon_split_inspection_record(
  p_worker_id text,
  p_record_id uuid,
  p_record jsonb,
  p_split_details jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fiscal_year integer;
  v_original_record_no integer;
  v_next_record_no integer;
  v_second_record jsonb;
  v_existing_id uuid;
  v_new_id uuid;
  v_shift_record record;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if p_record_id is null then
    raise exception '分割する検査記録が指定されていません。';
  end if;

  select inspection.id
  into v_existing_id
  from public.flexcon_inspection_records as inspection
  where inspection.id = p_record_id
  for update;

  if v_existing_id is null then
    raise exception '分割する検査記録が見つかりません。';
  end if;

  v_fiscal_year := nullif(p_record->>'fiscal_year', '')::integer;
  if v_fiscal_year is null or v_fiscal_year not between 1 and 99 then
    raise exception '年度は1から99の整数で入力してください。';
  end if;

  v_original_record_no := nullif(p_record->>'record_no', '')::integer;
  if v_original_record_no is null or v_original_record_no <= 0 then
    raise exception 'ナンバーは1以上の整数で入力してください。';
  end if;

  if p_split_details is null then
    raise exception '分割後2の情報が指定されていません。';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('flexcon_inspection_record_' || v_fiscal_year::text)
  );

  perform public.flexcon_save_inspection_record(
    p_worker_id,
    p_record_id,
    p_record
  );

  for v_shift_record in
    select inspection.id
    from public.flexcon_inspection_records as inspection
    where inspection.fiscal_year = v_fiscal_year
      and inspection.record_no > v_original_record_no
    order by inspection.record_no desc
    for update
  loop
    update public.flexcon_inspection_records
    set record_no = record_no + 1
    where id = v_shift_record.id;
  end loop;

  v_next_record_no := v_original_record_no + 1;

  v_second_record := p_record || jsonb_build_object(
    'record_no', v_next_record_no,
    'recommended_flexcon', p_split_details->'recommended_flexcon',
    'paper_bags', p_split_details->'paper_bags',
    'bulk_quantity', p_split_details->'bulk_quantity',
    'grade', p_split_details->'grade',
    'reason', p_split_details->'reason'
  );

  select public.flexcon_save_inspection_record(
    p_worker_id,
    null,
    v_second_record
  )
  into v_new_id;

  return v_new_id;
end;
$$;

revoke all
on function public.flexcon_split_inspection_record(
  text,
  uuid,
  jsonb,
  jsonb
)
from public;

grant execute
on function public.flexcon_split_inspection_record(
  text,
  uuid,
  jsonb,
  jsonb
)
to anon, authenticated;
