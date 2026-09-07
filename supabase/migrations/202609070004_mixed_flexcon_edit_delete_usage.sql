-- 混在フレコンの使用数量変更・削除・元検査記録への使用状況表示に対応します。
-- 202609070003_mixed_flexcon_source_records.sql の実行後に適用してください。

begin;

drop index if exists public.flexcon_mixed_members_source_flexcon_idx;
create index if not exists flexcon_mixed_members_source_flexcon_idx
  on public.flexcon_mixed_flexcon_members (source_flexcon_id)
  where source_flexcon_id is not null;

create or replace function public.flexcon_guard_mixed_source_record()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_allocated integer;
  v_expected_weight integer;
begin
  select coalesce(sum(quantity_kg), 0) into v_allocated
  from public.flexcon_mixed_flexcon_members
  where source_flexcon_id = old.id;
  if v_allocated = 0 then return new; end if;

  if new.authorization_id is distinct from old.authorization_id
     or new.fiscal_year is distinct from old.fiscal_year
     or btrim(coalesce(new.brand, '')) is distinct from btrim(coalesce(old.brand, '')) then
    raise exception '混在フレコンで使用中のため、生産者・年度・銘柄は変更できません。';
  end if;
  if new.quantity_kg < v_allocated then
    raise exception '混在フレコンで合計%kg使用しているため、それ未満の数量には変更できません。', v_allocated;
  end if;
  select weight_kg into v_expected_weight
  from public.flexcon_inspection_weights
  where weight_type = 'branded_rice';
  if new.quantity_kg >= v_expected_weight then
    raise exception '混在フレコンで使用中の元記録は、量目初期値未満にしてください。';
  end if;
  return new;
end;
$$;

drop trigger if exists flexcon_guard_mixed_source_record_trigger
  on public.flexcon_inspection_flexcons;
create trigger flexcon_guard_mixed_source_record_trigger
before update of authorization_id, fiscal_year, brand, quantity_kg
on public.flexcon_inspection_flexcons
for each row execute function public.flexcon_guard_mixed_source_record();

