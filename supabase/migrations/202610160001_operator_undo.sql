begin;

create schema if not exists flexcon_undo_private;
revoke all on schema flexcon_undo_private from public, anon, authenticated;

create table if not exists flexcon_undo_private.operations (
  id uuid primary key default gen_random_uuid(), worker_id text not null,
  app_id text not null, required_role text not null, action_name text not null,
  created_at timestamptz not null default clock_timestamp(), undone_at timestamptz
);
create table if not exists flexcon_undo_private.heads (
  worker_id text primary key, operation_id uuid references flexcon_undo_private.operations
);
create table if not exists flexcon_undo_private.events (
  event_no bigint generated always as identity primary key,
  operation_id uuid not null references flexcon_undo_private.operations on delete cascade,
  table_name text not null, before_row jsonb, after_row jsonb
);
create index if not exists undo_events_operation on flexcon_undo_private.events(operation_id, event_no);
create table if not exists flexcon_undo_private.resources (
  resource_key text primary key, token uuid not null
);
create table if not exists flexcon_undo_private.operation_resources (
  operation_id uuid not null references flexcon_undo_private.operations on delete cascade,
  resource_key text not null, primary key(operation_id, resource_key)
);
create table if not exists flexcon_undo_private.tables (
  table_name text primary key, pk_columns text[] not null, foreign_keys jsonb not null
);
create table if not exists flexcon_undo_private.rpcs (
  function_name text not null, argument_types text not null, implementation_name text not null,
  app_id text not null, primary key(function_name, argument_types)
);

alter table flexcon_undo_private.operations enable row level security;
alter table flexcon_undo_private.heads enable row level security;
alter table flexcon_undo_private.events enable row level security;
alter table flexcon_undo_private.resources enable row level security;
alter table flexcon_undo_private.operation_resources enable row level security;
alter table flexcon_undo_private.tables enable row level security;
alter table flexcon_undo_private.rpcs enable row level security;

