-- 委任状一覧と追加・編集・削除RPCを追加します。
-- 202609020003_admin_shipment_history.sql の実行後に適用してください。

create table if not exists public.flexcon_authorizations (
  id uuid primary key default gen_random_uuid(),
  authorization_no text not null unique
    check (char_length(btrim(authorization_no)) between 1 and 40),
  full_name text not null
    check (char_length(btrim(full_name)) between 1 and 120),
  seed_purchase_slip boolean not null default false,
  farming_plan boolean not null default false,
  address text,
  prefecture text,
  municipality text,
  phone text,
  crop_type text,
  feed_rice_variety text,
  notes text,
  created_by_worker_id text not null references public.workers(worker_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists flexcon_authorizations_name_idx
  on public.flexcon_authorizations (full_name);
create index if not exists flexcon_authorizations_area_idx
  on public.flexcon_authorizations (prefecture, municipality);

alter table public.flexcon_authorizations enable row level security;

drop policy if exists flexcon_read_authorizations on public.flexcon_authorizations;
create policy flexcon_read_authorizations on public.flexcon_authorizations
  for select to anon, authenticated using (true);

create or replace function public.flexcon_add_authorization(
  p_worker_id text,
  p_authorization_no text,
  p_full_name text,
  p_seed_purchase_slip boolean,
  p_farming_plan boolean,
  p_address text default null,
  p_prefecture text default null,
  p_municipality text default null,
  p_phone text default null,
  p_crop_type text default null,
  p_feed_rice_variety text default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_id uuid;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);

  if char_length(btrim(coalesce(p_authorization_no, ''))) not between 1 and 40 then
    raise exception '№を1文字から40文字で入力してください。';
  end if;
  if char_length(btrim(coalesce(p_full_name, ''))) not between 1 and 120 then
    raise exception '氏名を1文字から120文字で入力してください。';
  end if;
  if exists (
    select 1 from public.flexcon_authorizations
    where authorization_no = btrim(p_authorization_no)
  ) then
    raise exception '同じ№がすでに登録されています。';
  end if;

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
    btrim(p_authorization_no),
    btrim(p_full_name),
    coalesce(p_seed_purchase_slip, false),
    coalesce(p_farming_plan, false),
    nullif(btrim(p_address), ''),
    nullif(btrim(p_prefecture), ''),
    nullif(btrim(p_municipality), ''),
    nullif(btrim(p_phone), ''),
    nullif(btrim(p_crop_type), ''),
    nullif(btrim(p_feed_rice_variety), ''),
    nullif(btrim(p_notes), ''),
    v_worker.worker_id
  ) returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.flexcon_update_authorization(
  p_worker_id text,
  p_authorization_id uuid,
  p_authorization_no text,
  p_full_name text,
  p_seed_purchase_slip boolean,
  p_farming_plan boolean,
  p_address text default null,
  p_prefecture text default null,
  p_municipality text default null,
  p_phone text default null,
  p_crop_type text default null,
  p_feed_rice_variety text default null,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if char_length(btrim(coalesce(p_authorization_no, ''))) not between 1 and 40 then
    raise exception '№を1文字から40文字で入力してください。';
  end if;
  if char_length(btrim(coalesce(p_full_name, ''))) not between 1 and 120 then
    raise exception '氏名を1文字から120文字で入力してください。';
  end if;
  if exists (
    select 1 from public.flexcon_authorizations
    where id <> p_authorization_id
      and authorization_no = btrim(p_authorization_no)
  ) then
    raise exception '同じ№がすでに登録されています。';
  end if;

  update public.flexcon_authorizations
  set authorization_no = btrim(p_authorization_no),
      full_name = btrim(p_full_name),
      seed_purchase_slip = coalesce(p_seed_purchase_slip, false),
      farming_plan = coalesce(p_farming_plan, false),
      address = nullif(btrim(p_address), ''),
      prefecture = nullif(btrim(p_prefecture), ''),
      municipality = nullif(btrim(p_municipality), ''),
      phone = nullif(btrim(p_phone), ''),
      crop_type = nullif(btrim(p_crop_type), ''),
      feed_rice_variety = nullif(btrim(p_feed_rice_variety), ''),
      notes = nullif(btrim(p_notes), ''),
      updated_at = now()
  where id = p_authorization_id;

  if not found then
    raise exception '委任状情報が見つかりません。';
  end if;
end;
$$;

create or replace function public.flexcon_delete_authorization(
  p_worker_id text,
  p_authorization_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  delete from public.flexcon_authorizations
  where id = p_authorization_id;

  if not found then
    raise exception '委任状情報が見つかりません。';
  end if;
end;
$$;

revoke all on function public.flexcon_add_authorization(text, text, text, boolean, boolean, text, text, text, text, text, text, text) from public;
revoke all on function public.flexcon_update_authorization(text, uuid, text, text, boolean, boolean, text, text, text, text, text, text, text) from public;
revoke all on function public.flexcon_delete_authorization(text, uuid) from public;

grant select on public.flexcon_authorizations to anon, authenticated;
grant execute on function public.flexcon_add_authorization(text, text, text, boolean, boolean, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.flexcon_update_authorization(text, uuid, text, text, boolean, boolean, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.flexcon_delete_authorization(text, uuid) to anon, authenticated;
