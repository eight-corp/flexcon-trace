-- QRロット番号を「西暦4桁＋委任状№4桁＋フレコン№3桁」の11桁へ変更します。
-- 検査記録の年度は令和年で保存されているため、西暦は年度＋2018で作成します。
-- 過去に出荷した6桁・7桁ロットは履歴として残し、引き続き読み取り可能にします。

begin;

alter table public.flexcon_flexcons
  drop constraint if exists flexcon_flexcons_lot_number_check;
alter table public.flexcon_flexcons
  add constraint flexcon_flexcons_lot_number_check
  check (lot_number ~ '^([0-9]{6}|[0-9]{7}|[0-9]{11})$');

alter table public.flexcon_shipment_items
  drop constraint if exists flexcon_shipment_items_lot_number_check;
alter table public.flexcon_shipment_items
  add constraint flexcon_shipment_items_lot_number_check
  check (lot_number ~ '^([0-9]{6}|[0-9]{7}|[0-9]{11})$');

alter table public.flexcon_inspection_flexcons
  drop constraint if exists flexcon_inspection_flexcons_lot_number_check;
alter table public.flexcon_inspection_flexcons
  add constraint flexcon_inspection_flexcons_lot_number_check
  check (lot_number ~ '^([0-9]{6}|[0-9]{7}|[0-9]{11})$');

do $migration$
begin
  if exists (
    select 1
    from public.flexcon_inspection_flexcons as flexcon
    join public.flexcon_authorizations as auth_record on auth_record.id = flexcon.authorization_id
    where auth_record.authorization_no !~ '^[0-9]{1,4}$'
  ) then
    raise exception '4桁以内の数字ではない委任状№を含む検査記録があります。';
  end if;
end;
$migration$;

-- 登録済み検査記録は、保存されている年度・委任状№・フレコン№から再作成します。
update public.flexcon_inspection_flexcons as flexcon
set lot_number = lpad((flexcon.fiscal_year + 2018)::text, 4, '0')
    || lpad(auth_record.authorization_no, 4, '0')
    || lpad(flexcon.flexcon_no::text, 3, '0'),
    updated_at = now()
from public.flexcon_authorizations as auth_record
where auth_record.id = flexcon.authorization_id;

alter table public.flexcon_inspection_flexcons
  drop constraint flexcon_inspection_flexcons_lot_number_check;
alter table public.flexcon_inspection_flexcons
  add constraint flexcon_inspection_flexcons_lot_number_check
  check (lot_number ~ '^[0-9]{11}$');

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

    if position('p_fiscal_year + 2018' in v_updated_definition) = 0 then
      v_updated_definition := replace(
        v_updated_definition,
        'v_lot_number := lpad(v_authorization_no, 4, ''0'')',
        'v_lot_number := lpad((p_fiscal_year + 2018)::text, 4, ''0'') || lpad(v_authorization_no, 4, ''0'')'
      );
    end if;

    if position('p_fiscal_year + 2018' in v_updated_definition) = 0 then
      raise exception '検査記録関数を11桁用へ変更できませんでした: %', v_signature;
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
  v_updated_definition := replace(v_definition, '''^[0-9]{6}$''', '''^([0-9]{6}|[0-9]{7}|[0-9]{11})$''');
  v_updated_definition := replace(v_updated_definition, '''^[0-9]{6,7}$''', '''^([0-9]{6}|[0-9]{7}|[0-9]{11})$''');
  v_updated_definition := replace(v_updated_definition, '6桁ではないロット番号が含まれています。', '6桁・7桁・11桁以外のロット番号が含まれています。');
  v_updated_definition := replace(v_updated_definition, '6桁または7桁ではないロット番号が含まれています。', '6桁・7桁・11桁以外のロット番号が含まれています。');

  if position('[0-9]{11}' in v_updated_definition) = 0 then
    raise exception '出荷登録関数を11桁対応へ変更できませんでした。';
  end if;
  execute v_updated_definition;
end;
$migration$;

commit;
