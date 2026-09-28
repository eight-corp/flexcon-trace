begin;
create or replace function public.flexcon_append_inspection_registration(
  p_worker_id text, p_registration_id uuid, p_fiscal_year integer,
  p_purchase_date date, p_settlement_no text, p_inspection_date date,
  p_inspection_location text, p_brand text,
  p_flexcon_count integer, p_paper_bag_count integer, p_bulk_quantity_kg integer
)
returns void language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_authorization_id uuid;
  v_authorization_no text;
  v_next_no integer;
  v_bulk_no integer;
  v_weight integer;
  v_brand text := btrim(coalesce(p_brand, ''));
  v_location text := btrim(coalesce(p_inspection_location, ''));
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  select authorization_id into v_authorization_id
  from public.flexcon_inspection_registrations where id = p_registration_id for update;
  if not found then raise exception '登録No.が見つかりません。'; end if;
  select authorization_no into v_authorization_no
  from public.flexcon_authorizations where id = v_authorization_id for update;
  if v_authorization_no is null or v_authorization_no !~ '^[0-9]{1,4}$' then
    raise exception '委任状№は4桁以内の数字にしてください。';
  end if;
  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then raise exception '年度は1から99の整数で入力してください。'; end if;
  if p_purchase_date is null then raise exception '仕入日を入力してください。'; end if;
  if char_length(btrim(coalesce(p_settlement_no, ''))) > 80 then raise exception '仕切書№は80文字以内で入力してください。'; end if;
  if not exists (select 1 from public.flexcon_inspection_options where option_type = 'location' and active and name = v_location) then
    raise exception '検査場所を選択してください。';
  end if;
  if v_brand = '' then raise exception '銘柄を選択してください。'; end if;
  if p_flexcon_count is null or p_paper_bag_count is null or p_bulk_quantity_kg is null
     or p_flexcon_count < 0 or p_flexcon_count > 999 or p_paper_bag_count < 0 or p_bulk_quantity_kg < 0
     or (p_flexcon_count = 0 and p_paper_bag_count = 0 and p_bulk_quantity_kg = 0) then
    raise exception '推フレ数・紙袋数・バラは0以上の整数で、いずれかを1以上入力してください。';
  end if;

  select coalesce(max(flexcon_no), 0) + 1 into v_next_no
  from public.flexcon_inspection_flexcons where authorization_id = v_authorization_id and record_kind = 'standard';
  select coalesce(max(flexcon_no), 0) + 1 into v_bulk_no
  from public.flexcon_inspection_flexcons where authorization_id = v_authorization_id and record_kind = 'bulk';
  if p_flexcon_count > 0 and v_next_no + p_flexcon_count - 1 > 999 then raise exception '推フレ№が999を超えるため追加できません。'; end if;
  if p_bulk_quantity_kg > 0 and v_bulk_no > 999 then raise exception 'バラ№が999を超えるため追加できません。'; end if;
  select coalesce((select weight_kg from public.flexcon_inspection_weights
    where weight_type = case when v_brand = '飼料用玄米' then 'feed_rice' else 'branded_rice' end),
    case when v_brand = '飼料用玄米' then 1000 else 1020 end) into v_weight;

  insert into public.flexcon_inspection_flexcons (
    registration_id, authorization_id, fiscal_year, purchase_date, inspection_date,
    inspection_location, record_kind, flexcon_no, lot_number, brand, quantity_kg,
    moisture_values, created_by_worker_id, updated_by_worker_id
  ) select p_registration_id, v_authorization_id, p_fiscal_year, p_purchase_date, p_inspection_date,
    v_location, 'standard', v_next_no + n,
    lpad((p_fiscal_year + 2018)::text, 4, '0') || lpad(v_authorization_no, 4, '0') || lpad((v_next_no + n)::text, 3, '0'),
    v_brand, v_weight, '{}'::numeric[], p_worker_id, p_worker_id
  from generate_series(0, p_flexcon_count - 1) as series(n);

  if p_bulk_quantity_kg > 0 then
    insert into public.flexcon_inspection_flexcons (
      registration_id, authorization_id, fiscal_year, purchase_date, inspection_date,
      inspection_location, record_kind, flexcon_no, lot_number, brand, quantity_kg,
      moisture_values, created_by_worker_id, updated_by_worker_id
    ) values (p_registration_id, v_authorization_id, p_fiscal_year, p_purchase_date, p_inspection_date,
      v_location, 'bulk', v_bulk_no, '0000' || lpad(v_authorization_no, 4, '0') || lpad(v_bulk_no::text, 3, '0'),
      v_brand, p_bulk_quantity_kg, '{}'::numeric[], p_worker_id, p_worker_id);
  end if;
  if p_paper_bag_count > 0 then
    insert into public.flexcon_inspection_paper_bags (
      registration_id, authorization_id, fiscal_year, purchase_date, inspection_date,
      inspection_location, brand, bag_count, moisture_values, created_by_worker_id, updated_by_worker_id
    ) values (p_registration_id, v_authorization_id, p_fiscal_year, p_purchase_date, p_inspection_date,
      v_location, v_brand, p_paper_bag_count, '{}'::numeric[], p_worker_id, p_worker_id);
  end if;
  -- Settlement and warehouse belong to the registration, not to individual details.
  update public.flexcon_inspection_registrations
  set settlement_no = nullif(btrim(coalesce(p_settlement_no, '')), '') where id = p_registration_id;
end;
$$;
revoke all on function public.flexcon_append_inspection_registration(text, uuid, integer, date, text, date, text, text, integer, integer, integer) from public;
grant execute on function public.flexcon_append_inspection_registration(text, uuid, integer, date, text, date, text, text, integer, integer, integer) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
