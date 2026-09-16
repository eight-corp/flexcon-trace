-- 仕切り書ごとの入庫先指定と、取込明細の編集・削除を追加します。

begin;

drop function if exists public.flexcon_import_purchase_statements(text, text, uuid, jsonb);

create function public.flexcon_import_purchase_statements(
  p_worker_id text,
  p_file_name text,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_batch_id uuid;
  v_record jsonb;
  v_settlement_count integer;
  v_line_count integer;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if nullif(btrim(coalesce(p_file_name, '')), '') is null then raise exception 'ファイル名を確認できません。'; end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) = 0 then raise exception '取込対象がありません。'; end if;

  for v_record in select value from jsonb_array_elements(p_records)
  loop
    if nullif(btrim(v_record->>'settlement_no'), '') is null then raise exception '仕切り書№が空欄の明細があります。'; end if;
    if coalesce((v_record->>'detail_no')::integer, 0) <= 0 or coalesce((v_record->>'part_no')::integer, 0) <= 0 then raise exception '仕切り書の明細番号が不正です。'; end if;
    if coalesce((v_record->>'quantity')::numeric, 0) <= 0 then raise exception '数量が不正な明細があります。'; end if;
    if (v_record->>'unit') not in ('本', '袋', 'kg', '俵') then raise exception '単位が不正な明細があります。'; end if;
    if not exists (
      select 1 from public.flexcon_inspection_options
      where id = (v_record->>'to_warehouse_id')::uuid and option_type = 'warehouse' and active = true
    ) then raise exception '仕切り書№%の入庫先倉庫を選択してください。', v_record->>'settlement_no'; end if;
    if not exists (
      select 1 from public.flexcon_inspection_options
      where option_type = 'origin' and active = true and name = v_record->>'origin'
    ) then raise exception '産地「%」がマスタにありません。', v_record->>'origin'; end if;
    if not exists (
      select 1 from public.flexcon_inspection_options
      where active = true and name = v_record->>'product_name'
        and (
          option_type = 'shipment_product'
          or ((v_record->>'origin') = '青森県' and option_type in ('brand', 'brand_aomori'))
          or ((v_record->>'origin') = '岩手県' and option_type = 'brand_iwate')
        )
    ) then raise exception '名称「%」がマスタにありません。', v_record->>'product_name'; end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(p_records) as record
    group by record.value->>'settlement_no'
    having count(distinct record.value->>'to_warehouse_id') > 1
  ) then raise exception '同じ仕切り書№には同じ入庫先倉庫を指定してください。'; end if;

  perform pg_advisory_xact_lock(hashtextextended(settlement_no, 0))
  from (
    select distinct value->>'settlement_no' as settlement_no
    from jsonb_array_elements(p_records)
  ) as locks
  order by hashtextextended(settlement_no, 0);

  insert into public.flexcon_purchase_import_batches (file_name, imported_by_worker_id, imported_by_worker_name)
  values (left(btrim(p_file_name), 255), v_worker.worker_id, v_worker.worker_name)
  returning id into v_batch_id;

  delete from public.flexcon_purchase_statement_lines
  where settlement_no in (select distinct value->>'settlement_no' from jsonb_array_elements(p_records));

  insert into public.flexcon_purchase_statement_lines (
    batch_id, settlement_no, detail_no, part_no, source_import_id, crop_year, purchased_at,
    origin, raw_product_name, product_name, producer_name, raw_quantity, raw_unit,
    grade, quantity, unit, to_warehouse_id, to_warehouse_name
  )
  select
    v_batch_id,
    btrim(record.value->>'settlement_no'),
    (record.value->>'detail_no')::integer,
    (record.value->>'part_no')::integer,
    nullif(btrim(record.value->>'source_import_id'), ''),
    nullif(record.value->>'crop_year', '')::integer,
    (record.value->>'purchased_at')::timestamptz,
    btrim(record.value->>'origin'),
    btrim(record.value->>'raw_product_name'),
    btrim(record.value->>'product_name'),
    btrim(record.value->>'producer_name'),
    (record.value->>'raw_quantity')::numeric,
    btrim(record.value->>'raw_unit'),
    coalesce(nullif(btrim(record.value->>'grade'), ''), '未検査'),
    (record.value->>'quantity')::numeric,
    btrim(record.value->>'unit'),
    warehouse.id,
    warehouse.name
  from jsonb_array_elements(p_records) as record
  join public.flexcon_inspection_options as warehouse
    on warehouse.id = (record.value->>'to_warehouse_id')::uuid
   and warehouse.option_type = 'warehouse'
   and warehouse.active = true;

  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception '取込後の在庫がマイナスになるため登録できません。既存の出庫・移動記録を確認してください。';
  end if;

  select count(distinct value->>'settlement_no'), count(*)
  into v_settlement_count, v_line_count
  from jsonb_array_elements(p_records);
  return jsonb_build_object('batch_id', v_batch_id, 'settlement_count', v_settlement_count, 'line_count', v_line_count);
