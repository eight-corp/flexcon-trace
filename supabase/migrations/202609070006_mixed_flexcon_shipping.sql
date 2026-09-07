begin;

-- 委任状№の領域が5001以上の11桁ロットは混在フレコン専用です。
-- QRの誤読や手入力で、存在しない混在フレコンを出荷登録しないようにします。
create or replace function public.flexcon_validate_mixed_shipment_lot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.lot_number ~ '^[0-9]{11}$'
     and substring(new.lot_number from 5 for 4)::integer between 5001 and 9999
     and not exists (
       select 1
       from public.flexcon_mixed_flexcons as mixed
       where mixed.lot_number = new.lot_number
     ) then
    raise exception '混在フレコンのロット番号が見つかりません。混在フレコン一覧を確認してください。';
  end if;

  return new;
end;
$$;

drop trigger if exists flexcon_validate_mixed_shipment_lot
  on public.flexcon_shipment_items;
create trigger flexcon_validate_mixed_shipment_lot
before insert or update of lot_number on public.flexcon_shipment_items
for each row execute function public.flexcon_validate_mixed_shipment_lot();

revoke all on function public.flexcon_validate_mixed_shipment_lot() from public;

commit;
