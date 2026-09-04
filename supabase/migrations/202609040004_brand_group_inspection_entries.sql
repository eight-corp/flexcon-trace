-- 銘柄・フレコン本数・紙袋数をまとめて追加する方式へ変更します。
-- 202609040003_producer_inspection_records.sql の実行後に適用してください。

begin;

alter table public.flexcon_inspection_flexcons
  add column if not exists brand text;

alter table public.flexcon_inspection_paper_bags
  add column if not exists brand text;

update public.flexcon_inspection_flexcons as flexcon
set brand = batch.brand
from public.flexcon_inspection_batches as batch
where batch.id = flexcon.batch_id
  and flexcon.brand is null;

update public.flexcon_inspection_paper_bags as paper
set brand = batch.brand
from public.flexcon_inspection_batches as batch
where batch.id = paper.batch_id
  and paper.brand is null;

alter table public.flexcon_inspection_paper_bags
  drop constraint if exists flexcon_inspection_paper_bags_batch_id_key;

create index if not exists flexcon_inspection_paper_bags_batch_idx
  on public.flexcon_inspection_paper_bags (batch_id, created_at);

drop function if exists public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, integer, text, text, numeric[]);
drop function if exists public.flexcon_save_inspection_paper_bags(text, uuid, uuid, integer, text, text, numeric[]);

create or replace function public.flexcon_add_inspection_group(
  p_worker_id text,
  p_batch_id uuid,
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
  v_authorization_id uuid;
  v_authorization_no text;
  v_next_flexcon_no integer;
  v_index integer;
  v_lot_number text;
  v_flexcon_inserted integer := 0;
  v_paper_inserted integer := 0;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select batch.authorization_id, auth_record.authorization_no
  into v_authorization_id, v_authorization_no
  from public.flexcon_inspection_batches as batch
  join public.flexcon_authorizations as auth_record on auth_record.id = batch.authorization_id
  where batch.id = p_batch_id
  for update of auth_record;

  if v_authorization_id is null then
    raise exception '仕入日別の検査記録が見つかりません。';
  end if;
  if v_authorization_no !~ '^[0-9]{1,3}$' then
    raise exception '委任状№は3桁以内の数字にしてください。';
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
  join public.flexcon_inspection_batches as batch on batch.id = flexcon.batch_id
  where batch.authorization_id = v_authorization_id;

  if v_next_flexcon_no + coalesce(p_flexcon_count, 0) - 1 > 999 then
    raise exception 'フレコン№が999を超えるため追加できません。';
  end if;

  for v_index in 1..coalesce(p_flexcon_count, 0) loop
    v_lot_number := lpad(v_authorization_no, 3, '0') || lpad(v_next_flexcon_no::text, 3, '0');
    insert into public.flexcon_inspection_flexcons (
      batch_id, flexcon_no, lot_number, brand, quantity_kg,
      moisture_values, created_by_worker_id, updated_by_worker_id
    ) values (
      p_batch_id, v_next_flexcon_no, v_lot_number, btrim(p_brand), p_flexcon_quantity_kg,
      '{}'::numeric[], p_worker_id, p_worker_id
    );
    v_next_flexcon_no := v_next_flexcon_no + 1;
    v_flexcon_inserted := v_flexcon_inserted + 1;
  end loop;

  if coalesce(p_paper_bag_count, 0) > 0 then
    insert into public.flexcon_inspection_paper_bags (
      batch_id, brand, bag_count, moisture_values,
      created_by_worker_id, updated_by_worker_id
    ) values (
      p_batch_id, btrim(p_brand), p_paper_bag_count, '{}'::numeric[],
      p_worker_id, p_worker_id
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

create or replace function public.flexcon_delete_inspection_paper_bags(
  p_worker_id text,
  p_paper_bag_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  delete from public.flexcon_inspection_paper_bags where id = p_paper_bag_id;
end;
$$;

revoke all on function public.flexcon_add_inspection_group(text, uuid, text, integer, integer, integer) from public;
revoke all on function public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, text, integer, text, text, numeric) from public;
revoke all on function public.flexcon_save_inspection_paper_bags(text, uuid, uuid, text, integer, text, text, numeric) from public;
revoke all on function public.flexcon_delete_inspection_paper_bags(text, uuid) from public;

grant execute on function public.flexcon_add_inspection_group(text, uuid, text, integer, integer, integer) to anon, authenticated;
grant execute on function public.flexcon_save_inspection_flexcon(text, uuid, uuid, integer, text, integer, text, text, numeric) to anon, authenticated;
grant execute on function public.flexcon_save_inspection_paper_bags(text, uuid, uuid, text, integer, text, text, numeric) to anon, authenticated;
grant execute on function public.flexcon_delete_inspection_paper_bags(text, uuid) to anon, authenticated;

commit;
