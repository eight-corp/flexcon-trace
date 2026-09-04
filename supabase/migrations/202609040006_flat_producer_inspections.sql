-- 検査記録を仕入日単位ではなく、委任状ごとのフレコン・紙袋明細として保持します。
-- 既存の仕入日情報は各明細へ引き継ぎます。

begin;

alter table public.flexcon_inspection_flexcons
  add column if not exists authorization_id uuid references public.flexcon_authorizations(id) on delete cascade,
  add column if not exists fiscal_year integer,
  add column if not exists purchase_date date,
  add column if not exists inspection_date date,
  add column if not exists inspection_location text;

alter table public.flexcon_inspection_paper_bags
  add column if not exists authorization_id uuid references public.flexcon_authorizations(id) on delete cascade,
  add column if not exists fiscal_year integer,
  add column if not exists purchase_date date,
  add column if not exists inspection_date date,
  add column if not exists inspection_location text;

update public.flexcon_inspection_flexcons as flexcon
set authorization_id = batch.authorization_id,
    fiscal_year = batch.fiscal_year,
    purchase_date = batch.purchase_date,
    inspection_date = batch.inspection_date,
    inspection_location = batch.inspection_location
from public.flexcon_inspection_batches as batch
where batch.id = flexcon.batch_id
  and flexcon.authorization_id is null;

update public.flexcon_inspection_paper_bags as paper
set authorization_id = batch.authorization_id,
    fiscal_year = batch.fiscal_year,
    purchase_date = batch.purchase_date,
    inspection_date = batch.inspection_date,
    inspection_location = batch.inspection_location
from public.flexcon_inspection_batches as batch
where batch.id = paper.batch_id
  and paper.authorization_id is null;

alter table public.flexcon_inspection_flexcons
  alter column authorization_id set not null,
  alter column fiscal_year set not null,
  alter column purchase_date set not null;

alter table public.flexcon_inspection_paper_bags
  alter column authorization_id set not null,
  alter column fiscal_year set not null,
  alter column purchase_date set not null;

alter table public.flexcon_inspection_flexcons
  drop constraint if exists flexcon_inspection_flexcons_fiscal_year_check;
alter table public.flexcon_inspection_flexcons
  add constraint flexcon_inspection_flexcons_fiscal_year_check
  check (fiscal_year between 1 and 99);

alter table public.flexcon_inspection_paper_bags
  drop constraint if exists flexcon_inspection_paper_bags_fiscal_year_check;
alter table public.flexcon_inspection_paper_bags
  add constraint flexcon_inspection_paper_bags_fiscal_year_check
  check (fiscal_year between 1 and 99);

drop function if exists public.flexcon_save_inspection_batch(text, uuid, uuid, date, integer, date, text, text);
drop function if exists public.flexcon_delete_inspection_batch(text, uuid);
drop function if exists public.flexcon_add_inspection_group(text, uuid, text, integer, integer, integer);
drop function if exists public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, text, integer, text, text, numeric);
drop function if exists public.flexcon_save_inspection_paper_bags(text, uuid, uuid, text, integer, text, text, numeric);

alter table public.flexcon_inspection_flexcons drop column if exists batch_id;
alter table public.flexcon_inspection_paper_bags drop column if exists batch_id;
drop table if exists public.flexcon_inspection_batches;

create index if not exists flexcon_inspection_flexcons_authorization_date_idx
  on public.flexcon_inspection_flexcons (authorization_id, purchase_date desc, flexcon_no);
create index if not exists flexcon_inspection_paper_bags_authorization_date_idx
  on public.flexcon_inspection_paper_bags (authorization_id, purchase_date desc, created_at);