create or replace function flexcon_undo_private.comparable(p_row jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select p_row - 'updated_at' - 'updated_by_worker_id';
$$;

create or replace function flexcon_undo_private.row_key(p_table text, p_row jsonb)
returns jsonb language sql stable set search_path = pg_catalog, flexcon_undo_private as $$
  select jsonb_object_agg(key, p_row->key) from unnest((
    select pk_columns from flexcon_undo_private.tables where table_name = p_table
  )) key;
$$;

create or replace function flexcon_undo_private.prepare(p_worker_id text, p_function text, p_app text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public, flexcon_undo_private as $$
declare v_id uuid; v_role text;
begin
  if nullif(current_setting('flexcon_undo.operation', true), '') is not null then
    if current_setting('flexcon_undo.worker', true) is distinct from p_worker_id then raise exception '操作者が一致しません。'; end if;
    return false;
  end if;
  -- All writers take this lock before business row locks; undo sees a stable committed state.
  perform pg_advisory_xact_lock(19661016, 1);
  perform business_private.require_app(p_app, 'operator', p_worker_id);
  select case when u.system_admin or p.role = 'admin' then 'admin' else 'operator' end into v_role
    from business_private.users u left join business_private.permissions p
      on p.worker_id = u.worker_id and p.app_id = p_app where u.worker_id = p_worker_id;
  if v_role is null then raise exception 'ログイン情報を確認できません。'; end if;
  insert into flexcon_undo_private.operations(worker_id, app_id, required_role, action_name)
    values(p_worker_id, p_app, v_role, p_function) returning id into v_id;
  perform set_config('flexcon_undo.operation', v_id::text, true);
  perform set_config('flexcon_undo.worker', p_worker_id, true);
  return true;
end; $$;

create or replace function flexcon_undo_private.finish()
returns void language plpgsql security definer set search_path = pg_catalog, flexcon_undo_private as $$
declare v_id uuid := nullif(current_setting('flexcon_undo.operation', true), '')::uuid;
begin
  if exists(select 1 from flexcon_undo_private.events where operation_id = v_id) then
    insert into flexcon_undo_private.heads(worker_id, operation_id)
      select worker_id, id from flexcon_undo_private.operations where id = v_id
      on conflict(worker_id) do update set operation_id = excluded.operation_id;
    delete from flexcon_undo_private.operations where worker_id = current_setting('flexcon_undo.worker', true) and id <> v_id;
    delete from flexcon_undo_private.resources r where not exists
      (select 1 from flexcon_undo_private.operation_resources used where used.resource_key = r.resource_key);
  else
    delete from flexcon_undo_private.operations where id = v_id;
  end if;
  perform set_config('flexcon_undo.operation', '', true);
  perform set_config('flexcon_undo.worker', '', true);
end; $$;

create or replace function flexcon_undo_private.capture()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, flexcon_undo_private as $$
declare
  v_before jsonb; v_after jsonb; v_row jsonb; v_fk jsonb; v_key jsonb;
  v_id uuid := nullif(current_setting('flexcon_undo.operation', true), '')::uuid;
  v_token uuid; v_resource text; v_keys text[] := '{}'; v_lot text;
begin
  if current_setting('flexcon_undo.replaying', true) = 'on' then return null; end if;
  if tg_op <> 'INSERT' then v_before := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_after := to_jsonb(new); end if;
  if flexcon_undo_private.comparable(v_before) is not distinct from flexcon_undo_private.comparable(v_after) then return null; end if;
  perform pg_advisory_xact_lock(19661016, 1);
  v_token := coalesce(v_id, gen_random_uuid());
  if v_id is not null then
    insert into flexcon_undo_private.events(operation_id, table_name, before_row, after_row)
      values(v_id, tg_table_name, v_before, v_after);
  end if;
  foreach v_row in array array[v_before, v_after] loop
    if v_row is null then continue; end if;
    v_keys := array_append(v_keys, 'row:' || tg_table_name || ':' || flexcon_undo_private.row_key(tg_table_name, v_row)::text);
    if v_row->>'authorization_id' is not null then v_keys := array_append(v_keys, 'authorization:' || (v_row->>'authorization_id')); end if;
    if tg_table_name = 'flexcon_authorizations' then v_keys := array_append(v_keys, 'authorization:' || (v_row->>'id')); end if;
    v_lot := v_row->>'lot_number';
    if nullif(v_lot, '') is not null then
      v_keys := array_append(v_keys, 'lot:' || v_lot);
      if v_lot ~ '^[0-9]{6,11}$' then
        v_keys := array_append(v_keys, 'lot-legacy:' || ltrim(right(v_lot, 7), '0'));
      end if;
    end if;
    for v_fk in select value from jsonb_array_elements((select foreign_keys from flexcon_undo_private.tables where table_name = tg_table_name)) loop
      select jsonb_object_agg(pair->>'parent', v_row->(pair->>'child')) into v_key from jsonb_array_elements(v_fk->'columns') pair;
      if not exists(select 1 from jsonb_each(v_key) where value = 'null'::jsonb) then
        v_keys := array_append(v_keys, 'row:' || (v_fk->>'table') || ':' || v_key::text);
      end if;
    end loop;
  end loop;
  -- Stock-consuming actions can depend on quantities without an explicit foreign key.
  if tg_table_name in ('flexcon_inventory_movements', 'flexcon_purchase_statement_lines', 'flexcon_purchase_import_batches',
      'flexcon_shipments', 'flexcon_shipment_items', 'flexcon_manual_shipment_items', 'flexcon_flexcons',
      'flexcon_mixed_flexcons', 'flexcon_mixed_flexcon_members', 'flexcon_inspection_weights', 'flexcon_inspection_options')
    or (tg_table_name in ('flexcon_inspection_flexcons', 'flexcon_inspection_paper_bags') and (
      tg_op <> 'UPDATE' or (v_before - array['inspection_date','inspector_name','inspection_location','moisture','moisture_values','reason','certificate_last_printed_at','certificate_print_count','certificate_last_printed_by_worker_id','updated_at','updated_by_worker_id'])
        is distinct from (v_after - array['inspection_date','inspector_name','inspection_location','moisture','moisture_values','reason','certificate_last_printed_at','certificate_print_count','certificate_last_printed_by_worker_id','updated_at','updated_by_worker_id'])
    )) then v_keys := array_append(v_keys, 'inventory:shared'); end if;
  for v_resource in select distinct unnest(v_keys) loop
    insert into flexcon_undo_private.resources values(v_resource, v_token)
      on conflict(resource_key) do update set token = excluded.token;
    if v_id is not null then insert into flexcon_undo_private.operation_resources values(v_id, v_resource) on conflict do nothing; end if;
  end loop;
  return null;
end; $$;

create or replace function public.flexcon_get_undo_status(p_worker_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, flexcon_undo_private as $$
declare v_op flexcon_undo_private.operations; v_blocked boolean;
begin
  if business_private.actor() is distinct from p_worker_id then raise exception 'ログイン情報を確認できません。'; end if;
  select op.* into v_op from flexcon_undo_private.heads h join flexcon_undo_private.operations op on op.id = h.operation_id
    where h.worker_id = p_worker_id and op.undone_at is null;
  if not found then return jsonb_build_object('available', false, 'reason', '取り消せる操作はありません。'); end if;
  perform business_private.require_app(v_op.app_id, v_op.required_role, p_worker_id);
  select exists(select 1 from flexcon_undo_private.operation_resources r
    left join flexcon_undo_private.resources latest using(resource_key)
    where r.operation_id = v_op.id and latest.token is distinct from v_op.id) into v_blocked;
  return jsonb_build_object('available', not v_blocked, 'operationId', v_op.id, 'action', v_op.action_name,
    'createdAt', v_op.created_at, 'appId', v_op.app_id,
    'reason', case when v_blocked then '関連データが後から変更・使用されているため取り消せません。' else null end);
end; $$;

create or replace function public.flexcon_undo_last_operation(p_worker_id text, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, flexcon_undo_private as $$
declare
  v_status jsonb; v_event record; v_key jsonb; v_current jsonb;
  v_columns text; v_assignments text; v_where text; v_count integer; v_total integer := 0;
begin
  perform pg_advisory_xact_lock(19661016, 1);
  v_status := public.flexcon_get_undo_status(p_worker_id);
  if not coalesce((v_status->>'available')::boolean, false) then raise exception '%', v_status->>'reason'; end if;
  if (v_status->>'operationId')::uuid is distinct from p_operation_id then raise exception '直前の操作が変わりました。もう一度取り消す操作を確認してください。'; end if;
  perform set_config('flexcon_undo.replaying', 'on', true);
  set constraints all deferred;
  for v_event in select * from flexcon_undo_private.events where operation_id = p_operation_id order by event_no desc loop
    v_key := flexcon_undo_private.row_key(v_event.table_name, coalesce(v_event.after_row, v_event.before_row));
    select string_agg(format('t.%1$I = r.%1$I', key), ' and ') into v_where
      from unnest((select pk_columns from flexcon_undo_private.tables where table_name = v_event.table_name)) key;
    execute format('select to_jsonb(t) from public.%1$I t, jsonb_populate_record(null::public.%1$I, $1) r where %2$s for update of t', v_event.table_name, v_where) into v_current using v_key;
    if flexcon_undo_private.comparable(v_current) is distinct from flexcon_undo_private.comparable(v_event.after_row) then
      raise exception '対象データが変更されているため取り消せません。';
    end if;
    if v_event.before_row is null then
      execute format('delete from public.%1$I t using jsonb_populate_record(null::public.%1$I, $1) r where %2$s', v_event.table_name, v_where) using v_key;
    else
      select string_agg(format('%I', a.attname), ',' order by a.attnum),
        string_agg(format('%1$I = r.%1$I', a.attname), ',' order by a.attnum) filter(where a.attidentity = '')
        into v_columns, v_assignments from pg_attribute a
        where a.attrelid = format('public.%I', v_event.table_name)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
      if v_event.after_row is null then
        execute format('insert into public.%1$I (%2$s) overriding system value select %2$s from jsonb_populate_record(null::public.%1$I, $1)', v_event.table_name, v_columns) using v_event.before_row;
      else
        if flexcon_undo_private.row_key(v_event.table_name, v_event.before_row) is distinct from v_key then raise exception '識別番号が変更された操作は取り消せません。'; end if;
        execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I, $1) r where %3$s', v_event.table_name, v_assignments, v_where) using v_event.before_row;
      end if;
    end if;
    get diagnostics v_count = row_count;
    if v_count <> 1 then raise exception '対象件数が一致しないため取り消しを中止しました。'; end if;
    v_total := v_total + 1;
    execute format('select to_jsonb(t) from public.%1$I t, jsonb_populate_record(null::public.%1$I, $1) r where %2$s', v_event.table_name, v_where) into v_current
      using flexcon_undo_private.row_key(v_event.table_name, coalesce(v_event.before_row, v_event.after_row));
    if flexcon_undo_private.comparable(v_current) is distinct from flexcon_undo_private.comparable(v_event.before_row) then raise exception '復元結果が一致しないため取り消しを中止しました。'; end if;
  end loop;
  set constraints all immediate;
  update flexcon_undo_private.resources set token = gen_random_uuid() where resource_key in
    (select resource_key from flexcon_undo_private.operation_resources where operation_id = p_operation_id);
  update flexcon_undo_private.operations set undone_at = clock_timestamp() where id = p_operation_id;
  update flexcon_undo_private.heads set operation_id = null where worker_id = p_worker_id;
  perform set_config('flexcon_undo.replaying', '', true);
  return jsonb_build_object('ok', true, 'changes', v_total);
end; $$;

-- Image uploads finish the same save operation, instead of consuming its single undo slot.
create or replace function public.flexcon_attach_purchase_statement_image(p_worker_id text, p_statement_id uuid, p_image_path text)
returns void language plpgsql security definer set search_path = pg_catalog, public, flexcon_undo_private as $$
declare v_status jsonb; v_table text; v_reader text; v_confirmed timestamptz; v_path text; v_separate boolean := false;
begin
  perform pg_advisory_xact_lock(19661016, 1);
  perform business_private.require_app('purchase_statements', 'operator', p_worker_id);
  if p_image_path is null or p_image_path !~ ('^' || p_statement_id::text || '/[0-9a-f-]{36}\.jpg$') then raise exception '画像パスが不正です。'; end if;
  select image_path into v_path from public.flexcon_purchase_statements where id = p_statement_id for update;
  if found then v_table := 'flexcon_purchase_statements';
  else
    select created_by_worker_id, confirmed_at, image_path into v_reader, v_confirmed, v_path
      from public.flexcon_purchase_statement_drafts where id = p_statement_id for update;
    if not found or v_reader <> p_worker_id or v_confirmed is not null then raise exception 'この確認待ち画像は変更できません。'; end if;
    v_table := 'flexcon_purchase_statement_drafts';
    if nullif(v_path, '') is not null then return; end if;
  end if;
  v_status := public.flexcon_get_undo_status(p_worker_id);
  if not coalesce((v_status->>'available')::boolean, false)
    or not exists(select 1 from flexcon_undo_private.events where operation_id = (v_status->>'operationId')::uuid
      and table_name = v_table and after_row->>'id' = p_statement_id::text)
    or v_status->>'action' not in ('flexcon_submit_purchase_statement','flexcon_save_purchase_statement') then
    v_separate := flexcon_undo_private.prepare(p_worker_id, 'flexcon_attach_purchase_statement_image', 'purchase_statements');
  else
    perform set_config('flexcon_undo.operation', v_status->>'operationId', true);
    perform set_config('flexcon_undo.worker', p_worker_id, true);
  end if;
  execute format('update public.%I set image_path = $1, updated_at = clock_timestamp() where id = $2', v_table) using p_image_path, p_statement_id;
  if v_separate then perform flexcon_undo_private.finish();
  else
    perform set_config('flexcon_undo.operation', '', true);
    perform set_config('flexcon_undo.worker', '', true);
  end if;
end; $$;

-- Discover primary/foreign keys, including composite shipment keys. Audit archives stay append-only.
do $install$
declare t record; f record; v_pk text[]; v_fk jsonb; v_impl text; v_types text; v_args text; v_app text; v_body text; v_source text;
begin
  for t in select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and starts_with(c.relname, 'flexcon_') and c.relname <> 'flexcon_inspection_deletion_archives' loop
    select array_agg(a.attname::text order by k.ordinality) into v_pk from pg_index i,
      unnest(i.indkey::smallint[]) with ordinality k(attnum, ordinality) join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
      where i.indrelid = t.oid and i.indisprimary;
    if v_pk is null then raise exception 'Undo対象テーブルに主キーがありません: %', t.relname; end if;
    select coalesce(jsonb_agg(jsonb_build_object('table', parent.relname, 'columns', (
      select jsonb_agg(jsonb_build_object('child', ca.attname, 'parent', pa.attname) order by k.ordinality)
        from unnest(fk.conkey, fk.confkey) with ordinality k(child, parent, ordinality)
        join pg_attribute ca on ca.attrelid = t.oid and ca.attnum = k.child
        join pg_attribute pa on pa.attrelid = parent.oid and pa.attnum = k.parent
    ))), '[]'::jsonb) into v_fk from pg_constraint fk join pg_class parent on parent.oid = fk.confrelid
      where fk.contype = 'f' and fk.conrelid = t.oid and starts_with(parent.relname, 'flexcon_');
    insert into flexcon_undo_private.tables values(t.relname, v_pk, v_fk) on conflict(table_name) do update set pk_columns = excluded.pk_columns, foreign_keys = excluded.foreign_keys;
    execute format('drop trigger if exists zzzz_capture_undo on public.%I', t.relname);
    execute format('create trigger zzzz_capture_undo after insert or update or delete on public.%I for each row execute function flexcon_undo_private.capture()', t.relname);
    -- Normal writes still check FKs immediately. Undo checks them after the entire inverse transaction.
    for f in select conname from pg_constraint where conrelid = t.oid and contype = 'f' and not condeferrable loop
      execute format('alter table public.%I alter constraint %I deferrable initially immediate', t.relname, f.conname);
    end loop;
  end loop;

  -- Keep validation and FK triggers enabled; suppress only derived-value side effects during replay.
  for f in select p.oid, p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prorettype = 'trigger'::regtype and p.proname in (
      'flexcon_set_inspection_moisture_average','flexcon_set_inspection_total_quantity',
      'flexcon_assign_inspection_option_order','flexcon_assign_destination_order','flexcon_assign_transport_profile_order',
      'flexcon_assign_shipment_item_product','flexcon_assign_shipment_item_inspection','flexcon_refresh_shipment_product_summary',
      'flexcon_clear_mixed_purchase_date','flexcon_initialize_detail_inventory_metadata'
    ) loop
    if position('flexcon_undo.replaying' in f.prosrc) > 0 then continue; end if;
    v_source := format('begin if current_setting(''flexcon_undo.replaying'', true) = ''on'' then if tg_op = ''DELETE'' then return old; else return new; end if; end if; %s end;', f.prosrc);
    v_body := pg_get_functiondef(f.oid);
    if position('$function$' || f.prosrc || '$function$' in v_body) = 0 then raise exception 'Trigger definition cannot be wrapped: %', f.proname; end if;
    v_body := replace(v_body, '$function$' || f.prosrc || '$function$', quote_literal(v_source));
    execute v_body;
  end loop;

  for f in select p.*, pg_get_function_arguments(p.oid) args, pg_get_function_result(p.oid) result
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname ~ '^flexcon_(add|update|delete|set|save|register|import|append|split|mark|bulk|reorder|confirm|submit)_'
      and 'p_worker_id' = any(p.proargnames) and not p.proretset and p.prorettype <> 'trigger'::regtype
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      and p.proname not like '%_internal' loop
    v_types := oidvectortypes(f.proargtypes);
    if exists(select 1 from flexcon_undo_private.rpcs where function_name = f.proname and argument_types = v_types) then continue; end if;
    v_impl := '_flexcon_undo_impl_' || f.oid::text;
    v_args := array_to_string(array(select format('%I', arg) from unnest(f.proargnames) arg), ', ');
    v_app := case when f.proname in (
      'flexcon_submit_purchase_statement','flexcon_confirm_purchase_statement','flexcon_delete_pending_purchase_statement',
      'flexcon_save_purchase_statement','flexcon_delete_purchase_statement','flexcon_save_purchase_statement_master',
      'flexcon_reorder_purchase_statement_master','flexcon_save_purchase_statement_master_group','flexcon_delete_purchase_statement_master',
      'flexcon_save_purchase_inventory_master','flexcon_save_purchase_inventory_master_group','flexcon_delete_purchase_inventory_master'
    ) then 'purchase_statements' else 'rice_shipping' end;
    execute format('alter function public.%I(%s) rename to %I', f.proname, v_types, v_impl);
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', v_impl, v_types);
    v_body := format('declare v_root boolean; %s begin v_root := flexcon_undo_private.prepare(p_worker_id, %L, %L); %s public.%I(%s); if v_root then perform flexcon_undo_private.finish(); end if; %s end;',
      case when f.result = 'void' then '' else 'v_result ' || f.result || ';' end,
      f.proname, v_app, case when f.result = 'void' then 'perform' else 'v_result :=' end,
      v_impl, v_args, case when f.result = 'void' then 'return;' else 'return v_result;' end);
    execute format('create function public.%I(%s) returns %s language plpgsql security definer set search_path = pg_catalog, public as %L', f.proname, f.args, f.result, v_body);
    execute format('revoke all on function public.%I(%s) from public', f.proname, v_types);
    execute format('grant execute on function public.%I(%s) to anon, authenticated', f.proname, v_types);
    insert into flexcon_undo_private.rpcs values(f.proname, v_types, v_impl, v_app);
  end loop;
end;
$install$;

revoke all on all tables in schema flexcon_undo_private from public, anon, authenticated;
revoke all on all sequences in schema flexcon_undo_private from public, anon, authenticated;
revoke all on all functions in schema flexcon_undo_private from public, anon, authenticated;
revoke all on function public.flexcon_get_undo_status(text) from public;
revoke all on function public.flexcon_undo_last_operation(text,uuid) from public;
revoke all on function public.flexcon_attach_purchase_statement_image(text,uuid,text) from public;
grant execute on function public.flexcon_get_undo_status(text) to anon, authenticated;
grant execute on function public.flexcon_undo_last_operation(text,uuid) to anon, authenticated;
grant execute on function public.flexcon_attach_purchase_statement_image(text,uuid,text) to anon, authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.flexcon_attach_purchase_statement_image(text,uuid,text) to service_role;
  end if;
end; $$;
notify pgrst, 'reload schema';
commit;
