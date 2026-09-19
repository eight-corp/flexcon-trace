-- 仕切書番号の重複を防ぎ、品名マスタへ種別と銘柄米区分を追加します。

begin;

create unique index if not exists flexcon_purchase_statements_document_number_key
  on public.flexcon_purchase_statements (lower(btrim(document_number)));

delete from public.flexcon_purchase_statement_master_values
where value_type in ('issuer', 'package');

alter table public.flexcon_purchase_statement_master_values
  add column if not exists product_category_id uuid,
  add column if not exists is_variety_rice boolean not null default false;

alter table public.flexcon_purchase_statement_master_values
  drop constraint if exists flexcon_purchase_statement_master_values_value_type_check;
alter table public.flexcon_purchase_statement_master_values
  add constraint flexcon_purchase_statement_master_values_value_type_check
  check (value_type in ('recipient', 'origin', 'product', 'category'));

alter table public.flexcon_purchase_statement_master_values
  drop constraint if exists flexcon_purchase_statement_master_values_product_category_id_fkey;
alter table public.flexcon_purchase_statement_master_values
  add constraint flexcon_purchase_statement_master_values_product_category_id_fkey
  foreign key (product_category_id)
  references public.flexcon_purchase_statement_master_values(id)
  on delete set null;

alter table public.flexcon_purchase_statement_master_values
  drop constraint if exists flexcon_purchase_statement_master_values_product_settings_check;
alter table public.flexcon_purchase_statement_master_values
  add constraint flexcon_purchase_statement_master_values_product_settings_check
  check (value_type = 'product' or (product_category_id is null and is_variety_rice = false));

create or replace function public.flexcon_find_purchase_statement_by_number(
  p_worker_id text,
  p_document_number text,
  p_exclude_statement_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  if nullif(btrim(p_document_number), '') is null then return null; end if;
  return (
    select jsonb_build_object(
      'id', statement.id,
      'document_number', statement.document_number,
      'statement_date', statement.statement_date,
      'issuer', statement.issuer
    )
    from public.flexcon_purchase_statements as statement
    where lower(btrim(statement.document_number)) = lower(btrim(p_document_number))
      and (p_exclude_statement_id is null or statement.id <> p_exclude_statement_id)
    limit 1
  );
end;
$$;

create or replace function public.flexcon_list_purchase_statement_master(p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.flexcon_require_active_worker(p_worker_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', value.id,
    'value_type', value.value_type,
    'name', value.name,
    'active', value.active,
    'sort_order', value.sort_order,
    'product_category_id', value.product_category_id,
    'product_category_name', category.name,
    'is_variety_rice', value.is_variety_rice
  ) order by value.value_type, value.sort_order, value.name)
  from public.flexcon_purchase_statement_master_values as value
  left join public.flexcon_purchase_statement_master_values as category
    on category.id = value.product_category_id and category.value_type = 'category'), '[]'::jsonb);
end;
$$;

drop function if exists public.flexcon_save_purchase_statement_master(text, uuid, text, text);

create function public.flexcon_save_purchase_statement_master(
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
  if p_value_type not in ('recipient', 'origin', 'product', 'category') then raise exception 'マスタの種類が不正です。'; end if;
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

revoke all on function public.flexcon_find_purchase_statement_by_number(text, text, uuid) from public;
revoke all on function public.flexcon_save_purchase_statement_master(text, uuid, text, text, uuid, boolean) from public;
grant execute on function public.flexcon_find_purchase_statement_by_number(text, text, uuid) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_statement_master(text, uuid, text, text, uuid, boolean) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
