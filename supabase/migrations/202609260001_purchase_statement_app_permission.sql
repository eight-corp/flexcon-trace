begin;

insert into business_private.apps (app_id, app_name, migrated, display_order)
values ('purchase_statements', '仕切書読込み', true, 7)
on conflict (app_id) do update
set app_name = excluded.app_name,
    migrated = true,
    display_order = excluded.display_order;

-- Existing system administrators and rice-shipping administrators start enabled.
insert into business_private.permissions (worker_id, app_id, role)
select distinct users.worker_id, 'purchase_statements', 'admin'
from business_private.users as users
left join business_private.permissions as rice
  on rice.worker_id = users.worker_id and rice.app_id = 'rice_shipping'
where users.enabled and (users.system_admin or rice.role = 'admin')
on conflict (worker_id, app_id) do nothing;

create or replace function public.flexcon_require_active_worker(p_worker_id text)
returns public.workers
language plpgsql
security definer
set search_path = pg_catalog, public, business_private
as $$
declare
  v_worker public.workers%rowtype;
  v_scope text := current_setting('flexcon.statement_scope', true);
begin
  select * into v_worker
  from public.workers
  where worker_id = btrim(coalesce(p_worker_id, '')) and active = true;
  if not found then
    raise exception '作業者が無効です。もう一度ログインしてください。';
  end if;

  if v_scope in ('viewer', 'operator', 'admin') then
    perform business_private.require_app(
      'purchase_statements',
      case when v_scope = 'viewer' then 'viewer' else 'operator' end,
      v_worker.worker_id
    );
  else
    perform business_private.require_app('rice_shipping', 'operator', v_worker.worker_id);
  end if;
  return v_worker;
end;
$$;

create or replace function public.flexcon_require_admin_worker(p_worker_id text)
returns public.workers
language plpgsql
security definer
set search_path = pg_catalog, public, business_private
as $$
declare
  v_worker public.workers%rowtype;
  v_scope text := current_setting('flexcon.statement_scope', true);
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  perform business_private.require_app(
    case when v_scope in ('viewer', 'operator', 'admin') then 'purchase_statements' else 'rice_shipping' end,
    'admin', v_worker.worker_id
  );
  return v_worker;
end;
$$;

