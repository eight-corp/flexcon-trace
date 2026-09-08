-- 推フレとバラを別々に採番し、推フレのQRロット番号を新しい№へ合わせます。
-- 202609080001_retire_mixed_source_restriction.sql の実行後に適用してください。

begin;

alter table public.flexcon_inspection_flexcons
  add column if not exists record_kind text;

update public.flexcon_inspection_flexcons as flexcon
set record_kind = case
  when flexcon.quantity_kg = coalesce((
    select weight.weight_kg
    from public.flexcon_inspection_weights as weight
    where weight.weight_type = case
      when btrim(coalesce(flexcon.brand, '')) = '飼料用玄米' then 'feed_rice'
      else 'branded_rice'
    end
  ), case when btrim(coalesce(flexcon.brand, '')) = '飼料用玄米' then 1000 else 1020 end)
    then 'standard'
  else 'bulk'
end
where record_kind is null;

alter table public.flexcon_inspection_flexcons
  alter column record_kind set not null;

alter table public.flexcon_inspection_flexcons
  drop constraint if exists flexcon_inspection_flexcons_record_kind_check;
alter table public.flexcon_inspection_flexcons
  add constraint flexcon_inspection_flexcons_record_kind_check
  check (record_kind in ('standard', 'bulk'));

do $$
begin
  if exists (
    select 1
    from (
      select row_number() over (
        partition by flexcon.authorization_id, flexcon.record_kind
        order by flexcon.flexcon_no, flexcon.created_at, flexcon.id
      ) as new_flexcon_no
      from public.flexcon_inspection_flexcons as flexcon
    ) as numbered
    where numbered.new_flexcon_no > 999
  ) then
    raise exception '推フレまたはバラが999件を超える生産者がいるため、別採番へ変更できません。';
  end if;
end;
$$;

alter table public.flexcon_inspection_flexcons
  drop constraint if exists flexcon_inspection_flexcons_lot_number_key;
alter table public.flexcon_flexcons
  drop constraint if exists flexcon_flexcons_lot_number_key;
alter table public.flexcon_shipment_items
  drop constraint if exists flexcon_shipment_items_lot_number_key;

with number_changes as (
  select
    numbered.lot_number as old_lot_number,
    case
      when numbered.record_kind = 'bulk' then
        '0000' || lpad(numbered.authorization_no, 4, '0') || lpad(numbered.new_flexcon_no::text, 3, '0')
      else
        lpad((numbered.fiscal_year + 2018)::text, 4, '0')
          || lpad(numbered.authorization_no, 4, '0')
          || lpad(numbered.new_flexcon_no::text, 3, '0')
    end as new_lot_number
  from (
    select
      flexcon.lot_number,
      flexcon.record_kind,
      flexcon.fiscal_year,
      auth_record.authorization_no,
      row_number() over (
        partition by flexcon.authorization_id, flexcon.record_kind
        order by flexcon.flexcon_no, flexcon.created_at, flexcon.id
      )::integer as new_flexcon_no
    from public.flexcon_inspection_flexcons as flexcon
    join public.flexcon_authorizations as auth_record
      on auth_record.id = flexcon.authorization_id
  ) as numbered
)
update public.flexcon_shipment_items as shipment_item
set lot_number = number_change.new_lot_number
from number_changes as number_change
where shipment_item.lot_number = number_change.old_lot_number;

with number_changes as (
  select
    numbered.lot_number as old_lot_number,
    case
      when numbered.record_kind = 'bulk' then
        '0000' || lpad(numbered.authorization_no, 4, '0') || lpad(numbered.new_flexcon_no::text, 3, '0')
      else
        lpad((numbered.fiscal_year + 2018)::text, 4, '0')
          || lpad(numbered.authorization_no, 4, '0')
          || lpad(numbered.new_flexcon_no::text, 3, '0')
    end as new_lot_number
  from (
    select
      flexcon.lot_number,
      flexcon.record_kind,
      flexcon.fiscal_year,
      auth_record.authorization_no,
      row_number() over (
        partition by flexcon.authorization_id, flexcon.record_kind
        order by flexcon.flexcon_no, flexcon.created_at, flexcon.id
      )::integer as new_flexcon_no
    from public.flexcon_inspection_flexcons as flexcon
    join public.flexcon_authorizations as auth_record
      on auth_record.id = flexcon.authorization_id
  ) as numbered
)
update public.flexcon_flexcons as shipped_flexcon
set lot_number = number_change.new_lot_number
from number_changes as number_change
where shipped_flexcon.lot_number = number_change.old_lot_number;