create or replace function public.flexcon_add_mixed_flexcon(
  p_worker_id text,
  p_fiscal_year integer,
  p_origin_prefecture text,
  p_brand text,
  p_quantity_kg integer,
  p_notes text,
  p_members jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mixed_no integer;
  v_lot_number text;
  v_id uuid;
  v_member jsonb;
  v_member_count integer;
  v_member_total integer;
  v_expected_weight integer;
  v_authorization_id uuid;
  v_source_flexcon_id uuid;
  v_member_quantity integer;
  v_purchase_date date;
  v_sort_order integer := 0;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if p_fiscal_year is null or p_fiscal_year not between 1 and 99 then
    raise exception '年度は1から99の整数で入力してください。';
  end if;
  if char_length(btrim(coalesce(p_origin_prefecture, ''))) = 0 then
    raise exception '産地を選択してください。';
  end if;
  if char_length(btrim(coalesce(p_brand, ''))) = 0 then
    raise exception '銘柄を選択してください。';
  end if;
  if btrim(p_brand) = '飼料用玄米' then
    raise exception '飼料用玄米は混在フレコンに登録できません。';
  end if;

  select weight_kg into v_expected_weight
  from public.flexcon_inspection_weights
  where weight_type = 'branded_rice';
  if v_expected_weight is null or p_quantity_kg is distinct from v_expected_weight then
    raise exception '混在フレコンの合計を量目初期値%kgに合わせてください。', coalesce(v_expected_weight, 0);
  end if;
  if jsonb_typeof(p_members) is distinct from 'array' then
    raise exception '検査記録の内訳が正しくありません。';
  end if;

  select count(*) into v_member_count from jsonb_array_elements(p_members);
  if v_member_count < 2 then raise exception '生産者を2名以上登録してください。'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_members) as member
    where coalesce(member->>'authorization_id', '') !~ '^[0-9a-fA-F-]{36}$'
       or coalesce(member->>'source_flexcon_id', '') !~ '^[0-9a-fA-F-]{36}$'
       or coalesce(member->>'quantity_kg', '') !~ '^[1-9][0-9]*$'
  ) then raise exception '検査記録の内訳が正しくありません。'; end if;
  if (select count(distinct member->>'authorization_id') from jsonb_array_elements(p_members) as member) <> v_member_count then
    raise exception '同じ生産者が重複しています。';
  end if;
  if (select count(distinct member->>'source_flexcon_id') from jsonb_array_elements(p_members) as member) <> v_member_count then
    raise exception '同じ検査記録が重複しています。';
  end if;

  perform source_flexcon.id
  from public.flexcon_inspection_flexcons as source_flexcon
  where source_flexcon.id in (
    select (member->>'source_flexcon_id')::uuid
    from jsonb_array_elements(p_members) as member
  )
  for update;

  select sum((member->>'quantity_kg')::integer) into v_member_total
  from jsonb_array_elements(p_members) as member;
  if v_member_total <> v_expected_weight then
    raise exception '使用数量の合計を量目初期値%kgに合わせてください。', v_expected_weight;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_members) as member
    left join public.flexcon_authorizations as auth_record
      on auth_record.id = (member->>'authorization_id')::uuid
    left join public.flexcon_inspection_flexcons as source_flexcon
      on source_flexcon.id = (member->>'source_flexcon_id')::uuid
     and source_flexcon.authorization_id = auth_record.id
    where auth_record.id is null
       or source_flexcon.id is null
       or source_flexcon.fiscal_year <> p_fiscal_year
       or btrim(coalesce(source_flexcon.brand, '')) <> btrim(p_brand)
       or btrim(coalesce(source_flexcon.brand, '')) = '飼料用玄米'
       or source_flexcon.quantity_kg >= v_expected_weight
       or regexp_replace(btrim(coalesce(auth_record.prefecture, '')), '[都道府県]$', '')
          <> regexp_replace(btrim(p_origin_prefecture), '[都道府県]$', '')
       or coalesce((
         select sum(existing_member.quantity_kg)
         from public.flexcon_mixed_flexcon_members as existing_member
         where existing_member.source_flexcon_id = source_flexcon.id
       ), 0) + (member->>'quantity_kg')::integer > source_flexcon.quantity_kg
  ) then
    raise exception '元の検査記録の未使用数量を超えているか、条件に合わない記録が含まれています。';
  end if;

  select source_flexcon.purchase_date into v_purchase_date
  from jsonb_array_elements(p_members) with ordinality as selected_member(value, position)
  join public.flexcon_inspection_flexcons as source_flexcon
    on source_flexcon.id = (selected_member.value->>'source_flexcon_id')::uuid
  order by selected_member.position
  limit 1;

  perform pg_advisory_xact_lock(hashtext('flexcon_mixed_flexcons_mixed_no'));
  select coalesce(max(mixed_no), 0) + 1 into v_mixed_no from public.flexcon_mixed_flexcons;
  if v_mixed_no > 4999 then raise exception '混在フレコン№が上限に達しました。'; end if;
  v_lot_number := lpad((p_fiscal_year + 2018)::text, 4, '0')
    || lpad((v_mixed_no + 5000)::text, 4, '0') || '001';

  insert into public.flexcon_mixed_flexcons (
    mixed_no, fiscal_year, origin_prefecture, brand, quantity_kg, lot_number,
    purchase_date, notes, created_by_worker_id, updated_by_worker_id
  ) values (
    v_mixed_no, p_fiscal_year, btrim(p_origin_prefecture), btrim(p_brand),
    v_expected_weight, v_lot_number, v_purchase_date, nullif(btrim(p_notes), ''),
    p_worker_id, p_worker_id
  ) returning id into v_id;

  for v_member in select value from jsonb_array_elements(p_members) loop
    v_authorization_id := (v_member->>'authorization_id')::uuid;
    v_source_flexcon_id := (v_member->>'source_flexcon_id')::uuid;
    v_member_quantity := (v_member->>'quantity_kg')::integer;
    insert into public.flexcon_mixed_flexcon_members (
      mixed_flexcon_id, authorization_id, source_flexcon_id, quantity_kg, sort_order
    ) values (v_id, v_authorization_id, v_source_flexcon_id, v_member_quantity, v_sort_order);
    v_sort_order := v_sort_order + 1;
  end loop;

  insert into public.flexcon_flexcons (lot_number) values (v_lot_number)
  on conflict (lot_number) do nothing;
  return jsonb_build_object('id', v_id, 'mixed_no', v_mixed_no, 'lot_number', v_lot_number);
end;
$$;

