begin;

lock table public.flexcon_inspection_registrations, public.flexcon_inspection_flexcons,
  public.flexcon_inspection_paper_bags in share row exclusive mode;

create temporary table flexcon_stock_before_consolidation on commit drop as
select * from public.flexcon_inventory_balances;
create temporary table flexcon_yearly_stock_before_consolidation on commit drop as
select * from public.flexcon_inventory_balances_by_crop_year;

alter table public.flexcon_inspection_flexcons
  add column if not exists warehouse_id uuid references public.flexcon_inspection_options(id),
  add column if not exists settlement_no text check (char_length(settlement_no) <= 80);
alter table public.flexcon_inspection_paper_bags
  add column if not exists warehouse_id uuid references public.flexcon_inspection_options(id),
  add column if not exists settlement_no text check (char_length(settlement_no) <= 80);

-- Snapshot original registration metadata before consolidating details.
update public.flexcon_inspection_flexcons d
set warehouse_id = coalesce(r.warehouse_id, (select id from public.flexcon_inspection_options
      where option_type = 'warehouse' and name = '倉庫未設定' order by created_at limit 1)),
    settlement_no = coalesce(r.settlement_no, '')
from public.flexcon_inspection_registrations r
where d.registration_id = r.id and d.warehouse_id is null;
update public.flexcon_inspection_paper_bags d
set warehouse_id = coalesce(r.warehouse_id, (select id from public.flexcon_inspection_options
      where option_type = 'warehouse' and name = '倉庫未設定' order by created_at limit 1)),
    settlement_no = coalesce(r.settlement_no, '')
from public.flexcon_inspection_registrations r
where d.registration_id = r.id and d.warehouse_id is null;

create or replace function public.flexcon_initialize_detail_inventory_metadata()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  select coalesce(new.warehouse_id, r.warehouse_id, (select id from public.flexcon_inspection_options
      where option_type = 'warehouse' and name = '倉庫未設定' order by created_at limit 1)),
    coalesce(new.settlement_no, r.settlement_no, '')
  into new.warehouse_id, new.settlement_no
  from public.flexcon_inspection_registrations r where r.id = new.registration_id;
  return new;
end;
$$;
revoke all on function public.flexcon_initialize_detail_inventory_metadata() from public;
drop trigger if exists flexcon_detail_inventory_metadata on public.flexcon_inspection_flexcons;
create trigger flexcon_detail_inventory_metadata before insert on public.flexcon_inspection_flexcons
for each row execute function public.flexcon_initialize_detail_inventory_metadata();
drop trigger if exists flexcon_detail_inventory_metadata on public.flexcon_inspection_paper_bags;
create trigger flexcon_detail_inventory_metadata before insert on public.flexcon_inspection_paper_bags
for each row execute function public.flexcon_initialize_detail_inventory_metadata();
alter table public.flexcon_inspection_flexcons alter column warehouse_id set not null, alter column settlement_no set not null;
alter table public.flexcon_inspection_paper_bags alter column warehouse_id set not null, alter column settlement_no set not null;

with canonical as (
  select distinct on (authorization_id) authorization_id, id
  from public.flexcon_inspection_registrations order by authorization_id, registration_no, id
)
update public.flexcon_inspection_flexcons d set registration_id = c.id
from canonical c where d.authorization_id = c.authorization_id and d.registration_id <> c.id;
with canonical as (
  select distinct on (authorization_id) authorization_id, id
  from public.flexcon_inspection_registrations order by authorization_id, registration_no, id
)
update public.flexcon_inspection_paper_bags d set registration_id = c.id
from canonical c where d.authorization_id = c.authorization_id and d.registration_id <> c.id;

-- Keep archived registration headers and the original ledger view; no records are deleted.
do $$
begin
  if to_regclass('public.flexcon_inventory_ledger_registration_base') is null then
    alter view public.flexcon_inventory_ledger_base rename to flexcon_inventory_ledger_registration_base;
  end if;
end;
$$;
create or replace view public.flexcon_inventory_ledger_base with (security_invoker = true) as
select base.id, base.registration_order, base.source_type, base.movement_type,
  base.movement_date, base.worker_name, base.producer_name,
  case when flexcon.id is not null then flexcon.settlement_no
       when paper.id is not null then paper.settlement_no else base.settlement_no end as settlement_no,
  base.origin, base.product_name, base.grade, base.quantity, base.unit, base.from_warehouse_id,
  case when flexcon.id is not null then flexcon.warehouse_id
       when paper.id is not null then paper.warehouse_id else base.to_warehouse_id end as to_warehouse_id,
  base.movement_from,
  case when flexcon.id is not null or paper.id is not null then warehouse.name else base.movement_to end as movement_to,
  base.created_at, base.purchase_price
