-- 仕切書マスタを種類ごとにまとめて保存します。

begin;

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
  if p_value_type not in ('recipient', 'origin', 'product', 'category') then raise exception 'マスタの種類が不正です。'; end if;
  if jsonb_typeof(coalesce(p_items, 'null'::jsonb)) <> 'array' then raise exception '保存内容が不正です。'; end if;

  select count(*) into v_expected_count
  from public.flexcon_purchase_statement_master_values
  where value_type = p_value_type;

  if jsonb_array_length(p_items) <> v_expected_count
     or (select count(distinct item.id) from jsonb_to_recordset(p_items) as item(id uuid)) <> v_expected_count
     or exists (
       select 1
       from jsonb_to_recordset(p_items) as item(id uuid)
       where not exists (
         select 1
         from public.flexcon_purchase_statement_master_values as value
         where value.id = item.id and value.value_type = p_value_type
       )
     ) then
    raise exception '保存対象が現在のマスタと一致しません。再読込してください。';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(name text, sort_order integer)
    where nullif(btrim(item.name), '') is null
       or item.sort_order is null
       or item.sort_order < 1
       or item.sort_order > v_expected_count
  ) or (select count(distinct item.sort_order) from jsonb_to_recordset(p_items) as item(sort_order integer)) <> v_expected_count then
    raise exception '名称または並び順が不正です。';
  end if;

  if p_value_type = 'product' and exists (
    select 1
    from jsonb_to_recordset(p_items) as item(product_category_id uuid)
    where item.product_category_id is not null
      and not exists (
        select 1
        from public.flexcon_purchase_statement_master_values as category
        where category.id = item.product_category_id
          and category.value_type = 'category'
          and category.active
      )
  ) then
    raise exception '種別を選び直してください。';
  end if;

  update public.flexcon_purchase_statement_master_values as value
  set name = btrim(item.name),
      sort_order = item.sort_order,
      product_category_id = case when p_value_type = 'product' then item.product_category_id else null end,
      is_variety_rice = case when p_value_type = 'product' then coalesce(item.is_variety_rice, false) else false end,
      updated_at = now()
  from jsonb_to_recordset(p_items) as item(
    id uuid,
    name text,
    sort_order integer,
    product_category_id uuid,
    is_variety_rice boolean
  )
  where value.id = item.id and value.value_type = p_value_type;
end;
$$;

revoke all on function public.flexcon_save_purchase_statement_master_group(text, text, jsonb) from public;
grant execute on function public.flexcon_save_purchase_statement_master_group(text, text, jsonb) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
