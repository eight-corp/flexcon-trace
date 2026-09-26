begin;

create or replace function public.flexcon_add_inspection_registration_detail(
  p_worker_id text,
  p_registration_id uuid,
  p_detail_kind text,
  p_amount integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_authorization_id uuid;
  v_authorization_no text;
  v_fiscal_year integer;
  v_purchase_date date;
  v_inspection_date date;
  v_inspector_name text;
  v_inspection_location text;
  v_brand text;
  v_quantity_kg integer;
  v_next_no integer;
  v_index integer;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select registration.authorization_id into v_authorization_id
  from public.flexcon_inspection_registrations as registration
  where registration.id = p_registration_id;
  if v_authorization_id is null then raise exception '登録No.が見つかりません。'; end if;

  select auth_record.authorization_no into v_authorization_no
  from public.flexcon_authorizations as auth_record
  where auth_record.id = v_authorization_id
  for update;
  if v_authorization_no !~ '^[0-9]{1,4}$' then
    raise exception '委任状№は4桁以内の数字にしてください。';
  end if;
  if p_detail_kind not in ('standard', 'paper', 'bulk') or p_detail_kind is null then
    raise exception '追加する種別が正しくありません。';
  end if;
  if p_amount is null or p_amount < 1 then
    raise exception '追加する本数・袋数・数量は1以上の整数で入力してください。';
  end if;

  select flexcon.fiscal_year, flexcon.purchase_date, flexcon.inspection_date,
    flexcon.inspector_name, flexcon.inspection_location, flexcon.brand
  into v_fiscal_year, v_purchase_date, v_inspection_date,
    v_inspector_name, v_inspection_location, v_brand
  from public.flexcon_inspection_flexcons as flexcon
  where flexcon.registration_id = p_registration_id
  order by case when flexcon.record_kind = 'standard' then 0 else 1 end,
    flexcon.created_at, flexcon.id
  limit 1;

  if not found then
    select paper.fiscal_year, paper.purchase_date, paper.inspection_date,
      paper.inspector_name, paper.inspection_location, paper.brand
    into v_fiscal_year, v_purchase_date, v_inspection_date,
      v_inspector_name, v_inspection_location, v_brand
    from public.flexcon_inspection_paper_bags as paper
    where paper.registration_id = p_registration_id
    order by paper.created_at, paper.id
    limit 1;
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
  where flexcon.authorization_id = v_authorization_id
    and flexcon.record_kind = p_detail_kind;

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

  if v_next_no + p_amount - 1 > 999 then
    raise exception '推フレ№が999を超えるため追加できません。';
  end if;
  select coalesce((
    select weight.weight_kg from public.flexcon_inspection_weights as weight
    where weight.weight_type = case when v_brand = '飼料用玄米' then 'feed_rice' else 'branded_rice' end
  ), case when v_brand = '飼料用玄米' then 1000 else 1020 end)
  into v_quantity_kg;

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

revoke all on function public.flexcon_add_inspection_registration_detail(text, uuid, text, integer) from public;
grant execute on function public.flexcon_add_inspection_registration_detail(text, uuid, text, integer) to anon, authenticated;

commit;
