-- Excelの委任状一覧を一括追加・更新するRPCを追加します。
-- 202609020004_authorizations.sql の実行後に適用してください。

create or replace function public.flexcon_import_authorizations(
  p_worker_id text,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_record jsonb;
  v_authorization_no text;
  v_full_name text;
  v_seed_supplied boolean;
  v_plan_supplied boolean;
  v_existed boolean;
  v_inserted integer := 0;
  v_updated integer := 0;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);

  if jsonb_typeof(p_records) <> 'array' then
    raise exception '取込データの形式が正しくありません。';
  end if;
  if jsonb_array_length(p_records) < 1 then
    raise exception '取込データがありません。';
  end if;
  if jsonb_array_length(p_records) > 1000 then
    raise exception '一度に取り込める件数は1000件までです。';
  end if;

  for v_record in select value from jsonb_array_elements(p_records)
  loop
    v_authorization_no := btrim(coalesce(v_record ->> 'authorization_no', ''));
    v_full_name := btrim(coalesce(v_record ->> 'full_name', ''));
    v_seed_supplied := jsonb_typeof(v_record -> 'seed_purchase_slip') = 'boolean';
    v_plan_supplied := jsonb_typeof(v_record -> 'farming_plan') = 'boolean';

    if char_length(v_authorization_no) not between 1 and 40 then
      raise exception '№を1文字から40文字で入力してください。';
    end if;
    if char_length(v_full_name) not between 1 and 120 then
      raise exception '№%の氏名を1文字から120文字で入力してください。', v_authorization_no;
    end if;

    select exists (
      select 1 from public.flexcon_authorizations
      where authorization_no = v_authorization_no
    ) into v_existed;

    insert into public.flexcon_authorizations (
      authorization_no,
      full_name,
      seed_purchase_slip,
      farming_plan,
      address,
      prefecture,
      municipality,
      phone,
      crop_type,
      feed_rice_variety,
      notes,
      created_by_worker_id
    ) values (
      v_authorization_no,
      v_full_name,
      case when v_seed_supplied then (v_record ->> 'seed_purchase_slip')::boolean else false end,
      case when v_plan_supplied then (v_record ->> 'farming_plan')::boolean else false end,
      nullif(btrim(v_record ->> 'address'), ''),
      nullif(btrim(v_record ->> 'prefecture'), ''),
      nullif(btrim(v_record ->> 'municipality'), ''),
      nullif(btrim(v_record ->> 'phone'), ''),
      nullif(btrim(v_record ->> 'crop_type'), ''),
      nullif(btrim(v_record ->> 'feed_rice_variety'), ''),
      nullif(btrim(v_record ->> 'notes'), ''),
      v_worker.worker_id
    )
    on conflict (authorization_no) do update
    set full_name = excluded.full_name,
        seed_purchase_slip = case
          when v_seed_supplied then excluded.seed_purchase_slip
          else flexcon_authorizations.seed_purchase_slip
        end,
        farming_plan = case
          when v_plan_supplied then excluded.farming_plan
          else flexcon_authorizations.farming_plan
        end,
        address = excluded.address,
        prefecture = excluded.prefecture,
        municipality = excluded.municipality,
        phone = excluded.phone,
        crop_type = excluded.crop_type,
        feed_rice_variety = excluded.feed_rice_variety,
        notes = excluded.notes,
        updated_at = now();

    if v_existed then
      v_updated := v_updated + 1;
    else
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated);
end;
$$;

revoke all on function public.flexcon_import_authorizations(text, jsonb) from public;
grant execute on function public.flexcon_import_authorizations(text, jsonb) to anon, authenticated;
