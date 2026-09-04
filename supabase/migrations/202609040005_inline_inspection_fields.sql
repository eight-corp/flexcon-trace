-- 等級理由マスターと、等級に応じた理由入力制限を追加します。
-- 202609040004_brand_group_inspection_entries.sql の実行後に適用してください。

begin;

alter table public.flexcon_inspection_options
  drop constraint if exists flexcon_inspection_options_option_type_check;

alter table public.flexcon_inspection_options
  add constraint flexcon_inspection_options_option_type_check
  check (
    option_type in (
      'location',
      'brand_aomori',
      'brand_iwate',
      'grade',
      'grade_reason'
    )
  );

insert into public.flexcon_inspection_options (option_type, name, sort_order)
values
  ('grade_reason', '整粒不足', 10),
  ('grade_reason', '形質', 20),
  ('grade_reason', '水分過多', 30),
  ('grade_reason', '被害粒', 40),
  ('grade_reason', '死米', 50),
  ('grade_reason', '着色粒', 60),
  ('grade_reason', '異種穀粒', 70),
  ('grade_reason', '異物', 80),
  ('grade_reason', 'その他', 90)
on conflict (option_type, name) do nothing;

update public.flexcon_inspection_flexcons
set reason = null
where grade in ('1等', '合格')
  and reason is not null;

update public.flexcon_inspection_paper_bags
set reason = null
where grade in ('1等', '合格')
  and reason is not null;

alter table public.flexcon_inspection_flexcons
  drop constraint if exists flexcon_inspection_flexcons_grade_reason_check;
alter table public.flexcon_inspection_flexcons
  add constraint flexcon_inspection_flexcons_grade_reason_check
  check (grade not in ('1等', '合格') or reason is null);

alter table public.flexcon_inspection_paper_bags
  drop constraint if exists flexcon_inspection_paper_bags_grade_reason_check;
alter table public.flexcon_inspection_paper_bags
  add constraint flexcon_inspection_paper_bags_grade_reason_check
  check (grade not in ('1等', '合格') or reason is null);

