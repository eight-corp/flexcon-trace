begin;

-- Preserve the old append signature for older clients, and keep both entry points undoable.
create or replace function public._flexcon_undo_impl_append_inspection_quantity(
  p_worker_id text, p_registration_id uuid, p_fiscal_year integer,
  p_purchase_date date, p_settlement_no text, p_inspection_date date,
  p_inspection_location text, p_brand text,
  p_flexcon_count integer, p_paper_bag_count integer, p_bulk_quantity_kg integer,
  p_flexcon_quantity_kg integer
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
  if p_flexcon_count > 0 and p_flexcon_quantity_kg is not null and p_flexcon_quantity_kg < 1 then
    raise exception '推フレの数量は1kg以上の整数で入力してください。';
  end if;
  v_weight := coalesce(p_flexcon_quantity_kg, v_weight);
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

revoke all on function public._flexcon_undo_impl_append_inspection_quantity(text, uuid, integer, date, text, date, text, text, integer, integer, integer, integer) from public, anon, authenticated;

create or replace function public.flexcon_append_inspection_registration(
  p_worker_id text, p_registration_id uuid, p_fiscal_year integer,
  p_purchase_date date, p_settlement_no text, p_inspection_date date,
  p_inspection_location text, p_brand text,
  p_flexcon_count integer, p_paper_bag_count integer, p_bulk_quantity_kg integer,
  p_flexcon_quantity_kg integer
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_root boolean;
begin
  v_root := flexcon_undo_private.prepare(p_worker_id, 'flexcon_append_inspection_registration', 'rice_shipping');
  perform public._flexcon_undo_impl_append_inspection_quantity(p_worker_id,p_registration_id,p_fiscal_year,p_purchase_date,p_settlement_no,p_inspection_date,p_inspection_location,p_brand,p_flexcon_count,p_paper_bag_count,p_bulk_quantity_kg,p_flexcon_quantity_kg);
  if v_root then perform flexcon_undo_private.finish(); end if;
end;
$$;
revoke all on function public.flexcon_append_inspection_registration(text, uuid, integer, date, text, date, text, text, integer, integer, integer, integer) from public;
grant execute on function public.flexcon_append_inspection_registration(text, uuid, integer, date, text, date, text, text, integer, integer, integer, integer) to anon, authenticated;
insert into flexcon_undo_private.rpcs(function_name,argument_types,implementation_name,app_id)
  values ('flexcon_append_inspection_registration','text, uuid, integer, date, text, date, text, text, integer, integer, integer, integer','_flexcon_undo_impl_append_inspection_quantity','rice_shipping')
  on conflict(function_name,argument_types) do update set implementation_name=excluded.implementation_name, app_id=excluded.app_id;

create or replace function public._flexcon_undo_impl_add_inspection_quantity(
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
    p_flexcon_count, p_paper_bag_count, p_bulk_quantity_kg, p_flexcon_quantity_kg);
  return jsonb_build_object('registration_id', v_registration.id, 'registration_no', v_registration.registration_no, 'warehouse_id', p_warehouse_id);
end;
$$;

revoke all on function public._flexcon_undo_impl_add_inspection_quantity(text, uuid, integer, date, date, text, text, integer, integer, integer, integer, uuid, text) from public, anon, authenticated;

create or replace function public.flexcon_add_inspection_group_with_warehouse(
  p_worker_id text, p_authorization_id uuid, p_fiscal_year integer, p_purchase_date date,
  p_inspection_date date, p_inspection_location text, p_brand text,
  p_flexcon_count integer, p_paper_bag_count integer, p_flexcon_quantity_kg integer,
  p_bulk_quantity_kg integer, p_warehouse_id uuid, p_settlement_no text
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_root boolean; v_result jsonb;
begin
  v_root := flexcon_undo_private.prepare(p_worker_id, 'flexcon_add_inspection_group_with_warehouse', 'rice_shipping');
  v_result := public._flexcon_undo_impl_add_inspection_quantity(p_worker_id,p_authorization_id,p_fiscal_year,p_purchase_date,p_inspection_date,p_inspection_location,p_brand,p_flexcon_count,p_paper_bag_count,p_flexcon_quantity_kg,p_bulk_quantity_kg,p_warehouse_id,p_settlement_no);
  if v_root then perform flexcon_undo_private.finish(); end if;
  return v_result;
end;
$$;
revoke all on function public.flexcon_add_inspection_group_with_warehouse(text, uuid, integer, date, date, text, text, integer, integer, integer, integer, uuid, text) from public;
grant execute on function public.flexcon_add_inspection_group_with_warehouse(text, uuid, integer, date, date, text, text, integer, integer, integer, integer, uuid, text) to anon, authenticated;
insert into flexcon_undo_private.rpcs(function_name,argument_types,implementation_name,app_id)
  values ('flexcon_add_inspection_group_with_warehouse','text, uuid, integer, date, date, text, text, integer, integer, integer, integer, uuid, text','_flexcon_undo_impl_add_inspection_quantity','rice_shipping')
  on conflict(function_name,argument_types) do update set implementation_name=excluded.implementation_name, app_id=excluded.app_id;

notify pgrst, 'reload schema';
commit;