with number_changes as (
  select
    numbered.id as flexcon_id,
    numbered.new_flexcon_no,
    case
      when numbered.record_kind = 'bulk' then
        '0000' || lpad(numbered.authorization_no, 4, '0') || lpad(numbered.new_flexcon_no::text, 3, '0')
      else
        lpad((numbered.fiscal_year + 2018)::text, 4, '0')
          || lpad(numbered.authorization_no, 4, '0')
          || lpad(numbered.new_flexcon_no::text, 3, '0')
    end as new_lot_number
  from (
    select
      flexcon.id,
      flexcon.record_kind,
      flexcon.fiscal_year,
      auth_record.authorization_no,
      row_number() over (
        partition by flexcon.authorization_id, flexcon.record_kind
        order by flexcon.flexcon_no, flexcon.created_at, flexcon.id
      )::integer as new_flexcon_no
    from public.flexcon_inspection_flexcons as flexcon
    join public.flexcon_authorizations as auth_record
      on auth_record.id = flexcon.authorization_id
  ) as numbered
)
update public.flexcon_inspection_flexcons as flexcon
set flexcon_no = number_change.new_flexcon_no,
    lot_number = number_change.new_lot_number
from number_changes as number_change
where flexcon.id = number_change.flexcon_id;

alter table public.flexcon_inspection_flexcons
  add constraint flexcon_inspection_flexcons_lot_number_key unique (lot_number);
alter table public.flexcon_flexcons
  add constraint flexcon_flexcons_lot_number_key unique (lot_number);
alter table public.flexcon_shipment_items
  add constraint flexcon_shipment_items_lot_number_key unique (lot_number);