create or replace function public.flexcon_set_purchase_statement_scope(p_worker_id text, p_min_role text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, business_private
as $$
begin
  if p_min_role not in ('viewer', 'operator', 'admin') then
    raise exception '権限の指定が不正です。';
  end if;
  perform business_private.require_app('purchase_statements', p_min_role, p_worker_id);
  perform set_config('flexcon.statement_scope', p_min_role, true);
end;
$$;
revoke all on function public.flexcon_set_purchase_statement_scope(text, text) from public, anon, authenticated;

alter function public.flexcon_list_purchase_statements(text) rename to flexcon_list_purchase_statements_internal;
alter function public.flexcon_save_purchase_statement(text, uuid, text, jsonb, jsonb) rename to flexcon_save_purchase_statement_internal;
alter function public.flexcon_find_purchase_statement_by_number(text, text, uuid) rename to flexcon_find_purchase_statement_by_number_internal;
alter function public.flexcon_delete_purchase_statement(text, uuid) rename to flexcon_delete_purchase_statement_internal;
alter function public.flexcon_list_purchase_statement_master(text) rename to flexcon_list_purchase_statement_master_internal;
alter function public.flexcon_save_purchase_statement_master(text, uuid, text, text, uuid, boolean) rename to flexcon_save_purchase_statement_master_internal;
alter function public.flexcon_reorder_purchase_statement_master(text, text, uuid[]) rename to flexcon_reorder_purchase_statement_master_internal;
alter function public.flexcon_save_purchase_statement_master_group(text, text, jsonb) rename to flexcon_save_purchase_statement_master_group_internal;
alter function public.flexcon_delete_purchase_statement_master(text, uuid) rename to flexcon_delete_purchase_statement_master_internal;
alter function public.flexcon_list_purchase_inventory_master(text) rename to flexcon_list_purchase_inventory_master_internal;
alter function public.flexcon_save_purchase_inventory_master(text, uuid, text, uuid, uuid, text[]) rename to flexcon_save_purchase_inventory_master_internal;
alter function public.flexcon_save_purchase_inventory_master_group(text, jsonb) rename to flexcon_save_purchase_inventory_master_group_internal;
alter function public.flexcon_delete_purchase_inventory_master(text, uuid) rename to flexcon_delete_purchase_inventory_master_internal;

revoke all on function public.flexcon_list_purchase_statements_internal(text) from public, anon, authenticated;
revoke all on function public.flexcon_save_purchase_statement_internal(text, uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.flexcon_find_purchase_statement_by_number_internal(text, text, uuid) from public, anon, authenticated;
revoke all on function public.flexcon_delete_purchase_statement_internal(text, uuid) from public, anon, authenticated;
revoke all on function public.flexcon_list_purchase_statement_master_internal(text) from public, anon, authenticated;
revoke all on function public.flexcon_save_purchase_statement_master_internal(text, uuid, text, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.flexcon_reorder_purchase_statement_master_internal(text, text, uuid[]) from public, anon, authenticated;
revoke all on function public.flexcon_save_purchase_statement_master_group_internal(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.flexcon_delete_purchase_statement_master_internal(text, uuid) from public, anon, authenticated;
revoke all on function public.flexcon_list_purchase_inventory_master_internal(text) from public, anon, authenticated;
revoke all on function public.flexcon_save_purchase_inventory_master_internal(text, uuid, text, uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.flexcon_save_purchase_inventory_master_group_internal(text, jsonb) from public, anon, authenticated;
revoke all on function public.flexcon_delete_purchase_inventory_master_internal(text, uuid) from public, anon, authenticated;

create function public.flexcon_list_purchase_statements(p_worker_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'viewer');
  return public.flexcon_list_purchase_statements_internal(p_worker_id);
end; $$;

create function public.flexcon_save_purchase_statement(
  p_worker_id text, p_statement_id uuid, p_source_type text, p_header jsonb, p_items jsonb
)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'operator');
  return public.flexcon_save_purchase_statement_internal(p_worker_id, p_statement_id, p_source_type, p_header, p_items);
end; $$;

create function public.flexcon_find_purchase_statement_by_number(
  p_worker_id text, p_document_number text, p_exclude_statement_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'viewer');
  return public.flexcon_find_purchase_statement_by_number_internal(p_worker_id, p_document_number, p_exclude_statement_id);
end; $$;

create function public.flexcon_delete_purchase_statement(p_worker_id text, p_statement_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'admin');
  perform public.flexcon_delete_purchase_statement_internal(p_worker_id, p_statement_id);
end; $$;

create function public.flexcon_list_purchase_statement_master(p_worker_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'viewer');
  return public.flexcon_list_purchase_statement_master_internal(p_worker_id);
end; $$;

create function public.flexcon_save_purchase_statement_master(
  p_worker_id text, p_value_id uuid, p_value_type text, p_name text,
  p_product_category_id uuid default null, p_is_variety_rice boolean default false
)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'admin');
  return public.flexcon_save_purchase_statement_master_internal(
    p_worker_id, p_value_id, p_value_type, p_name, p_product_category_id, p_is_variety_rice
  );
end; $$;

create function public.flexcon_reorder_purchase_statement_master(
  p_worker_id text, p_value_type text, p_value_ids uuid[]
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'admin');
  perform public.flexcon_reorder_purchase_statement_master_internal(p_worker_id, p_value_type, p_value_ids);
end; $$;

create function public.flexcon_save_purchase_statement_master_group(
  p_worker_id text, p_value_type text, p_items jsonb
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'admin');
  perform public.flexcon_save_purchase_statement_master_group_internal(p_worker_id, p_value_type, p_items);
end; $$;

create function public.flexcon_delete_purchase_statement_master(p_worker_id text, p_value_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'admin');
  perform public.flexcon_delete_purchase_statement_master_internal(p_worker_id, p_value_id);
end; $$;

create function public.flexcon_list_purchase_inventory_master(p_worker_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'viewer');
  return public.flexcon_list_purchase_inventory_master_internal(p_worker_id);
end; $$;

create function public.flexcon_save_purchase_inventory_master(
  p_worker_id text, p_item_id uuid, p_name text, p_inventory_product_id uuid,
  p_scrap_type_product_id uuid, p_statement_keywords text[]
)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'admin');
  return public.flexcon_save_purchase_inventory_master_internal(
    p_worker_id, p_item_id, p_name, p_inventory_product_id, p_scrap_type_product_id, p_statement_keywords
  );
end; $$;

create function public.flexcon_save_purchase_inventory_master_group(p_worker_id text, p_items jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'admin');
  perform public.flexcon_save_purchase_inventory_master_group_internal(p_worker_id, p_items);
end; $$;

create function public.flexcon_delete_purchase_inventory_master(p_worker_id text, p_item_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'admin');
  perform public.flexcon_delete_purchase_inventory_master_internal(p_worker_id, p_item_id);
end; $$;

revoke all on function public.flexcon_list_purchase_statements(text) from public;
revoke all on function public.flexcon_save_purchase_statement(text, uuid, text, jsonb, jsonb) from public;
revoke all on function public.flexcon_find_purchase_statement_by_number(text, text, uuid) from public;
revoke all on function public.flexcon_delete_purchase_statement(text, uuid) from public;
revoke all on function public.flexcon_list_purchase_statement_master(text) from public;
revoke all on function public.flexcon_save_purchase_statement_master(text, uuid, text, text, uuid, boolean) from public;
revoke all on function public.flexcon_reorder_purchase_statement_master(text, text, uuid[]) from public;
revoke all on function public.flexcon_save_purchase_statement_master_group(text, text, jsonb) from public;
revoke all on function public.flexcon_delete_purchase_statement_master(text, uuid) from public;
revoke all on function public.flexcon_list_purchase_inventory_master(text) from public;
revoke all on function public.flexcon_save_purchase_inventory_master(text, uuid, text, uuid, uuid, text[]) from public;
revoke all on function public.flexcon_save_purchase_inventory_master_group(text, jsonb) from public;
revoke all on function public.flexcon_delete_purchase_inventory_master(text, uuid) from public;

grant execute on function public.flexcon_list_purchase_statements(text) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_statement(text, uuid, text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.flexcon_find_purchase_statement_by_number(text, text, uuid) to anon, authenticated;
grant execute on function public.flexcon_delete_purchase_statement(text, uuid) to anon, authenticated;
grant execute on function public.flexcon_list_purchase_statement_master(text) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_statement_master(text, uuid, text, text, uuid, boolean) to anon, authenticated;
grant execute on function public.flexcon_reorder_purchase_statement_master(text, text, uuid[]) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_statement_master_group(text, text, jsonb) to anon, authenticated;
grant execute on function public.flexcon_delete_purchase_statement_master(text, uuid) to anon, authenticated;
grant execute on function public.flexcon_list_purchase_inventory_master(text) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_inventory_master(text, uuid, text, uuid, uuid, text[]) to anon, authenticated;
grant execute on function public.flexcon_save_purchase_inventory_master_group(text, jsonb) to anon, authenticated;
grant execute on function public.flexcon_delete_purchase_inventory_master(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
