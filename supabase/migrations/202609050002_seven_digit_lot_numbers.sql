-- QRロット番号を「委任状№4桁＋フレコン№3桁」の7桁へ変更します。
-- 過去に出荷した6桁ロットは履歴として残し、引き続き読み取り可能にします。

begin;

alter table public.flexcon_flexcons
  drop constraint if exists flexcon_flexcons_lot_number_check;
alter table public.flexcon_flexcons
  add constraint flexcon_flexcons_lot_number_check
  check (lot_number ~ '^[0-9]{6,7}$');

alter table public.flexcon_shipment_items
  drop constraint if exists flexcon_shipment_items_lot_number_check;
alter table public.flexcon_shipment_items
  add constraint flexcon_shipment_items_lot_number_check
  check (lot_number ~ '^[0-9]{6,7}$');

alter table public.flexcon_inspection_flexcons
  drop constraint if exists flexcon_inspection_flexcons_lot_number_check;
alter table public.flexcon_inspection_flexcons
  add constraint flexcon_inspection_flexcons_lot_number_check
  check (lot_number ~ '^[0-9]{6,7}$');

-- 登録済み検査記録も、次回の証明書作成時から7桁QRになるよう変換します。
update public.flexcon_inspection_flexcons
set lot_number = '0' || lot_number,
    updated_at = now()
where lot_number ~ '^[0-9]{6}$';

alter table public.flexcon_inspection_flexcons
  drop constraint flexcon_inspection_flexcons_lot_number_check;
alter table public.flexcon_inspection_flexcons
  add constraint flexcon_inspection_flexcons_lot_number_check
  check (lot_number ~ '^[0-9]{7}$');

do $migration$
declare
  v_signature text;
  v_oid regprocedure;
  v_definition text;
  v_updated_definition text;
begin
  foreach v_signature in array array[
    'public.flexcon_add_inspection_group(text,uuid,integer,date,date,text,text,integer,integer,integer)',
    'public.flexcon_save_inspection_flexcon(text,uuid,uuid,integer,date,date,text,integer,text,integer,text,text,numeric)'
  ] loop
    v_oid := to_regprocedure(v_signature);
    if v_oid is null then
      raise exception '必要な検査記録関数が見つかりません: %', v_signature;
    end if;

    select pg_get_functiondef(v_oid::oid) into v_definition;
    v_updated_definition := replace(v_definition, '''^[0-9]{1,3}$''', '''^[0-9]{1,4}$''');
    v_updated_definition := replace(v_updated_definition, '委任状№は3桁以内の数字にしてください。', '委任状№は4桁以内の数字にしてください。');
    v_updated_definition := replace(v_updated_definition, 'lpad(v_authorization_no, 3, ''0'')', 'lpad(v_authorization_no, 4, ''0'')');

    if v_updated_definition = v_definition then
      raise exception '検査記録関数を7桁用へ変更できませんでした: %', v_signature;
    end if;
    execute v_updated_definition;
  end loop;
end;
$migration$;

do $migration$
declare
  v_signature text := 'public.flexcon_register_shipment(text,uuid,uuid,timestamp with time zone,text,text,text[],text)';
  v_oid regprocedure;
  v_definition text;
  v_updated_definition text;
begin
  v_oid := to_regprocedure(v_signature);
  if v_oid is null then
    raise exception '出荷登録関数が見つかりません。';
  end if;

  select pg_get_functiondef(v_oid::oid) into v_definition;
  v_updated_definition := replace(v_definition, '''^[0-9]{6}$''', '''^[0-9]{6,7}$''');
  v_updated_definition := replace(v_updated_definition, '6桁ではないロット番号が含まれています。', '6桁または7桁ではないロット番号が含まれています。');

  if v_updated_definition = v_definition then
    raise exception '出荷登録関数を7桁対応へ変更できませんでした。';
  end if;
  execute v_updated_definition;
end;
$migration$;

commit;
