-- 混在フレコンの共通仕入日を廃止し、検査記録にバラkgのフレコンを追加できるようにします。
-- 202609070004_mixed_flexcon_edit_delete_usage.sql の実行後に適用してください。

begin;

update public.flexcon_mixed_flexcons
set purchase_date = null
where purchase_date is not null;

create or replace function public.flexcon_clear_mixed_purchase_date()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.purchase_date := null;
  return new;
end;
$$;

drop trigger if exists flexcon_clear_mixed_purchase_date_trigger
  on public.flexcon_mixed_flexcons;
create trigger flexcon_clear_mixed_purchase_date_trigger
before insert or update of purchase_date
on public.flexcon_mixed_flexcons
for each row execute function public.flexcon_clear_mixed_purchase_date();

drop function if exists public.flexcon_add_inspection_group(
  text, uuid, integer, date, date, text, text, integer, integer, integer
);
drop function if exists public.flexcon_add_inspection_group(
  text, uuid, integer, date, date, text, text, integer, integer, integer, integer
);

create function public.flexcon_add_inspection_group(
  p_worker_id text,
  p_authorization_id uuid,
  p_fiscal_year integer,
  p_purchase_date date,
  p_inspection_date date,
  p_inspection_location text,
  p_brand text,
  p_flexcon_count integer,
  p_paper_bag_count integer,
  p_flexcon_quantity_kg integer,
  p_bulk_quantity_kg integer
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
  v_total_flexcons integer;
  v_flexcon_inserted integer := 0;
  v_bulk_inserted integer := 0;
  v_paper_inserted integer := 0;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select auth_record.authorization_no
  into v_authorization_no
  from public.flexcon_authorizations as auth_record
  where auth_record.id = p_authorization_id
  for update;

  if v_authorization_no is null then raise exception '委任状情報が見つかりません。'; end if;
  if v_authorization_no !~ '^[0-9]{1,4}$' then raise exception '委任状№は4桁以内の数字にしてください。'; end if;
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then
    raise exception '年度は1から99の整数で入力してください。';
  end if;
  if p_purchase_date is null then raise exception '仕入日を入力してください。'; end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then raise exception '銘柄を選択してください。'; end if;
  if coalesce(p_flexcon_count, 0) < 0
     or coalesce(p_paper_bag_count, 0) < 0
     or coalesce(p_bulk_quantity_kg, 0) < 0 then
    raise exception 'フレコン本数、紙袋数、バラは0以上で入力してください。';
  end if;
  if coalesce(p_flexcon_count, 0) = 0
     and coalesce(p_paper_bag_count, 0) = 0
     and coalesce(p_bulk_quantity_kg, 0) = 0 then
    raise exception 'フレコン本数、紙袋数、バラのいずれかを入力してください。';
  end if;
  if coalesce(p_flexcon_count, 0) > 0
     and (p_flexcon_quantity_kg is null or p_flexcon_quantity_kg <= 0) then
    raise exception 'フレコンの量目が正しくありません。';
  end if;

  select coalesce(max(flexcon.flexcon_no), 0) + 1
  into v_next_flexcon_no
  from public.flexcon_inspection_flexcons as flexcon
  where flexcon.authorization_id = p_authorization_id;

  v_total_flexcons := coalesce(p_flexcon_count, 0)
    + case when coalesce(p_bulk_quantity_kg, 0) > 0 then 1 else 0 end;
  if v_next_flexcon_no + v_total_flexcons - 1 > 999 then
    raise exception 'フレコン№が999を超えるため追加できません。';
  end if;

  for v_index in 1..coalesce(p_flexcon_count, 0) loop
    v_lot_number := lpad((p_fiscal_year + 2018)::text, 4, '0')
      || lpad(v_authorization_no, 4, '0')
      || lpad(v_next_flexcon_no::text, 3, '0');
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

  if coalesce(p_bulk_quantity_kg, 0) > 0 then
    v_lot_number := lpad((p_fiscal_year + 2018)::text, 4, '0')
      || lpad(v_authorization_no, 4, '0')
      || lpad(v_next_flexcon_no::text, 3, '0');
    insert into public.flexcon_inspection_flexcons (
      authorization_id, fiscal_year, purchase_date, inspection_date, inspection_location,
      flexcon_no, lot_number, brand, quantity_kg, moisture_values,
      created_by_worker_id, updated_by_worker_id
    ) values (
      p_authorization_id, p_fiscal_year, p_purchase_date, p_inspection_date,
      nullif(btrim(p_inspection_location), ''), v_next_flexcon_no, v_lot_number,
      btrim(p_brand), p_bulk_quantity_kg, '{}'::numeric[], p_worker_id, p_worker_id
    );
    v_bulk_inserted := 1;
    v_flexcon_inserted := v_flexcon_inserted + 1;
  end if;

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
    'bulk_flexcons_inserted', v_bulk_inserted,
    'paper_rows_inserted', v_paper_inserted
  );
end;
$$;

revoke all on function public.flexcon_add_inspection_group(
  text, uuid, integer, date, date, text, text, integer, integer, integer, integer
) from public;
grant execute on function public.flexcon_add_inspection_group(
  text, uuid, integer, date, date, text, text, integer, integer, integer, integer
) to anon, authenticated;

commit;