from public.flexcon_inventory_ledger_registration_base base
left join public.flexcon_inspection_flexcons flexcon
  on base.source_type = 'inspection_flexcon' and base.id = 'inspection-flexcon:' || flexcon.id::text
left join public.flexcon_inspection_paper_bags paper
  on base.source_type = 'inspection_paper_bag' and base.id = 'inspection-paper:' || paper.id::text
left join public.flexcon_inspection_options warehouse on warehouse.id = coalesce(flexcon.warehouse_id, paper.warehouse_id);

-- Rebind dependent views after renaming the old base view.
create or replace view public.flexcon_inventory_balances_base with (security_invoker = true) as
with delta as (
  select to_warehouse_id as warehouse_id, origin, product_name, grade, unit, quantity
  from public.flexcon_inventory_ledger_base where to_warehouse_id is not null or source_type = 'settlement'
  union all
  select from_warehouse_id, origin, product_name, grade, unit, -quantity
  from public.flexcon_inventory_ledger_base where from_warehouse_id is not null
), normalized as (
  select case when warehouse.name = '倉庫未設定' then null::uuid else delta.warehouse_id end as warehouse_id,
    delta.origin, delta.product_name, coalesce(nullif(btrim(delta.grade), ''), '対象外') as grade, delta.unit, delta.quantity
  from delta left join public.flexcon_inspection_options warehouse on warehouse.id = delta.warehouse_id
)
select normalized.warehouse_id, coalesce(warehouse.name, '倉庫未設定') as warehouse_name,
  normalized.origin, normalized.product_name, normalized.grade, normalized.unit,
  sum(normalized.quantity)::numeric(14,3) as quantity
from normalized left join public.flexcon_inspection_options warehouse on warehouse.id = normalized.warehouse_id
group by normalized.warehouse_id, warehouse.name, normalized.origin, normalized.product_name, normalized.grade, normalized.unit
having sum(normalized.quantity) <> 0;

-- The public ledger includes crop years and manual shipments in later migrations.
do $$
declare v_definition text;
begin
  v_definition := pg_get_viewdef('public.flexcon_inventory_ledger'::regclass, true);
  v_definition := replace(v_definition, 'flexcon_inventory_ledger_registration_base', 'flexcon_inventory_ledger_base');
  execute 'create or replace view public.flexcon_inventory_ledger with (security_invoker = true) as ' || v_definition;
end;
$$;

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
  -- All additions lock the authorization before the registration, including first-time additions.
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
  select coalesce(max(flexcon_no), 0) + 1 into v_next_no from public.flexcon_inspection_flexcons where authorization_id = v_authorization_id and record_kind = 'standard';
  select coalesce(max(flexcon_no), 0) + 1 into v_bulk_no from public.flexcon_inspection_flexcons where authorization_id = v_authorization_id and record_kind = 'bulk';
  if p_flexcon_count > 0 and v_next_no + p_flexcon_count - 1 > 999 then raise exception '推フレ№が999を超えるため追加できません。'; end if;
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

