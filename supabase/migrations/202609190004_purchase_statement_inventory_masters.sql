-- 仕切書アプリの在庫商品、仕入在庫、保管場所、販売先マスタを管理します。

begin;

alter table public.flexcon_purchase_statement_master_values
  drop constraint if exists flexcon_purchase_statement_master_values_value_type_check;
alter table public.flexcon_purchase_statement_master_values
  add constraint flexcon_purchase_statement_master_values_value_type_check
  check (value_type in ('recipient', 'origin', 'product', 'category', 'storage_location', 'customer'));

create table if not exists public.flexcon_purchase_inventory_master (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  inventory_product_id uuid not null references public.flexcon_purchase_statement_master_values(id) on delete restrict,
  scrap_type_product_id uuid references public.flexcon_purchase_statement_master_values(id) on delete restrict,
  statement_keywords text[] not null default '{}'::text[],
  sort_order integer not null default 1 check (sort_order > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint flexcon_purchase_inventory_master_keywords_check
    check (cardinality(statement_keywords) between 1 and 50)
);

create unique index if not exists flexcon_purchase_inventory_master_name_key
  on public.flexcon_purchase_inventory_master (lower(btrim(name)));
create index if not exists flexcon_purchase_inventory_master_sort_idx
  on public.flexcon_purchase_inventory_master (sort_order, name);

alter table public.flexcon_purchase_inventory_master enable row level security;
revoke all on public.flexcon_purchase_inventory_master from public, anon, authenticated;

create or replace function public.flexcon_save_purchase_statement_master(
  p_worker_id text,
  p_value_id uuid,
  p_value_type text,
  p_name text,
  p_product_category_id uuid default null,
  p_is_variety_rice boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  if p_value_type not in ('recipient', 'origin', 'product', 'category', 'storage_location', 'customer') then raise exception 'マスタの種類が不正です。'; end if;
  if nullif(btrim(p_name), '') is null then raise exception '名称を入力してください。'; end if;
  if p_value_type = 'product' and p_product_category_id is not null and not exists (
    select 1 from public.flexcon_purchase_statement_master_values
    where id = p_product_category_id and value_type = 'category' and active
  ) then raise exception '種別を選び直してください。'; end if;

  if p_value_id is null then
    insert into public.flexcon_purchase_statement_master_values(
      value_type, name, sort_order, product_category_id, is_variety_rice
    ) values (
      p_value_type,
      btrim(p_name),
      coalesce((select max(sort_order) + 1 from public.flexcon_purchase_statement_master_values where value_type = p_value_type), 1),
      case when p_value_type = 'product' then p_product_category_id else null end,
      case when p_value_type = 'product' then coalesce(p_is_variety_rice, false) else false end
    ) returning id into v_id;
  else
    update public.flexcon_purchase_statement_master_values
    set name = btrim(p_name),
        product_category_id = case when p_value_type = 'product' then p_product_category_id else null end,
        is_variety_rice = case when p_value_type = 'product' then coalesce(p_is_variety_rice, false) else false end,
        updated_at = now()
    where id = p_value_id and value_type = p_value_type
    returning id into v_id;
    if v_id is null then raise exception 'マスタ項目が見つかりません。'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.flexcon_reorder_purchase_statement_master(
  p_worker_id text,
  p_value_type text,
  p_value_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_expected_count integer;
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  if p_value_type not in ('recipient', 'origin', 'product', 'category', 'storage_location', 'customer') then raise exception 'マスタの種類が不正です。'; end if;
  select count(*) into v_expected_count from public.flexcon_purchase_statement_master_values where value_type = p_value_type;
  if coalesce(cardinality(p_value_ids), 0) <> v_expected_count
     or (select count(distinct supplied.id) from unnest(coalesce(p_value_ids, '{}'::uuid[])) as supplied(id)) <> v_expected_count
     or exists (
       select 1 from unnest(coalesce(p_value_ids, '{}'::uuid[])) as supplied(id)
       where not exists (select 1 from public.flexcon_purchase_statement_master_values where id = supplied.id and value_type = p_value_type)
     ) then raise exception '並び順の対象が現在のマスタと一致しません。再読込してください。'; end if;
  update public.flexcon_purchase_statement_master_values as value
  set sort_order = ordered.position, updated_at = now()
  from unnest(p_value_ids) with ordinality as ordered(id, position)
  where value.id = ordered.id and value.value_type = p_value_type;
end;
$$;

create or replace function public.flexcon_save_purchase_statement_master_group(
  p_worker_id text,
  p_value_type text,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_expected_count integer;
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  if p_value_type not in ('recipient', 'origin', 'product', 'category', 'storage_location', 'customer') then raise exception 'マスタの種類が不正です。'; end if;
  if jsonb_typeof(coalesce(p_items, 'null'::jsonb)) <> 'array' then raise exception '保存内容が不正です。'; end if;
  select count(*) into v_expected_count from public.flexcon_purchase_statement_master_values where value_type = p_value_type;
  if jsonb_array_length(p_items) <> v_expected_count
     or (select count(distinct item.id) from jsonb_to_recordset(p_items) as item(id uuid)) <> v_expected_count
     or exists (
       select 1 from jsonb_to_recordset(p_items) as item(id uuid)
       where not exists (select 1 from public.flexcon_purchase_statement_master_values as value where value.id = item.id and value.value_type = p_value_type)
     ) then raise exception '保存対象が現在のマスタと一致しません。再読込してください。'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as item(name text, sort_order integer)
    where nullif(btrim(item.name), '') is null or item.sort_order is null or item.sort_order < 1 or item.sort_order > v_expected_count
  ) or (select count(distinct item.sort_order) from jsonb_to_recordset(p_items) as item(sort_order integer)) <> v_expected_count
  then raise exception '名称または並び順が不正です。'; end if;
  if p_value_type = 'product' and exists (
    select 1 from jsonb_to_recordset(p_items) as item(product_category_id uuid)
    where item.product_category_id is not null and not exists (
      select 1 from public.flexcon_purchase_statement_master_values as category
      where category.id = item.product_category_id and category.value_type = 'category' and category.active
    )
  ) then raise exception '種別を選び直してください。'; end if;
  update public.flexcon_purchase_statement_master_values as value
  set name = btrim(item.name),
      sort_order = item.sort_order,
      product_category_id = case when p_value_type = 'product' then item.product_category_id else null end,
      is_variety_rice = case when p_value_type = 'product' then coalesce(item.is_variety_rice, false) else false end,
      updated_at = now()
  from jsonb_to_recordset(p_items) as item(id uuid, name text, sort_order integer, product_category_id uuid, is_variety_rice boolean)
  where value.id = item.id and value.value_type = p_value_type;
end;
$$;

create or replace function public.flexcon_list_purchase_inventory_master(p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', item.id,
      'name', item.name,
      'inventory_product_id', item.inventory_product_id,
      'inventory_product_name', inventory_product.name,
      'scrap_type_product_id', item.scrap_type_product_id,
      'scrap_type_product_name', scrap_product.name,
      'statement_keywords', to_jsonb(item.statement_keywords),
      'sort_order', item.sort_order
    ) order by item.sort_order, item.name)
    from public.flexcon_purchase_inventory_master as item
    join public.flexcon_purchase_statement_master_values as inventory_product
      on inventory_product.id = item.inventory_product_id and inventory_product.value_type = 'product'
    left join public.flexcon_purchase_statement_master_values as scrap_product
      on scrap_product.id = item.scrap_type_product_id and scrap_product.value_type = 'product'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.flexcon_save_purchase_inventory_master(
  p_worker_id text,
  p_item_id uuid,
  p_name text,
  p_inventory_product_id uuid,
  p_scrap_type_product_id uuid,
  p_statement_keywords text[]
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_keywords text[];
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  if nullif(btrim(p_name), '') is null then raise exception '品名を入力してください。'; end if;
  if not exists (
    select 1 from public.flexcon_purchase_statement_master_values
    where id = p_inventory_product_id and value_type = 'product' and active
  ) then raise exception '在庫計上先を選び直してください。'; end if;
  if p_scrap_type_product_id is not null and not exists (
    select 1 from public.flexcon_purchase_statement_master_values
    where id = p_scrap_type_product_id and value_type = 'product' and active and is_variety_rice
  ) then raise exception 'くず米種別を選び直してください。'; end if;
  select coalesce(array_agg(keyword order by first_position), '{}'::text[]) into v_keywords
  from (
    select min(position) as first_position, btrim(keyword) as keyword
    from unnest(coalesce(p_statement_keywords, '{}'::text[])) with ordinality as supplied(keyword, position)
    where nullif(btrim(keyword), '') is not null
    group by lower(btrim(keyword)), btrim(keyword)
  ) as normalized;
  if cardinality(v_keywords) not between 1 and 50 then raise exception '仕切書キーワードを1件以上50件以内で入力してください。'; end if;
  if exists (select 1 from unnest(v_keywords) as keyword where char_length(keyword) > 120) then raise exception '仕切書キーワードは1件120文字以内で入力してください。'; end if;
  if p_item_id is null then
    insert into public.flexcon_purchase_inventory_master(name, inventory_product_id, scrap_type_product_id, statement_keywords, sort_order)
    values (btrim(p_name), p_inventory_product_id, p_scrap_type_product_id, v_keywords,
      coalesce((select max(sort_order) + 1 from public.flexcon_purchase_inventory_master), 1))
    returning id into v_id;
  else
    update public.flexcon_purchase_inventory_master
    set name = btrim(p_name), inventory_product_id = p_inventory_product_id,
        scrap_type_product_id = p_scrap_type_product_id, statement_keywords = v_keywords, updated_at = now()
    where id = p_item_id returning id into v_id;
    if v_id is null then raise exception '仕入在庫項目が見つかりません。'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.flexcon_save_purchase_inventory_master_group(
  p_worker_id text,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_expected_count integer;
  v_item jsonb;
  v_keywords text[];
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  if jsonb_typeof(coalesce(p_items, 'null'::jsonb)) <> 'array' then raise exception '保存内容が不正です。'; end if;
  select count(*) into v_expected_count from public.flexcon_purchase_inventory_master;
  if jsonb_array_length(p_items) <> v_expected_count
     or (select count(distinct (item.value->>'id')::uuid) from jsonb_array_elements(p_items) as item(value)) <> v_expected_count
     or exists (
       select 1 from jsonb_array_elements(p_items) as item(value)
       where not exists (select 1 from public.flexcon_purchase_inventory_master where id = (item.value->>'id')::uuid)
     ) then raise exception '保存対象が現在の仕入在庫マスタと一致しません。再読込してください。'; end if;
  if (select count(distinct (item.value->>'sort_order')::integer) from jsonb_array_elements(p_items) as item(value)) <> v_expected_count
  then raise exception '並び順が不正です。'; end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if nullif(btrim(v_item->>'name'), '') is null then raise exception '品名をすべて入力してください。'; end if;
    if (v_item->>'sort_order')::integer not between 1 and v_expected_count then raise exception '並び順が不正です。'; end if;
    if not exists (
      select 1 from public.flexcon_purchase_statement_master_values
      where id = (v_item->>'inventory_product_id')::uuid and value_type = 'product' and active
    ) then raise exception '在庫計上先を選び直してください。'; end if;
    if nullif(v_item->>'scrap_type_product_id', '') is not null and not exists (
      select 1 from public.flexcon_purchase_statement_master_values
      where id = (v_item->>'scrap_type_product_id')::uuid and value_type = 'product' and active and is_variety_rice
    ) then raise exception 'くず米種別を選び直してください。'; end if;
    select coalesce(array_agg(keyword order by first_position), '{}'::text[]) into v_keywords
    from (
      select min(position) as first_position, btrim(keyword) as keyword
      from jsonb_array_elements_text(coalesce(v_item->'statement_keywords', '[]'::jsonb)) with ordinality as supplied(keyword, position)
      where nullif(btrim(keyword), '') is not null
      group by lower(btrim(keyword)), btrim(keyword)
    ) as normalized;
    if cardinality(v_keywords) not between 1 and 50 then raise exception '仕切書キーワードを1件以上50件以内で入力してください。'; end if;
    if exists (select 1 from unnest(v_keywords) as keyword where char_length(keyword) > 120) then raise exception '仕切書キーワードは1件120文字以内で入力してください。'; end if;
    update public.flexcon_purchase_inventory_master
    set name = btrim(v_item->>'name'),
        inventory_product_id = (v_item->>'inventory_product_id')::uuid,
        scrap_type_product_id = nullif(v_item->>'scrap_type_product_id', '')::uuid,
        statement_keywords = v_keywords,
        sort_order = (v_item->>'sort_order')::integer,
        updated_at = now()
    where id = (v_item->>'id')::uuid;
  end loop;
end;
$$;

create or replace function public.flexcon_delete_purchase_inventory_master(p_worker_id text, p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  delete from public.flexcon_purchase_inventory_master where id = p_item_id;
  if not found then raise exception '仕入在庫項目が見つかりません。'; end if;
end;
$$;

revoke all on function public.flexcon_save_purchase_statement_master(text, uuid, text, text, uuid, boolean) from public;
revoke all on function public.flexcon_reorder_purchase_statement_master(text, text, uuid[]) from public;
revoke all on function public.flexcon_save_purchase_statement_master_group(text, text, jsonb) from public;
revoke all on function public.flexcon_list_purchase_inventory_master(text) from public;
revoke all on function public.flexcon_save_purchase_inventory_master(text, uuid, text, uuid, uuid, text[]) from public;
revoke all on function public.flexcon_save_purchase_inventory_master_group(text, jsonb) from public;
revoke all on function public.flexcon_delete_purchase_inventory_master(text, uuid) from public;
grant execute on function public.flexcon_save_purchase_statement_master(text, uuid, text, text, uuid, boolean) to anon, authenticated;
grant execute on function public.flexcon_reorder_purchase_statement_master(text, text, uuid[]) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_statement_master_group(text, text, jsonb) to anon, authenticated;
grant execute on function public.flexcon_list_purchase_inventory_master(text) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_inventory_master(text, uuid, text, uuid, uuid, text[]) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_inventory_master_group(text, jsonb) to anon, authenticated;
grant execute on function public.flexcon_delete_purchase_inventory_master(text, uuid) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
