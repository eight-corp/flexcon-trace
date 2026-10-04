begin;

lock table public.flexcon_inspection_flexcons in access exclusive mode;

create temporary table flexcon_bulk_number_changes on commit drop as
with maximums as (
  select authorization_id, max(flexcon_no) as maximum_no
  from public.flexcon_inspection_flexcons
  group by authorization_id
), conflicting_bulk as (
  select bulk.id, bulk.authorization_id, bulk.lot_number as old_lot_number,
    auth_record.authorization_no,
    maximums.maximum_no + row_number() over (
      partition by bulk.authorization_id
      order by bulk.flexcon_no, bulk.created_at, bulk.id
    ) as new_no
  from public.flexcon_inspection_flexcons as bulk
  join maximums on maximums.authorization_id = bulk.authorization_id
  join public.flexcon_authorizations as auth_record on auth_record.id = bulk.authorization_id
  where bulk.record_kind = 'bulk'
    and exists (
      select 1 from public.flexcon_inspection_flexcons as standard
      where standard.authorization_id = bulk.authorization_id
        and standard.record_kind = 'standard'
        and standard.flexcon_no = bulk.flexcon_no
    )
)
select id, old_lot_number, new_no::integer,
  '0000' || lpad(authorization_no, 4, '0') || lpad(new_no::text, 3, '0') as new_lot_number
from conflicting_bulk;

do $$
begin
  if exists (select 1 from flexcon_bulk_number_changes where new_no > 999) then
    raise exception '番号が999を超えるため、既存のバラを再採番できません。';
  end if;
  if exists (
    select 1 from flexcon_bulk_number_changes as change
    join public.flexcon_inspection_flexcons as flexcon on flexcon.id = change.id
    where coalesce(flexcon.certificate_print_count, 0) > 0
      or exists (select 1 from public.flexcon_shipment_items where lot_number = change.old_lot_number)
      or exists (select 1 from public.flexcon_flexcons where lot_number = change.old_lot_number)
  ) then
    raise exception '印刷・出荷済みのバラに重複番号があるため、自動再採番を中止しました。';
  end if;
end;
$$;

update public.flexcon_inspection_flexcons as flexcon
set flexcon_no = change.new_no, lot_number = change.new_lot_number
from flexcon_bulk_number_changes as change
where flexcon.id = change.id;

drop index if exists public.flexcon_inspection_flexcons_kind_no_unique;
create unique index if not exists flexcon_inspection_flexcons_authorization_no_unique
  on public.flexcon_inspection_flexcons (authorization_id, flexcon_no);