create or replace function public.flexcon_add_inspection_group_with_warehouse(
  p_worker_id text, p_authorization_id uuid, p_fiscal_year integer,
  p_purchase_date date, p_inspection_date date, p_inspection_location text,
  p_brand text, p_flexcon_count integer, p_paper_bag_count integer,
  p_flexcon_quantity_kg integer, p_bulk_quantity_kg integer, p_warehouse_id uuid, p_settlement_no text
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_registration public.flexcon_inspection_registrations%rowtype;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  perform 1 from public.flexcon_authorizations where id = p_authorization_id for update;
  if not found then raise exception '委任状が見つかりません。'; end if;
  if not exists (select 1 from public.flexcon_inspection_options where id = p_warehouse_id
    and option_type = 'warehouse' and active and name = btrim(p_inspection_location)) then
    raise exception '検査場所と同じ名前の搬入先を選択してください。';
  end if;
  select * into v_registration from public.flexcon_inspection_registrations
  where authorization_id = p_authorization_id order by registration_no, id limit 1 for update;
  if not found then
    insert into public.flexcon_inspection_registrations (authorization_id, warehouse_id, settlement_no, created_by_worker_id)
    values (p_authorization_id, p_warehouse_id, nullif(btrim(p_settlement_no), ''), p_worker_id)
    returning * into v_registration;
  end if;
  perform public.flexcon_append_inspection_registration(p_worker_id, v_registration.id, p_fiscal_year,
    p_purchase_date, p_settlement_no, p_inspection_date, p_inspection_location, p_brand,
    p_flexcon_count, p_paper_bag_count, p_bulk_quantity_kg);
  return jsonb_build_object('registration_id', v_registration.id, 'registration_no', v_registration.registration_no, 'warehouse_id', p_warehouse_id);
end;
$$;

-- Splitting must copy the detail's metadata, not the shared registration defaults.
do $$
begin
  if to_regprocedure('public.flexcon_split_inspection_paper_bags_before_detail_metadata(text,uuid,integer,integer)') is null then
    alter function public.flexcon_split_inspection_paper_bags(text,uuid,integer,integer)
      rename to flexcon_split_inspection_paper_bags_before_detail_metadata;
  end if;
end;
$$;
revoke all on function public.flexcon_split_inspection_paper_bags_before_detail_metadata(text,uuid,integer,integer) from public, anon, authenticated;
create or replace function public.flexcon_split_inspection_paper_bags(
  p_worker_id text, p_paper_bag_id uuid, p_first_bag_count integer, p_second_bag_count integer
)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_source public.flexcon_inspection_paper_bags%rowtype; v_new_id uuid;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  select * into v_source from public.flexcon_inspection_paper_bags where id = p_paper_bag_id for update;
  v_new_id := public.flexcon_split_inspection_paper_bags_before_detail_metadata(p_worker_id, p_paper_bag_id, p_first_bag_count, p_second_bag_count);
  update public.flexcon_inspection_paper_bags
  set warehouse_id = v_source.warehouse_id, settlement_no = v_source.settlement_no where id = v_new_id;
  return v_new_id;
end;
$$;

create or replace function public.flexcon_save_inspection_detail_with_settlement(
  p_worker_id text, p_detail_kind text, p_detail_id uuid, p_authorization_id uuid,
  p_fiscal_year integer, p_purchase_date date, p_inspection_date date, p_inspector_name text,
  p_inspection_location text, p_flexcon_no integer, p_brand text, p_quantity integer,
  p_grade text, p_reason text, p_moisture numeric, p_settlement_no text
)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_value text := btrim(coalesce(p_settlement_no, '')); v_id uuid;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  if char_length(v_value) > 80 then raise exception '仕切書№は80文字以内で入力してください。'; end if;
  if p_detail_kind = 'flexcon' then
    v_id := public.flexcon_save_inspection_flexcon(p_worker_id, p_detail_id, p_authorization_id,
      p_fiscal_year, p_purchase_date, p_inspection_date, p_inspector_name, p_inspection_location,
      p_flexcon_no, p_brand, p_quantity, p_grade, p_reason, p_moisture);
    update public.flexcon_inspection_flexcons set settlement_no = v_value where id = v_id;
  elsif p_detail_kind = 'paper' then
    v_id := public.flexcon_save_inspection_paper_bags(p_worker_id, p_detail_id, p_authorization_id,
      p_fiscal_year, p_purchase_date, p_inspection_date, p_inspector_name, p_inspection_location,
      p_brand, p_quantity, p_grade, p_reason, p_moisture);
    update public.flexcon_inspection_paper_bags set settlement_no = v_value where id = v_id;
  else raise exception '明細の種別が正しくありません。';
  end if;
  return v_id;
end;
$$;
revoke all on function public.flexcon_save_inspection_detail_with_settlement(text,text,uuid,uuid,integer,date,date,text,text,integer,text,integer,text,text,numeric,text) from public;
revoke all on function public.flexcon_split_inspection_paper_bags(text,uuid,integer,integer) from public;
grant execute on function public.flexcon_save_inspection_detail_with_settlement(text,text,uuid,uuid,integer,date,date,text,text,integer,text,integer,text,text,numeric,text) to anon, authenticated;
grant execute on function public.flexcon_split_inspection_paper_bags(text,uuid,integer,integer) to anon, authenticated;
grant select on public.flexcon_inventory_ledger_base to anon, authenticated;

do $$
begin
  if exists (select * from flexcon_stock_before_consolidation except all select * from public.flexcon_inventory_balances)
    or exists (select * from public.flexcon_inventory_balances except all select * from flexcon_stock_before_consolidation)
    or exists (select * from flexcon_yearly_stock_before_consolidation except all select * from public.flexcon_inventory_balances_by_crop_year)
    or exists (select * from public.flexcon_inventory_balances_by_crop_year except all select * from flexcon_yearly_stock_before_consolidation) then
    raise exception '在庫の前後比較が一致しないため、変更を取り消します。';
  end if;
end;
$$;
notify pgrst, 'reload schema';
commit;