create or replace function public.flexcon_update_mixed_flexcon_members(
  p_worker_id text,
  p_mixed_flexcon_id uuid,
  p_members jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member jsonb;
  v_member_count integer;
  v_expected_weight integer;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  if not exists (select 1 from public.flexcon_mixed_flexcons where id = p_mixed_flexcon_id) then
    raise exception '混在フレコンが見つかりません。';
  end if;
  if jsonb_typeof(p_members) is distinct from 'array' then
    raise exception '使用数量が正しくありません。';
  end if;

  select count(*) into v_member_count
  from public.flexcon_mixed_flexcon_members
  where mixed_flexcon_id = p_mixed_flexcon_id;
  if v_member_count <> (select count(*) from jsonb_array_elements(p_members))
     or v_member_count <> (select count(distinct member->>'member_id') from jsonb_array_elements(p_members) as member) then
    raise exception '登録済みの生産者全員の使用数量を指定してください。';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_members) as member
    where coalesce(member->>'member_id', '') !~ '^[0-9a-fA-F-]{36}$'
       or coalesce(member->>'quantity_kg', '') !~ '^[1-9][0-9]*$'
  ) then raise exception '使用数量は1kg以上の整数で入力してください。'; end if;

  perform source_flexcon.id
  from public.flexcon_inspection_flexcons as source_flexcon
  join public.flexcon_mixed_flexcon_members as stored_member
    on stored_member.source_flexcon_id = source_flexcon.id
  where stored_member.mixed_flexcon_id = p_mixed_flexcon_id
  for update;

  select weight_kg into v_expected_weight
  from public.flexcon_inspection_weights
  where weight_type = 'branded_rice';
  if v_expected_weight is null then raise exception '銘柄米の量目初期値が登録されていません。'; end if;
  if (select sum((member->>'quantity_kg')::integer) from jsonb_array_elements(p_members) as member) <> v_expected_weight then
    raise exception '使用数量の合計を量目初期値%kgに合わせてください。', v_expected_weight;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_members) as input_member
    left join public.flexcon_mixed_flexcon_members as stored_member
      on stored_member.id = (input_member->>'member_id')::uuid
     and stored_member.mixed_flexcon_id = p_mixed_flexcon_id
    left join public.flexcon_inspection_flexcons as source_flexcon
      on source_flexcon.id = stored_member.source_flexcon_id
    where stored_member.id is null
       or source_flexcon.id is null
       or coalesce((
         select sum(other_member.quantity_kg)
         from public.flexcon_mixed_flexcon_members as other_member
         where other_member.source_flexcon_id = source_flexcon.id
           and other_member.mixed_flexcon_id <> p_mixed_flexcon_id
       ), 0) + (input_member->>'quantity_kg')::integer > source_flexcon.quantity_kg
  ) then raise exception '元の検査記録の未使用数量を超えている行があります。'; end if;

  for v_member in select value from jsonb_array_elements(p_members) loop
    update public.flexcon_mixed_flexcon_members
    set quantity_kg = (v_member->>'quantity_kg')::integer
    where id = (v_member->>'member_id')::uuid
      and mixed_flexcon_id = p_mixed_flexcon_id;
  end loop;
  update public.flexcon_mixed_flexcons
  set updated_by_worker_id = p_worker_id, updated_at = now()
  where id = p_mixed_flexcon_id;
  return p_mixed_flexcon_id;
end;
$$;

create or replace function public.flexcon_delete_mixed_flexcon(
  p_worker_id text,
  p_mixed_flexcon_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lot_number text;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  select lot_number into v_lot_number
  from public.flexcon_mixed_flexcons
  where id = p_mixed_flexcon_id;
  if v_lot_number is null then raise exception '混在フレコンが見つかりません。'; end if;
  if exists (select 1 from public.flexcon_shipment_items where lot_number = v_lot_number) then
    raise exception '出荷履歴で使用されているため削除できません。';
  end if;
  delete from public.flexcon_mixed_flexcons where id = p_mixed_flexcon_id;
  delete from public.flexcon_flexcons where lot_number = v_lot_number;
  return p_mixed_flexcon_id;
end;
$$;

revoke all on function public.flexcon_add_mixed_flexcon(text, integer, text, text, integer, text, jsonb) from public;
revoke all on function public.flexcon_update_mixed_flexcon_members(text, uuid, jsonb) from public;
revoke all on function public.flexcon_delete_mixed_flexcon(text, uuid) from public;
grant execute on function public.flexcon_add_mixed_flexcon(text, integer, text, text, integer, text, jsonb) to anon, authenticated;
grant execute on function public.flexcon_update_mixed_flexcon_members(text, uuid, jsonb) to anon, authenticated;
grant execute on function public.flexcon_delete_mixed_flexcon(text, uuid) to anon, authenticated;

commit;