create or replace function public.flexcon_save_inspection_option(
  p_worker_id text,
  p_option_id uuid,
  p_option_type text,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_id uuid;
  v_name text;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_name := btrim(coalesce(p_name, ''));

  if p_option_type not in ('location', 'brand_aomori', 'brand_iwate', 'grade', 'grade_reason') then
    raise exception '検査項目の種類が正しくありません。';
  end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception '名称を1文字から120文字で入力してください。';
  end if;
  if exists (
    select 1
    from public.flexcon_inspection_options as inspection_option
    where inspection_option.option_type = p_option_type
      and lower(btrim(inspection_option.name)) = lower(v_name)
      and (p_option_id is null or inspection_option.id <> p_option_id)
  ) then
    raise exception '同じ名称がすでに登録されています。';
  end if;

  if p_option_id is null then
    insert into public.flexcon_inspection_options (
      option_type, name, created_by_worker_id, updated_by_worker_id
    ) values (
      p_option_type, v_name, v_worker.worker_id, v_worker.worker_id
    ) returning id into v_id;
  else
    update public.flexcon_inspection_options
    set name = v_name,
        updated_by_worker_id = v_worker.worker_id,
        updated_at = now()
    where id = p_option_id
      and option_type = p_option_type
    returning id into v_id;

    if v_id is null then
      raise exception '検査項目が見つかりません。';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.flexcon_save_inspection_flexcon(
  p_worker_id text,
  p_flexcon_id uuid,
  p_batch_id uuid,
  p_flexcon_no integer,
  p_brand text,
  p_quantity_kg integer,
  p_grade text,
  p_reason text,
  p_moisture numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_authorization_no text;
  v_lot_number text;
  v_id uuid;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select auth_record.authorization_no
  into v_authorization_no
  from public.flexcon_inspection_batches as batch
  join public.flexcon_authorizations as auth_record on auth_record.id = batch.authorization_id
  where batch.id = p_batch_id;

  if v_authorization_no is null then
    raise exception '仕入日別の検査記録が見つかりません。';
  end if;
  if v_authorization_no !~ '^[0-9]{1,3}$' then
    raise exception '委任状№は3桁以内の数字にしてください。';
  end if;
  if p_flexcon_no is null or p_flexcon_no not between 1 and 999 then
    raise exception 'フレコン№は1から999で入力してください。';
  end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then
    raise exception '銘柄を選択してください。';
  end if;
  if p_quantity_kg is null or p_quantity_kg <= 0 then
    raise exception '数量は1kg以上で入力してください。';
  end if;
  if p_moisture is not null and p_moisture not between 0 and 100 then
    raise exception '水分は0から100の範囲で入力してください。';
  end if;
  if btrim(coalesce(p_grade, '')) in ('1等', '合格')
     and nullif(btrim(coalesce(p_reason, '')), '') is not null then
    raise exception '1等と合格には理由を入力できません。';
  end if;

  v_lot_number := lpad(v_authorization_no, 3, '0') || lpad(p_flexcon_no::text, 3, '0');

  update public.flexcon_inspection_flexcons
  set flexcon_no = p_flexcon_no,
      lot_number = v_lot_number,
      brand = btrim(p_brand),
      quantity_kg = p_quantity_kg,
      grade = nullif(btrim(p_grade), ''),
      reason = nullif(btrim(p_reason), ''),
      moisture = round(p_moisture, 1),
      moisture_values = case when p_moisture is null then '{}'::numeric[] else array[p_moisture] end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where id = p_flexcon_id and batch_id = p_batch_id
  returning id into v_id;

  if v_id is null then
    raise exception 'フレコン検査記録を更新できませんでした。';
  end if;
  return v_id;
end;
$$;

create or replace function public.flexcon_save_inspection_paper_bags(
  p_worker_id text,
  p_paper_bag_id uuid,
  p_batch_id uuid,
  p_brand text,
  p_bag_count integer,
  p_grade text,
  p_reason text,
  p_moisture numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if char_length(btrim(coalesce(p_brand, ''))) = 0 then
    raise exception '銘柄を選択してください。';
  end if;
  if p_bag_count is null or p_bag_count <= 0 then
    raise exception '紙袋数は1以上で入力してください。';
  end if;
  if p_moisture is not null and p_moisture not between 0 and 100 then
    raise exception '水分は0から100の範囲で入力してください。';
  end if;
  if btrim(coalesce(p_grade, '')) in ('1等', '合格')
     and nullif(btrim(coalesce(p_reason, '')), '') is not null then
    raise exception '1等と合格には理由を入力できません。';
  end if;

  update public.flexcon_inspection_paper_bags
  set brand = btrim(p_brand),
      bag_count = p_bag_count,
      grade = nullif(btrim(p_grade), ''),
      reason = nullif(btrim(p_reason), ''),
      moisture = round(p_moisture, 1),
      moisture_values = case when p_moisture is null then '{}'::numeric[] else array[p_moisture] end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where id = p_paper_bag_id and batch_id = p_batch_id
  returning id into v_id;

  if v_id is null then
    raise exception '紙袋検査記録を更新できませんでした。';
  end if;
  return v_id;
end;
$$;

revoke all on function public.flexcon_save_inspection_option(text, uuid, text, text) from public;
revoke all on function public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, text, integer, text, text, numeric) from public;
revoke all on function public.flexcon_save_inspection_paper_bags(text, uuid, uuid, text, integer, text, text, numeric) from public;

grant execute on function public.flexcon_save_inspection_option(text, uuid, text, text) to anon, authenticated;
grant execute on function public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, text, integer, text, text, numeric) to anon, authenticated;
grant execute on function public.flexcon_save_inspection_paper_bags(text, uuid, uuid, text, integer, text, text, numeric) to anon, authenticated;

commit;
