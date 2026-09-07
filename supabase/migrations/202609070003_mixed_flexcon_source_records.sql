-- 混在フレコンは、量目初期値未満の銘柄米フレコン検査記録だけを組み合わせます。
-- 202609070002_mixed_flexcons.sql の実行後に適用してください。

begin;

alter table public.flexcon_mixed_flexcon_members
  add column if not exists source_flexcon_id uuid
    references public.flexcon_inspection_flexcons(id) on delete restrict;

create unique index if not exists flexcon_mixed_members_source_flexcon_idx
  on public.flexcon_mixed_flexcon_members (source_flexcon_id)
  where source_flexcon_id is not null;

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

  select inspection_weight.weight_kg
  into v_expected_weight
  from public.flexcon_inspection_weights as inspection_weight
  where inspection_weight.weight_type = 'branded_rice';

  if v_expected_weight is null or p_quantity_kg is distinct from v_expected_weight then
    raise exception '混在フレコンの合計を量目初期値%kgに合わせてください。', coalesce(v_expected_weight, 0);
  end if;
  if jsonb_typeof(p_members) is distinct from 'array' then
    raise exception '検査記録の内訳が正しくありません。';
  end if;

  select count(*) into v_member_count from jsonb_array_elements(p_members);
  if v_member_count < 2 then
    raise exception '生産者を2名以上登録してください。';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_members) as member
    where coalesce(member->>'authorization_id', '') !~ '^[0-9a-fA-F-]{36}$'
       or coalesce(member->>'source_flexcon_id', '') !~ '^[0-9a-fA-F-]{36}$'
       or coalesce(member->>'quantity_kg', '') !~ '^[1-9][0-9]*$'
  ) then
    raise exception '検査記録の内訳が正しくありません。';
  end if;
  if (
    select count(distinct member->>'authorization_id')
    from jsonb_array_elements(p_members) as member
  ) <> v_member_count then
    raise exception '同じ生産者が重複しています。';
  end if;
  if (
    select count(distinct member->>'source_flexcon_id')
    from jsonb_array_elements(p_members) as member
  ) <> v_member_count then
    raise exception '同じ検査記録が重複しています。';
  end if;

  select sum((member->>'quantity_kg')::integer)
  into v_member_total
  from jsonb_array_elements(p_members) as member;
  if v_member_total <> v_expected_weight then
    raise exception '検査記録の数量合計を量目初期値%kgに合わせてください。', v_expected_weight;
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
       or source_flexcon.quantity_kg <> (member->>'quantity_kg')::integer
       or regexp_replace(btrim(coalesce(auth_record.prefecture, '')), '[都道府県]$', '')
          <> regexp_replace(btrim(p_origin_prefecture), '[都道府県]$', '')
  ) then
    raise exception '量目初期値未満の同一年度・産地・銘柄の検査記録だけを選択してください。';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_members) as member
    join public.flexcon_mixed_flexcon_members as existing_member
      on existing_member.source_flexcon_id = (member->>'source_flexcon_id')::uuid
  ) then
    raise exception '選択した検査記録は既に混在フレコンへ登録されています。';
  end if;

  perform pg_advisory_xact_lock(hashtext('flexcon_mixed_flexcons_mixed_no'));
  select coalesce(max(mixed_no), 0) + 1 into v_mixed_no
  from public.flexcon_mixed_flexcons;
  if v_mixed_no > 4999 then
    raise exception '混在フレコン№が上限に達しました。';
  end if;

  v_lot_number := lpad((p_fiscal_year + 2018)::text, 4, '0')
    || lpad((v_mixed_no + 5000)::text, 4, '0') || '001';

  insert into public.flexcon_mixed_flexcons (
    mixed_no, fiscal_year, origin_prefecture, brand, quantity_kg, lot_number, notes,
    created_by_worker_id, updated_by_worker_id
  ) values (
    v_mixed_no, p_fiscal_year, btrim(p_origin_prefecture), btrim(p_brand),
    v_expected_weight, v_lot_number, nullif(btrim(p_notes), ''), p_worker_id, p_worker_id
  ) returning id into v_id;

  for v_member in select value from jsonb_array_elements(p_members) loop
    v_authorization_id := (v_member->>'authorization_id')::uuid;
    v_source_flexcon_id := (v_member->>'source_flexcon_id')::uuid;
    v_member_quantity := (v_member->>'quantity_kg')::integer;
    insert into public.flexcon_mixed_flexcon_members (
      mixed_flexcon_id, authorization_id, source_flexcon_id, quantity_kg, sort_order
    ) values (
      v_id, v_authorization_id, v_source_flexcon_id, v_member_quantity, v_sort_order
    );
    v_sort_order := v_sort_order + 1;
  end loop;

  insert into public.flexcon_flexcons (lot_number)
  values (v_lot_number)
  on conflict (lot_number) do nothing;

  return jsonb_build_object('id', v_id, 'mixed_no', v_mixed_no, 'lot_number', v_lot_number);
end;
$$;

revoke all on function public.flexcon_add_mixed_flexcon(text, integer, text, text, integer, text, jsonb) from public;
grant execute on function public.flexcon_add_mixed_flexcon(text, integer, text, text, integer, text, jsonb) to anon, authenticated;

commit;