create or replace function public.flexcon_add_inspection_group(
  p_worker_id text,
  p_authorization_id uuid,
  p_fiscal_year integer,
  p_purchase_date date,
  p_inspection_date date,
  p_inspection_location text,
  p_brand text,
  p_flexcon_count integer,
  p_paper_bag_count integer,
  p_flexcon_quantity_kg integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_authorization_no text;
  v_next_flexcon_no integer;
  v_index integer;
  v_lot_number text;
  v_flexcon_inserted integer := 0;
  v_paper_inserted integer := 0;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select auth_record.authorization_no
  into v_authorization_no
  from public.flexcon_authorizations as auth_record
  where auth_record.id = p_authorization_id
  for update;

  if v_authorization_no is null then
    raise exception '委任状情報が見つかりません。';
  end if;
  if v_authorization_no !~ '^[0-9]{1,3}$' then
    raise exception '委任状№は3桁以内の数字にしてください。';
  end if;
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then
    raise exception '年度は1から99の整数で入力してください。';
  end if;
  if p_purchase_date is null then
    raise exception '仕入日を入力してください。';
  end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then
    raise exception '銘柄を選択してください。';
  end if;
  if coalesce(p_flexcon_count, 0) < 0 or coalesce(p_paper_bag_count, 0) < 0 then
    raise exception 'フレコン本数と紙袋数は0以上で入力してください。';
  end if;
  if coalesce(p_flexcon_count, 0) = 0 and coalesce(p_paper_bag_count, 0) = 0 then
    raise exception 'フレコン本数または紙袋数を入力してください。';
  end if;
  if coalesce(p_flexcon_count, 0) > 0 and (p_flexcon_quantity_kg is null or p_flexcon_quantity_kg <= 0) then
    raise exception 'フレコンの量目が正しくありません。';
  end if;

  select coalesce(max(flexcon.flexcon_no), 0) + 1
  into v_next_flexcon_no
  from public.flexcon_inspection_flexcons as flexcon
  where flexcon.authorization_id = p_authorization_id;

  if v_next_flexcon_no + coalesce(p_flexcon_count, 0) - 1 > 999 then
    raise exception 'フレコン№が999を超えるため追加できません。';
  end if;

  for v_index in 1..coalesce(p_flexcon_count, 0) loop
    v_lot_number := lpad(v_authorization_no, 3, '0') || lpad(v_next_flexcon_no::text, 3, '0');
    insert into public.flexcon_inspection_flexcons (
      authorization_id, fiscal_year, purchase_date, inspection_date, inspection_location,
      flexcon_no, lot_number, brand, quantity_kg, moisture_values,
      created_by_worker_id, updated_by_worker_id
    ) values (
      p_authorization_id, p_fiscal_year, p_purchase_date, p_inspection_date,
      nullif(btrim(p_inspection_location), ''), v_next_flexcon_no, v_lot_number,
      btrim(p_brand), p_flexcon_quantity_kg, '{}'::numeric[], p_worker_id, p_worker_id
    );
    v_next_flexcon_no := v_next_flexcon_no + 1;
    v_flexcon_inserted := v_flexcon_inserted + 1;
  end loop;

  if coalesce(p_paper_bag_count, 0) > 0 then
    insert into public.flexcon_inspection_paper_bags (
      authorization_id, fiscal_year, purchase_date, inspection_date, inspection_location,
      brand, bag_count, moisture_values, created_by_worker_id, updated_by_worker_id
    ) values (
      p_authorization_id, p_fiscal_year, p_purchase_date, p_inspection_date,
      nullif(btrim(p_inspection_location), ''), btrim(p_brand), p_paper_bag_count,
      '{}'::numeric[], p_worker_id, p_worker_id
    );
    v_paper_inserted := 1;
  end if;

  return jsonb_build_object(
    'flexcons_inserted', v_flexcon_inserted,
    'paper_rows_inserted', v_paper_inserted
  );
end;
$$;

create or replace function public.flexcon_save_inspection_flexcon(
  p_worker_id text,
  p_flexcon_id uuid,
  p_authorization_id uuid,
  p_fiscal_year integer,
  p_purchase_date date,
  p_inspection_date date,
  p_inspection_location text,
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

  select authorization_no into v_authorization_no
  from public.flexcon_authorizations
  where id = p_authorization_id;

  if v_authorization_no is null then raise exception '委任状情報が見つかりません。'; end if;
  if v_authorization_no !~ '^[0-9]{1,3}$' then raise exception '委任状№は3桁以内の数字にしてください。'; end if;
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then raise exception '年度は1から99の整数で入力してください。'; end if;
  if p_purchase_date is null then raise exception '仕入日を入力してください。'; end if;
  if p_flexcon_no is null or p_flexcon_no not between 1 and 999 then raise exception 'フレコン№は1から999で入力してください。'; end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then raise exception '銘柄を選択してください。'; end if;
  if p_quantity_kg is null or p_quantity_kg <= 0 then raise exception '数量は1kg以上で入力してください。'; end if;
  if p_moisture is not null and p_moisture not between 0 and 100 then raise exception '水分は0から100の範囲で入力してください。'; end if;
  if btrim(coalesce(p_grade, '')) in ('1等', '合格') and nullif(btrim(coalesce(p_reason, '')), '') is not null then
    raise exception '1等と合格には理由を入力できません。';
  end if;

  v_lot_number := lpad(v_authorization_no, 3, '0') || lpad(p_flexcon_no::text, 3, '0');

  update public.flexcon_inspection_flexcons
  set fiscal_year = p_fiscal_year,
      purchase_date = p_purchase_date,
      inspection_date = p_inspection_date,
      inspection_location = nullif(btrim(p_inspection_location), ''),
      flexcon_no = p_flexcon_no,
      lot_number = v_lot_number,
      brand = btrim(p_brand),
      quantity_kg = p_quantity_kg,
      grade = nullif(btrim(p_grade), ''),
      reason = nullif(btrim(p_reason), ''),
      moisture = round(p_moisture, 1),
      moisture_values = case when p_moisture is null then '{}'::numeric[] else array[p_moisture] end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where id = p_flexcon_id and authorization_id = p_authorization_id
  returning id into v_id;

  if v_id is null then raise exception 'フレコン検査記録を更新できませんでした。'; end if;
  return v_id;
end;
$$;

create or replace function public.flexcon_save_inspection_paper_bags(
  p_worker_id text,
  p_paper_bag_id uuid,
  p_authorization_id uuid,
  p_fiscal_year integer,
  p_purchase_date date,
  p_inspection_date date,
  p_inspection_location text,
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

  if not exists (select 1 from public.flexcon_authorizations where id = p_authorization_id) then raise exception '委任状情報が見つかりません。'; end if;
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then raise exception '年度は1から99の整数で入力してください。'; end if;
  if p_purchase_date is null then raise exception '仕入日を入力してください。'; end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then raise exception '銘柄を選択してください。'; end if;
  if p_bag_count is null or p_bag_count <= 0 then raise exception '紙袋数は1以上で入力してください。'; end if;
  if p_moisture is not null and p_moisture not between 0 and 100 then raise exception '水分は0から100の範囲で入力してください。'; end if;
  if btrim(coalesce(p_grade, '')) in ('1等', '合格') and nullif(btrim(coalesce(p_reason, '')), '') is not null then
    raise exception '1等と合格には理由を入力できません。';
  end if;

  update public.flexcon_inspection_paper_bags
  set fiscal_year = p_fiscal_year,
      purchase_date = p_purchase_date,
      inspection_date = p_inspection_date,
      inspection_location = nullif(btrim(p_inspection_location), ''),
      brand = btrim(p_brand),
      bag_count = p_bag_count,
      grade = nullif(btrim(p_grade), ''),
      reason = nullif(btrim(p_reason), ''),
      moisture = round(p_moisture, 1),
      moisture_values = case when p_moisture is null then '{}'::numeric[] else array[p_moisture] end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where id = p_paper_bag_id and authorization_id = p_authorization_id
  returning id into v_id;

  if v_id is null then raise exception '紙袋検査記録を更新できませんでした。'; end if;
  return v_id;
end;
$$;

revoke all on function public.flexcon_add_inspection_group(text, uuid, integer, date, date, text, text, integer, integer, integer) from public;
revoke all on function public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, date, date, text, integer, text, integer, text, text, numeric) from public;
revoke all on function public.flexcon_save_inspection_paper_bags(text, uuid, uuid, integer, date, date, text, text, integer, text, text, numeric) from public;

grant execute on function public.flexcon_add_inspection_group(text, uuid, integer, date, date, text, text, integer, integer, integer) to anon, authenticated;
grant execute on function public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, date, date, text, integer, text, integer, text, text, numeric) to anon, authenticated;
grant execute on function public.flexcon_save_inspection_paper_bags(text, uuid, uuid, integer, date, date, text, text, integer, text, text, numeric) to anon, authenticated;

commit;
