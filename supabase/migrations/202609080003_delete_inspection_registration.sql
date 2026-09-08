-- 検査記録一覧の登録No.単位で、推フレ・バラ・紙袋をまとめて削除します。
-- 出荷履歴に使用済みのロットを含む登録は削除しません。

begin;

create or replace function public.flexcon_delete_inspection_registration(
  p_worker_id text,
  p_registration_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_registration_no bigint;
  v_lot_numbers text[];
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select registration.registration_no
  into v_registration_no
  from public.flexcon_inspection_registrations as registration
  where registration.id = p_registration_id
  for update;

  if v_registration_no is null then
    raise exception '削除する検査記録が見つかりません。';
  end if;

  select coalesce(array_agg(flexcon.lot_number), '{}'::text[])
  into v_lot_numbers
  from public.flexcon_inspection_flexcons as flexcon
  where flexcon.registration_id = p_registration_id;

  if exists (
    select 1
    from public.flexcon_shipment_items as shipment_item
    cross join unnest(v_lot_numbers) as inspection_lot(lot_number)
    where shipment_item.lot_number = inspection_lot.lot_number
      or (
        char_length(inspection_lot.lot_number) = 11
        and shipment_item.lot_number = right(inspection_lot.lot_number, 7)
      )
      or (
        char_length(inspection_lot.lot_number) = 11
        and left(right(inspection_lot.lot_number, 7), 1) = '0'
        and shipment_item.lot_number = right(inspection_lot.lot_number, 6)
      )
      or (
        char_length(shipment_item.lot_number) = 11
        and inspection_lot.lot_number = right(shipment_item.lot_number, 7)
      )
  ) then
    raise exception '出荷履歴で使用されているフレコンを含むため削除できません。';
  end if;

  delete from public.flexcon_inspection_registrations
  where id = p_registration_id;

  delete from public.flexcon_flexcons as flexcon
  where flexcon.lot_number = any(v_lot_numbers);
end;
$$;

revoke all on function public.flexcon_delete_inspection_registration(text, uuid) from public;
grant execute on function public.flexcon_delete_inspection_registration(text, uuid) to anon, authenticated;

commit;