drop index if exists public.flexcon_inspection_flexcons_kind_no_unique;
create unique index flexcon_inspection_flexcons_kind_no_unique
  on public.flexcon_inspection_flexcons (authorization_id, record_kind, flexcon_no);

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
  v_registration_id uuid;
  v_registration_no bigint;
  v_next_standard_no integer;
  v_next_bulk_no integer;
  v_index integer;
  v_lot_number text;
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
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then raise exception '年度は1から99の整数で入力してください。'; end if;
  if p_purchase_date is null then raise exception '仕入日を入力してください。'; end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then raise exception '銘柄を選択してください。'; end if;
  if coalesce(p_flexcon_count, 0) < 0 or coalesce(p_paper_bag_count, 0) < 0 or coalesce(p_bulk_quantity_kg, 0) < 0 then
    raise exception 'フレコン本数、紙袋数、バラは0以上で入力してください。';
  end if;
  if coalesce(p_flexcon_count, 0) = 0 and coalesce(p_paper_bag_count, 0) = 0 and coalesce(p_bulk_quantity_kg, 0) = 0 then
    raise exception 'フレコン本数、紙袋数、バラのいずれかを入力してください。';
  end if;
  if coalesce(p_flexcon_count, 0) > 0 and (p_flexcon_quantity_kg is null or p_flexcon_quantity_kg <= 0) then
    raise exception 'フレコンの量目が正しくありません。';
  end if;

  select coalesce(max(flexcon.flexcon_no), 0) + 1
  into v_next_standard_no
  from public.flexcon_inspection_flexcons as flexcon
  where flexcon.authorization_id = p_authorization_id
    and flexcon.record_kind = 'standard';

  select coalesce(max(flexcon.flexcon_no), 0) + 1
  into v_next_bulk_no
  from public.flexcon_inspection_flexcons as flexcon
  where flexcon.authorization_id = p_authorization_id
    and flexcon.record_kind = 'bulk';

  if v_next_standard_no + coalesce(p_flexcon_count, 0) - 1 > 999 then raise exception '推フレ№が999を超えるため追加できません。'; end if;
  if coalesce(p_bulk_quantity_kg, 0) > 0 and v_next_bulk_no > 999 then raise exception 'バラ№が999を超えるため追加できません。'; end if;

  insert into public.flexcon_inspection_registrations (authorization_id, created_by_worker_id)
  values (p_authorization_id, p_worker_id)
  returning id, registration_no into v_registration_id, v_registration_no;

  for v_index in 1..coalesce(p_flexcon_count, 0) loop
    v_lot_number := lpad((p_fiscal_year + 2018)::text, 4, '0')
      || lpad(v_authorization_no, 4, '0')
      || lpad(v_next_standard_no::text, 3, '0');
    insert into public.flexcon_inspection_flexcons (
      registration_id, authorization_id, fiscal_year, purchase_date, inspection_date,
      inspection_location, record_kind, flexcon_no, lot_number, brand, quantity_kg,
      moisture_values, created_by_worker_id, updated_by_worker_id
    ) values (
      v_registration_id, p_authorization_id, p_fiscal_year, p_purchase_date,
      p_inspection_date, nullif(btrim(p_inspection_location), ''), 'standard',
      v_next_standard_no, v_lot_number, btrim(p_brand), p_flexcon_quantity_kg,
      '{}'::numeric[], p_worker_id, p_worker_id
    );
    v_next_standard_no := v_next_standard_no + 1;
    v_flexcon_inserted := v_flexcon_inserted + 1;
  end loop;

  if coalesce(p_bulk_quantity_kg, 0) > 0 then
    v_lot_number := '0000' || lpad(v_authorization_no, 4, '0') || lpad(v_next_bulk_no::text, 3, '0');
    insert into public.flexcon_inspection_flexcons (
      registration_id, authorization_id, fiscal_year, purchase_date, inspection_date,
      inspection_location, record_kind, flexcon_no, lot_number, brand, quantity_kg,
      moisture_values, created_by_worker_id, updated_by_worker_id
    ) values (
      v_registration_id, p_authorization_id, p_fiscal_year, p_purchase_date,
      p_inspection_date, nullif(btrim(p_inspection_location), ''), 'bulk',
      v_next_bulk_no, v_lot_number, btrim(p_brand), p_bulk_quantity_kg,
      '{}'::numeric[], p_worker_id, p_worker_id
    );
    v_bulk_inserted := 1;
    v_flexcon_inserted := v_flexcon_inserted + 1;
  end if;

  if coalesce(p_paper_bag_count, 0) > 0 then
    insert into public.flexcon_inspection_paper_bags (
      registration_id, authorization_id, fiscal_year, purchase_date, inspection_date,
      inspection_location, brand, bag_count, moisture_values,
      created_by_worker_id, updated_by_worker_id
    ) values (
      v_registration_id, p_authorization_id, p_fiscal_year, p_purchase_date,
      p_inspection_date, nullif(btrim(p_inspection_location), ''), btrim(p_brand),
      p_paper_bag_count, '{}'::numeric[], p_worker_id, p_worker_id
    );
    v_paper_inserted := 1;
  end if;

  return jsonb_build_object(
    'registration_no', v_registration_no,
    'flexcons_inserted', v_flexcon_inserted,
    'bulk_flexcons_inserted', v_bulk_inserted,
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
  p_inspector_name text,
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
  v_record_kind text;
  v_lot_number text;
  v_id uuid;
  v_inspector_name text;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select auth_record.authorization_no
  into v_authorization_no
  from public.flexcon_authorizations as auth_record
  where auth_record.id = p_authorization_id;

  select flexcon.record_kind
  into v_record_kind
  from public.flexcon_inspection_flexcons as flexcon
  where flexcon.id = p_flexcon_id
    and flexcon.authorization_id = p_authorization_id;

  if v_authorization_no is null then raise exception '委任状情報が見つかりません。'; end if;
  if v_record_kind is null then raise exception 'フレコン検査記録が見つかりません。'; end if;
  if v_authorization_no !~ '^[0-9]{1,4}$' then raise exception '委任状№は4桁以内の数字にしてください。'; end if;
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then raise exception '年度は1から99の整数で入力してください。'; end if;
  if p_purchase_date is null then raise exception '仕入日を入力してください。'; end if;
  if p_flexcon_no is null or p_flexcon_no not between 1 and 999 then raise exception '№は1から999で入力してください。'; end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then raise exception '銘柄を選択してください。'; end if;
  if p_quantity_kg is null or p_quantity_kg <= 0 then raise exception '数量は1kg以上で入力してください。'; end if;
  if p_moisture is not null and p_moisture not between 0 and 100 then raise exception '水分は0から100の範囲で入力してください。'; end if;
  if btrim(coalesce(p_grade, '')) in ('1等', '合格') and nullif(btrim(coalesce(p_reason, '')), '') is not null then
    raise exception '1等と合格には理由を入力できません。';
  end if;

  v_inspector_name := nullif(btrim(coalesce(p_inspector_name, '')), '');
  if v_inspector_name is not null and not exists (
    select 1 from public.flexcon_inspection_options as option_item
    where option_item.option_type = 'inspector'
      and option_item.active = true
      and option_item.name = v_inspector_name
  ) then
    raise exception '有効な検査員を選択してください。';
  end if;

  v_lot_number := case
    when v_record_kind = 'bulk' then
      '0000' || lpad(v_authorization_no, 4, '0') || lpad(p_flexcon_no::text, 3, '0')
    else
      lpad((p_fiscal_year + 2018)::text, 4, '0')
        || lpad(v_authorization_no, 4, '0')
        || lpad(p_flexcon_no::text, 3, '0')
  end;

  update public.flexcon_inspection_flexcons
  set fiscal_year = p_fiscal_year,
      purchase_date = p_purchase_date,
      inspection_date = p_inspection_date,
      inspector_name = v_inspector_name,
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
  where id = p_flexcon_id
    and authorization_id = p_authorization_id
  returning id into v_id;

  if v_id is null then raise exception 'フレコン検査記録を更新できませんでした。'; end if;
  return v_id;
end;
$$;

revoke all on function public.flexcon_add_inspection_group(
  text, uuid, integer, date, date, text, text, integer, integer, integer, integer
) from public;
grant execute on function public.flexcon_add_inspection_group(
  text, uuid, integer, date, date, text, text, integer, integer, integer, integer
) to anon, authenticated;

revoke all on function public.flexcon_save_inspection_flexcon(
  text, uuid, uuid, integer, date, date, text, text, integer, text, integer, text, text, numeric
) from public;
grant execute on function public.flexcon_save_inspection_flexcon(
  text, uuid, uuid, integer, date, date, text, text, integer, text, integer, text, text, numeric
) to anon, authenticated;

commit;
