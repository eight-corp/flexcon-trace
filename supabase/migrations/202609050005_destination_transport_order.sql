-- 納品先と運送会社の表示順を保存し、上下に並べ替えられるようにします。
begin;

alter table public.flexcon_destinations
  add column if not exists sort_order integer not null default 0;

alter table public.flexcon_transport_profiles
  add column if not exists sort_order integer not null default 0;

with ordered_rows as (
  select id, row_number() over (order by name, created_at, id) as new_sort_order
  from public.flexcon_destinations
)
update public.flexcon_destinations as destination
set sort_order = ordered_rows.new_sort_order
from ordered_rows
where destination.id = ordered_rows.id
  and destination.sort_order = 0;

with ordered_rows as (
  select id, row_number() over (order by company_name, created_at, id) as new_sort_order
  from public.flexcon_transport_profiles
)
update public.flexcon_transport_profiles as transport
set sort_order = ordered_rows.new_sort_order
from ordered_rows
where transport.id = ordered_rows.id
  and transport.sort_order = 0;

create index if not exists flexcon_destinations_order_idx
  on public.flexcon_destinations (sort_order, name);

create index if not exists flexcon_transport_profiles_order_idx
  on public.flexcon_transport_profiles (sort_order, company_name);

create or replace function public.flexcon_assign_destination_order()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.sort_order <= 0 then
    select coalesce(max(destination.sort_order), 0) + 1
    into new.sort_order
    from public.flexcon_destinations as destination;
  end if;
  return new;
end;
$$;

drop trigger if exists flexcon_assign_destination_order
  on public.flexcon_destinations;
create trigger flexcon_assign_destination_order
before insert on public.flexcon_destinations
for each row execute function public.flexcon_assign_destination_order();

create or replace function public.flexcon_assign_transport_profile_order()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.sort_order <= 0 then
    select coalesce(max(transport.sort_order), 0) + 1
    into new.sort_order
    from public.flexcon_transport_profiles as transport;
  end if;
  return new;
end;
$$;

drop trigger if exists flexcon_assign_transport_profile_order
  on public.flexcon_transport_profiles;
create trigger flexcon_assign_transport_profile_order
before insert on public.flexcon_transport_profiles
for each row execute function public.flexcon_assign_transport_profile_order();

create or replace function public.flexcon_reorder_destination(
  p_worker_id text,
  p_destination_id uuid,
  p_direction integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.flexcon_destinations%rowtype;
  v_adjacent public.flexcon_destinations%rowtype;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  if p_direction not in (-1, 1) then
    raise exception '移動方向が正しくありません。';
  end if;

  select * into v_current
  from public.flexcon_destinations
  where id = p_destination_id
  for update;

  if v_current.id is null then
    raise exception '納品先が見つかりません。';
  end if;

  if p_direction = -1 then
    select * into v_adjacent
    from public.flexcon_destinations
    where sort_order < v_current.sort_order
    order by sort_order desc, name desc
    limit 1 for update;
  else
    select * into v_adjacent
    from public.flexcon_destinations
    where sort_order > v_current.sort_order
    order by sort_order, name
    limit 1 for update;
  end if;

  if v_adjacent.id is null then return; end if;

  update public.flexcon_destinations
  set sort_order = case
    when id = v_current.id then v_adjacent.sort_order
    else v_current.sort_order
  end
  where id in (v_current.id, v_adjacent.id);
end;
$$;

create or replace function public.flexcon_reorder_transport_profile(
  p_worker_id text,
  p_profile_id uuid,
  p_direction integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.flexcon_transport_profiles%rowtype;
  v_adjacent public.flexcon_transport_profiles%rowtype;
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  if p_direction not in (-1, 1) then
    raise exception '移動方向が正しくありません。';
  end if;

  select * into v_current
  from public.flexcon_transport_profiles
  where id = p_profile_id
  for update;

  if v_current.id is null then
    raise exception '運送会社が見つかりません。';
  end if;

  if p_direction = -1 then
    select * into v_adjacent
    from public.flexcon_transport_profiles
    where sort_order < v_current.sort_order
    order by sort_order desc, company_name desc
    limit 1 for update;
  else
    select * into v_adjacent
    from public.flexcon_transport_profiles
    where sort_order > v_current.sort_order
    order by sort_order, company_name
    limit 1 for update;
  end if;

  if v_adjacent.id is null then return; end if;

  update public.flexcon_transport_profiles
  set sort_order = case
    when id = v_current.id then v_adjacent.sort_order
    else v_current.sort_order
  end
  where id in (v_current.id, v_adjacent.id);
end;
$$;

revoke all on function public.flexcon_assign_destination_order() from public;
revoke all on function public.flexcon_assign_transport_profile_order() from public;
revoke all on function public.flexcon_reorder_destination(text, uuid, integer) from public;
revoke all on function public.flexcon_reorder_transport_profile(text, uuid, integer) from public;

grant execute on function public.flexcon_reorder_destination(text, uuid, integer)
  to anon, authenticated;
grant execute on function public.flexcon_reorder_transport_profile(text, uuid, integer)
  to anon, authenticated;

commit;