end;
$$;

create or replace function public.flexcon_update_purchase_statement_line(
  p_worker_id text,
  p_line_id uuid,
  p_movement_date date,
  p_settlement_no text,
  p_producer_name text,
  p_origin text,
  p_product_name text,
  p_quantity numeric,
  p_unit text,
  p_to_warehouse_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.flexcon_purchase_statement_lines%rowtype;
  v_settlement_no text := btrim(coalesce(p_settlement_no, ''));
  v_producer_name text := btrim(coalesce(p_producer_name, ''));
  v_origin text := btrim(coalesce(p_origin, ''));
  v_product_name text := btrim(coalesce(p_product_name, ''));
  v_unit text := btrim(coalesce(p_unit, ''));
  v_warehouse_name text;
  v_grade text;
  v_detail_no integer;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  select * into v_current from public.flexcon_purchase_statement_lines where id = p_line_id for update;
  if v_current.id is null then raise exception '仕切り書の在庫明細が見つかりません。'; end if;
  if p_movement_date is null then raise exception '日付を入力してください。'; end if;
  if nullif(v_settlement_no, '') is null then raise exception '仕切り書№を入力してください。'; end if;
  if nullif(v_producer_name, '') is null then raise exception '生産者名を入力してください。'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception '数量は0より大きい数値で入力してください。'; end if;
  if v_unit not in ('本', '袋', 'kg', '俵') then raise exception '単位を選択してください。'; end if;
  if not exists (
    select 1 from public.flexcon_inspection_options where option_type = 'origin' and active = true and name = v_origin
  ) then raise exception '産地をマスタから選択してください。'; end if;
  if not exists (
    select 1 from public.flexcon_inspection_options
    where active = true and name = v_product_name
      and (option_type = 'shipment_product'
        or (v_origin = '青森県' and option_type in ('brand', 'brand_aomori'))
        or (v_origin = '岩手県' and option_type = 'brand_iwate'))
  ) then raise exception '名称をマスタから選択してください。'; end if;
  select name into v_warehouse_name from public.flexcon_inspection_options
  where id = p_to_warehouse_id and option_type = 'warehouse' and active = true;
  if v_warehouse_name is null then raise exception '入庫先倉庫を選択してください。'; end if;

  select case when exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'shipment_product' and active = true and name = v_product_name
  ) then '対象外' else '未検査' end into v_grade;

  if v_settlement_no = v_current.settlement_no then
    v_detail_no := v_current.detail_no;
  else
    perform pg_advisory_xact_lock(hashtextextended(v_settlement_no, 0));
    select coalesce(max(detail_no), 0) + 1 into v_detail_no
    from public.flexcon_purchase_statement_lines where settlement_no = v_settlement_no;
  end if;

  update public.flexcon_purchase_statement_lines
  set settlement_no = v_settlement_no,
      detail_no = v_detail_no,
      part_no = case when v_settlement_no = v_current.settlement_no then part_no else 1 end,
      purchased_at = p_movement_date::timestamp at time zone 'Asia/Tokyo',
      producer_name = v_producer_name,
      origin = v_origin,
      product_name = v_product_name,
      grade = v_grade,
      quantity = round(p_quantity, 3),
      unit = v_unit,
      to_warehouse_id = p_to_warehouse_id,
      to_warehouse_name = v_warehouse_name
  where id = p_line_id;

  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception 'この変更を保存すると倉庫在庫が不足するため、編集できません。';
  end if;
end;
$$;

create or replace function public.flexcon_delete_purchase_statement_line(
  p_worker_id text,
  p_line_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  if not exists (select 1 from public.flexcon_purchase_statement_lines where id = p_line_id) then
    raise exception '仕切り書の在庫明細が見つかりません。';
  end if;
  delete from public.flexcon_purchase_statement_lines where id = p_line_id;
  if exists (select 1 from public.flexcon_inventory_balances where quantity < 0) then
    raise exception 'この明細を削除すると倉庫在庫が不足するため、削除できません。先に後続の出庫・移動記録を修正してください。';
  end if;
end;
$$;

revoke all on function public.flexcon_import_purchase_statements(text, text, jsonb) from public;
revoke all on function public.flexcon_update_purchase_statement_line(text, uuid, date, text, text, text, text, numeric, text, uuid) from public;
revoke all on function public.flexcon_delete_purchase_statement_line(text, uuid) from public;
grant execute on function public.flexcon_import_purchase_statements(text, text, jsonb) to anon, authenticated;
grant execute on function public.flexcon_update_purchase_statement_line(text, uuid, date, text, text, text, text, numeric, text, uuid) to anon, authenticated;
grant execute on function public.flexcon_delete_purchase_statement_line(text, uuid) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
