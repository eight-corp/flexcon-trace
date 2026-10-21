begin;

-- Keep legacy rows and existing Undo wrappers intact; validate only new destinations.
create or replace function public.flexcon_require_shipment_destination()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.destination_id is null and current_setting('flexcon_undo.replaying', true) is distinct from 'on' then
    raise exception '納品先を選択してください。';
  end if;
  return new;
end;
$$;
revoke all on function public.flexcon_require_shipment_destination() from public, anon, authenticated;

drop trigger if exists flexcon_shipment_destination_required on public.flexcon_shipments;
create trigger flexcon_shipment_destination_required
before insert or update of destination_id on public.flexcon_shipments
for each row execute function public.flexcon_require_shipment_destination();

notify pgrst, 'reload schema';
commit;
