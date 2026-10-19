begin;

create or replace function public._flexcon_undo_impl_delete_summary_group(
  p_worker_id text, p_registration_id uuid, p_inspection_date date,
  p_brand text, p_record_kind text, p_flexcon_ids uuid[], p_paper_bag_ids uuid[]
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_registration public.flexcon_inspection_registrations%rowtype;
  v_flexcon_ids uuid[] := '{}';
  v_paper_ids uuid[] := '{}';
  v_lot_numbers text[] := '{}';
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  if p_record_kind is null or p_record_kind not in ('standard', 'bulk', 'paper') or p_brand is null then
    raise exception '削除する銘柄・種類が不正です。一覧を再読込してください。';
  end if;
  select * into v_registration from public.flexcon_inspection_registrations where id = p_registration_id for update;
  if not found then raise exception '削除する検査記録が見つかりません。一覧を再読込してください。'; end if;

  -- Verify the complete visible group, never a client-supplied arbitrary subset.
  if p_record_kind = 'paper' then
    perform 1 from public.flexcon_inspection_paper_bags
      where registration_id = p_registration_id and inspection_date is not distinct from p_inspection_date
        and btrim(coalesce(brand, '')) = btrim(p_brand) order by id for update;
    select coalesce(array_agg(id order by id), '{}'::uuid[]) into v_paper_ids
      from public.flexcon_inspection_paper_bags
      where registration_id = p_registration_id and inspection_date is not distinct from p_inspection_date
        and btrim(coalesce(brand, '')) = btrim(p_brand);
  else
    perform 1 from public.flexcon_inspection_flexcons
      where registration_id = p_registration_id and inspection_date is not distinct from p_inspection_date
        and btrim(coalesce(brand, '')) = btrim(p_brand) and record_kind = p_record_kind order by id for update;
    select coalesce(array_agg(id order by id), '{}'::uuid[]), coalesce(array_agg(lot_number), '{}'::text[])
      into v_flexcon_ids, v_lot_numbers from public.flexcon_inspection_flexcons
      where registration_id = p_registration_id and inspection_date is not distinct from p_inspection_date
        and btrim(coalesce(brand, '')) = btrim(p_brand) and record_kind = p_record_kind;
  end if;
  if p_flexcon_ids is null or p_paper_bag_ids is null
    or cardinality(v_flexcon_ids) + cardinality(v_paper_ids) = 0
    or v_flexcon_ids <> array(select id from unnest(p_flexcon_ids) id order by id)
    or v_paper_ids <> array(select id from unnest(p_paper_bag_ids) id order by id) then
    raise exception '対象行の明細が変更されています。一覧を再読込してから削除してください。';
  end if;

  if exists (
    select 1 from public.flexcon_shipment_items shipment_item
    cross join unnest(v_lot_numbers) inspection_lot(lot_number)
    where shipment_item.lot_number = inspection_lot.lot_number
      or (char_length(inspection_lot.lot_number) = 11 and shipment_item.lot_number = right(inspection_lot.lot_number, 7))
      or (char_length(inspection_lot.lot_number) = 11 and left(right(inspection_lot.lot_number, 7), 1) = '0'
        and shipment_item.lot_number = right(inspection_lot.lot_number, 6))
      or (char_length(shipment_item.lot_number) = 11 and inspection_lot.lot_number = right(shipment_item.lot_number, 7))
  ) then raise exception '出荷履歴で使用されているフレコンを含むため、この行は削除できません。'; end if;

  insert into public.flexcon_inspection_deletion_archives(registration_id, inspection_date, deleted_by_worker_id, snapshot)
  values (p_registration_id, p_inspection_date, p_worker_id, jsonb_build_object(
    'registration', to_jsonb(v_registration), 'brand', btrim(p_brand), 'record_kind', p_record_kind,
    'flexcons', (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb)
      from public.flexcon_inspection_flexcons d where id = any(v_flexcon_ids)),
    'paper_bags', (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb)
      from public.flexcon_inspection_paper_bags d where id = any(v_paper_ids)),
    'lot_records', (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb)
      from public.flexcon_flexcons d where lot_number = any(v_lot_numbers))
  ));
  delete from public.flexcon_inspection_flexcons where id = any(v_flexcon_ids);
  delete from public.flexcon_inspection_paper_bags where id = any(v_paper_ids);
  delete from public.flexcon_flexcons where lot_number = any(v_lot_numbers)
    and not exists (select 1 from public.flexcon_inspection_flexcons remaining where remaining.lot_number = flexcon_flexcons.lot_number);
  delete from public.flexcon_inspection_registrations r where r.id = p_registration_id
    and not exists (select 1 from public.flexcon_inspection_flexcons d where d.registration_id = r.id)
    and not exists (select 1 from public.flexcon_inspection_paper_bags d where d.registration_id = r.id);
end; $$;
revoke all on function public._flexcon_undo_impl_delete_summary_group(text,uuid,date,text,text,uuid[],uuid[]) from public, anon, authenticated;

-- Keep the whole group deletion in one Undo operation, including on repeated deployments.
create or replace function public.flexcon_delete_inspection_summary_group(
  p_worker_id text, p_registration_id uuid, p_inspection_date date,
  p_brand text, p_record_kind text, p_flexcon_ids uuid[], p_paper_bag_ids uuid[]
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_root boolean;
begin
  v_root := flexcon_undo_private.prepare(p_worker_id, 'flexcon_delete_inspection_summary_group', 'rice_shipping');
  perform public._flexcon_undo_impl_delete_summary_group(p_worker_id,p_registration_id,p_inspection_date,p_brand,p_record_kind,p_flexcon_ids,p_paper_bag_ids);
  if v_root then perform flexcon_undo_private.finish(); end if;
end; $$;
revoke all on function public.flexcon_delete_inspection_summary_group(text,uuid,date,text,text,uuid[],uuid[]) from public;
grant execute on function public.flexcon_delete_inspection_summary_group(text,uuid,date,text,text,uuid[],uuid[]) to anon, authenticated;
insert into flexcon_undo_private.rpcs(function_name,argument_types,implementation_name,app_id)
  values ('flexcon_delete_inspection_summary_group','text, uuid, date, text, text, uuid[], uuid[]','_flexcon_undo_impl_delete_summary_group','rice_shipping')
  on conflict(function_name,argument_types) do update set implementation_name=excluded.implementation_name, app_id=excluded.app_id;
notify pgrst, 'reload schema';
commit;
