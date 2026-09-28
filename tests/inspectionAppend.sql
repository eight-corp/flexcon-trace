begin;
do $$
declare
  v_worker text;
  v_registration uuid;
  v_authorization uuid;
  v_location text;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_before integer;
  v_paper_before integer;
  v_standard_no integer;
  v_bulk_no integer;
  v_weight integer;
  v_warehouse uuid;
begin
  select u.worker_id into v_worker from business_private.users u
  join public.workers w using (worker_id)
  join business_private.permissions p using (worker_id)
  where u.enabled and w.active and p.app_id = 'rice_shipping' and p.role in ('admin', 'operator') limit 1;
  select r.id, r.authorization_id, r.warehouse_id into v_registration, v_authorization, v_warehouse
  from public.flexcon_inspection_registrations r
  join public.flexcon_authorizations a on a.id = r.authorization_id
  where a.authorization_no ~ '^[0-9]{1,4}$'
    and not exists (select 1 from public.flexcon_inspection_flexcons f where f.authorization_id = r.authorization_id and f.flexcon_no > 995)
  limit 1;
  select name into v_location from public.flexcon_inspection_options where active and option_type = 'location' limit 1;
  if v_worker is null or v_registration is null or v_location is null then raise exception 'test prerequisites missing'; end if;
  insert into business_private.sessions values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_worker, now() + interval '1 hour', false);
  perform set_config('request.headers', jsonb_build_object('x-business-session', v_token)::text, true);
  select count(*) into v_before from public.flexcon_inspection_flexcons where registration_id = v_registration;
  select count(*) into v_paper_before from public.flexcon_inspection_paper_bags where registration_id = v_registration;
  select coalesce(max(flexcon_no), 0) + 1 into v_standard_no from public.flexcon_inspection_flexcons where authorization_id = v_authorization and record_kind = 'standard';
  select coalesce(max(flexcon_no), 0) + 1 into v_bulk_no from public.flexcon_inspection_flexcons where authorization_id = v_authorization and record_kind = 'bulk';
  select coalesce((select weight_kg from public.flexcon_inspection_weights where weight_type = 'feed_rice'), 1000) into v_weight;

  perform public.flexcon_append_inspection_registration(v_worker, v_registration, 8, '2026-09-28', 'append-test', '2026-09-29', v_location, '飼料用玄米', 2, 3, 50);
  if (select count(*) from public.flexcon_inspection_flexcons where registration_id = v_registration) <> v_before + 3 then raise exception 'flexcon count failed'; end if;
  if not exists (select 1 from public.flexcon_inspection_flexcons where registration_id = v_registration and record_kind = 'standard' and flexcon_no = v_standard_no
    and fiscal_year = 8 and purchase_date = '2026-09-28' and inspection_date = '2026-09-29' and inspection_location = v_location and brand = '飼料用玄米' and quantity_kg = v_weight
    and lot_number like '2026%' and grade is null and moisture is null) then raise exception 'metadata or feed weight failed'; end if;
  if not exists (select 1 from public.flexcon_inspection_flexcons where registration_id = v_registration and record_kind = 'bulk' and flexcon_no = v_bulk_no and quantity_kg = 50) then raise exception 'bulk failed'; end if;
  if (select count(*) from public.flexcon_inspection_paper_bags where registration_id = v_registration) <> v_paper_before + 1 then raise exception 'paper count failed'; end if;
  if not exists (select 1 from public.flexcon_inspection_paper_bags where registration_id = v_registration and bag_count = 3 and purchase_date = '2026-09-28' and brand = '飼料用玄米') then raise exception 'paper metadata failed'; end if;
  if (select warehouse_id from public.flexcon_inspection_registrations where id = v_registration) is distinct from v_warehouse then raise exception 'warehouse changed'; end if;

  perform public.flexcon_append_inspection_registration(v_worker, v_registration, 8, '2026-09-28', 'append-test', null, v_location, '飼料用玄米', 0, 0, 20);
  if not exists (select 1 from public.flexcon_inspection_flexcons where registration_id = v_registration and record_kind = 'bulk' and flexcon_no = v_bulk_no + 1 and quantity_kg = 20) then raise exception 'repeated bulk numbering failed'; end if;
  begin
    perform public.flexcon_append_inspection_registration(v_worker, v_registration, 8, '2026-09-28', 'append-test', null, v_location, '飼料用玄米', 0, 0, 0);
    raise exception 'zero quantity accepted' using errcode = 'ZX001';
  exception when raise_exception then null;
  end;
  perform set_config('request.headers', '{}', true);
  begin
    perform public.flexcon_append_inspection_registration(v_worker, v_registration, 8, '2026-09-28', 'append-test', null, v_location, '飼料用玄米', 1, 0, 0);
    raise exception 'unauthenticated append accepted' using errcode = 'ZX002';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;