create or replace function public.flexcon_append_inspection_registration(
  p_worker_id text, p_registration_id uuid, p_fiscal_year integer,
  p_purchase_date date, p_settlement_no text, p_inspection_date date,
  p_inspection_location text, p_brand text,
  p_flexcon_count integer, p_paper_bag_count integer, p_bulk_quantity_kg integer
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_authorization_id uuid; v_authorization_no text; v_next_no integer; v_bulk_no integer; v_weight integer;
  v_warehouse_id uuid; v_brand text := btrim(coalesce(p_brand, ''));
  v_location text := btrim(coalesce(p_inspection_location, ''));
  v_settlement_no text := btrim(coalesce(p_settlement_no, ''));
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  select authorization_id into v_authorization_id from public.flexcon_inspection_registrations where id = p_registration_id;
  if not found then raise exception '登録No.が見つかりません。'; end if;
  select authorization_no into v_authorization_no from public.flexcon_authorizations where id = v_authorization_id for update;
  perform 1 from public.flexcon_inspection_registrations where id = p_registration_id for update;
  if not found then raise exception '登録No.が見つかりません。'; end if;
  if v_authorization_no is null or v_authorization_no !~ '^[0-9]{1,4}$' then raise exception '委任状№は4桁以内の数字にしてください。'; end if;
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then raise exception '年度は1から99の整数で入力してください。'; end if;
  if p_purchase_date is null then raise exception '仕入日を入力してください。'; end if;
  if char_length(v_settlement_no) > 80 then raise exception '仕切書№は80文字以内で入力してください。'; end if;
  if not exists (select 1 from public.flexcon_inspection_options where option_type = 'location' and active and name = v_location) then raise exception '検査場所を選択してください。'; end if;
  select id into v_warehouse_id from public.flexcon_inspection_options
  where option_type = 'warehouse' and active and name = v_location order by sort_order, id limit 1;
  if not found then raise exception '検査場所と同じ名前の有効な倉庫がありません。'; end if;
  if v_brand = '' then raise exception '銘柄を選択してください。'; end if;
  if p_flexcon_count is null or p_paper_bag_count is null or p_bulk_quantity_kg is null
    or p_flexcon_count < 0 or p_flexcon_count > 999 or p_paper_bag_count < 0 or p_bulk_quantity_kg < 0
    or (p_flexcon_count = 0 and p_paper_bag_count = 0 and p_bulk_quantity_kg = 0) then
    raise exception '推フレ数・紙袋数・バラは0以上の整数で、いずれかを1以上入力してください。';
  end if;
  select coalesce(max(flexcon_no), 0) + 1 into v_next_no
  from public.flexcon_inspection_flexcons where authorization_id = v_authorization_id;
  v_bulk_no := v_next_no + p_flexcon_count;
  if p_flexcon_count > 0 and v_bulk_no - 1 > 999 then raise exception '推フレ№が999を超えるため追加できません。'; end if;
  if p_bulk_quantity_kg > 0 and v_bulk_no > 999 then raise exception 'バラ№が999を超えるため追加できません。'; end if;
  select coalesce((select weight_kg from public.flexcon_inspection_weights
    where weight_type = case when v_brand = '飼料用玄米' then 'feed_rice' else 'branded_rice' end),
    case when v_brand = '飼料用玄米' then 1000 else 1020 end) into v_weight;
  insert into public.flexcon_inspection_flexcons (
    registration_id, authorization_id, fiscal_year, purchase_date, inspection_date, inspection_location,
    record_kind, flexcon_no, lot_number, brand, quantity_kg, moisture_values, created_by_worker_id, updated_by_worker_id, warehouse_id, settlement_no
  ) select p_registration_id, v_authorization_id, p_fiscal_year, p_purchase_date, p_inspection_date, v_location,
    'standard', v_next_no + n, lpad((p_fiscal_year + 2018)::text,4,'0') || lpad(v_authorization_no,4,'0') || lpad((v_next_no+n)::text,3,'0'),
    v_brand, v_weight, '{}'::numeric[], p_worker_id, p_worker_id, v_warehouse_id, v_settlement_no
  from generate_series(0, p_flexcon_count-1) as series(n);
  if p_bulk_quantity_kg > 0 then
    insert into public.flexcon_inspection_flexcons (
      registration_id, authorization_id, fiscal_year, purchase_date, inspection_date, inspection_location,
      record_kind, flexcon_no, lot_number, brand, quantity_kg, moisture_values, created_by_worker_id, updated_by_worker_id, warehouse_id, settlement_no
    ) values (p_registration_id, v_authorization_id, p_fiscal_year, p_purchase_date, p_inspection_date, v_location,
      'bulk', v_bulk_no, '0000' || lpad(v_authorization_no,4,'0') || lpad(v_bulk_no::text,3,'0'),
      v_brand, p_bulk_quantity_kg, '{}'::numeric[], p_worker_id, p_worker_id, v_warehouse_id, v_settlement_no);
  end if;
  if p_paper_bag_count > 0 then
    insert into public.flexcon_inspection_paper_bags (
      registration_id, authorization_id, fiscal_year, purchase_date, inspection_date, inspection_location,
      brand, bag_count, moisture_values, created_by_worker_id, updated_by_worker_id, warehouse_id, settlement_no
    ) values (p_registration_id, v_authorization_id, p_fiscal_year, p_purchase_date, p_inspection_date, v_location,
      v_brand, p_paper_bag_count, '{}'::numeric[], p_worker_id, p_worker_id, v_warehouse_id, v_settlement_no);
  end if;
end;
$$;

create or replace function public.flexcon_add_inspection_registration_detail(
  p_worker_id text, p_registration_id uuid, p_detail_kind text, p_amount integer
)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_authorization_id uuid; v_authorization_no text; v_fiscal_year integer;
  v_purchase_date date; v_inspection_date date; v_inspector_name text;
  v_inspection_location text; v_brand text; v_quantity_kg integer;
  v_next_no integer; v_index integer;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  select registration.authorization_id into v_authorization_id
  from public.flexcon_inspection_registrations as registration where registration.id = p_registration_id;
  if v_authorization_id is null then raise exception '登録No.が見つかりません。'; end if;
  select auth_record.authorization_no into v_authorization_no
  from public.flexcon_authorizations as auth_record where auth_record.id = v_authorization_id for update;
  if v_authorization_no !~ '^[0-9]{1,4}$' then raise exception '委任状№は4桁以内の数字にしてください。'; end if;
  if p_detail_kind not in ('standard', 'paper', 'bulk') or p_detail_kind is null then raise exception '追加する種別が正しくありません。'; end if;
  if p_amount is null or p_amount < 1 then raise exception '追加する本数・袋数・数量は1以上の整数で入力してください。'; end if;

  select flexcon.fiscal_year, flexcon.purchase_date, flexcon.inspection_date,
    flexcon.inspector_name, flexcon.inspection_location, flexcon.brand
  into v_fiscal_year, v_purchase_date, v_inspection_date,
    v_inspector_name, v_inspection_location, v_brand
  from public.flexcon_inspection_flexcons as flexcon
  where flexcon.registration_id = p_registration_id
  order by case when flexcon.record_kind = 'standard' then 0 else 1 end,
    flexcon.created_at, flexcon.id limit 1;
  if not found then
    select paper.fiscal_year, paper.purchase_date, paper.inspection_date,
      paper.inspector_name, paper.inspection_location, paper.brand
    into v_fiscal_year, v_purchase_date, v_inspection_date,
      v_inspector_name, v_inspection_location, v_brand
    from public.flexcon_inspection_paper_bags as paper
    where paper.registration_id = p_registration_id
    order by paper.created_at, paper.id limit 1;
  end if;
  if v_fiscal_year is null or v_purchase_date is null or nullif(btrim(v_brand), '') is null then
    raise exception '追加元になる明細がありません。既存の明細の年度・仕入日・銘柄を確認してください。';
  end if;
  if p_detail_kind = 'paper' then
    insert into public.flexcon_inspection_paper_bags (
      registration_id, authorization_id, fiscal_year, purchase_date,
      inspection_date, inspector_name, inspection_location, brand,
      bag_count, created_by_worker_id, updated_by_worker_id
    ) values (
      p_registration_id, v_authorization_id, v_fiscal_year, v_purchase_date,
      v_inspection_date, v_inspector_name, v_inspection_location, v_brand,
      p_amount, p_worker_id, p_worker_id
    );
    return 1;
  end if;

  select coalesce(max(flexcon.flexcon_no), 0) + 1 into v_next_no
  from public.flexcon_inspection_flexcons as flexcon
  where flexcon.authorization_id = v_authorization_id;
  if p_detail_kind = 'bulk' then
    if exists (
      select 1 from public.flexcon_inspection_flexcons
      where registration_id = p_registration_id and record_kind = 'bulk'
    ) then raise exception 'この登録には既にバラの明細があります。数量を修正してください。'; end if;
    if v_next_no > 999 then raise exception 'バラ№が999を超えるため追加できません。'; end if;
    insert into public.flexcon_inspection_flexcons (
      registration_id, authorization_id, fiscal_year, purchase_date,
      inspection_date, inspector_name, inspection_location, record_kind,
      flexcon_no, lot_number, brand, quantity_kg,
      created_by_worker_id, updated_by_worker_id
    ) values (
      p_registration_id, v_authorization_id, v_fiscal_year, v_purchase_date,
      v_inspection_date, v_inspector_name, v_inspection_location, 'bulk',
      v_next_no, '0000' || lpad(v_authorization_no, 4, '0') || lpad(v_next_no::text, 3, '0'),
      v_brand, p_amount, p_worker_id, p_worker_id
    );
    return 1;
  end if;
  if v_next_no + p_amount - 1 > 999 then raise exception '推フレ№が999を超えるため追加できません。'; end if;
  select coalesce((
    select weight.weight_kg from public.flexcon_inspection_weights as weight
    where weight.weight_type = case when v_brand = '飼料用玄米' then 'feed_rice' else 'branded_rice' end
  ), case when v_brand = '飼料用玄米' then 1000 else 1020 end) into v_quantity_kg;
  for v_index in 0..p_amount - 1 loop
    insert into public.flexcon_inspection_flexcons (
      registration_id, authorization_id, fiscal_year, purchase_date,
      inspection_date, inspector_name, inspection_location, record_kind,
      flexcon_no, lot_number, brand, quantity_kg,
      created_by_worker_id, updated_by_worker_id
    ) values (
      p_registration_id, v_authorization_id, v_fiscal_year, v_purchase_date,
      v_inspection_date, v_inspector_name, v_inspection_location, 'standard',
      v_next_no + v_index,
      lpad((v_fiscal_year + 2018)::text, 4, '0') || lpad(v_authorization_no, 4, '0')
        || lpad((v_next_no + v_index)::text, 3, '0'),
      v_brand, v_quantity_kg, p_worker_id, p_worker_id
    );
  end loop;
  return p_amount;
end;
$$;

commit;
