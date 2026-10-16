export function undoDeploymentSql(migration) {
  if (!/^begin;\s/.test(migration) || !/commit;\s*$/.test(migration)) throw new Error('Expected a standalone migration transaction')
  const body = migration.replace(/^begin;\s*/, '').replace(/commit;\s*$/, '')
  return `begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create temporary table undo_business_before(table_name text primary key, row_count bigint, fingerprint text) on commit drop;
alter table undo_business_before enable row level security;
do $verify$
declare t record; v_count bigint; v_hash text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and starts_with(c.relname,'flexcon_') order by c.relname loop
    execute format('lock table public.%I in share row exclusive mode', t.relname);
    execute format('select count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '''' order by md5(to_jsonb(t)::text)), '''')) from public.%I t', t.relname) into v_count,v_hash;
    insert into undo_business_before values(t.relname,v_count,v_hash);
  end loop;
end; $verify$;
${body}
do $verify$
declare t record; v_count bigint; v_hash text;
begin
  for t in select * from undo_business_before loop
    execute format('select count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '''' order by md5(to_jsonb(t)::text)), '''')) from public.%I t', t.table_name) into v_count,v_hash;
    if v_count is distinct from t.row_count or v_hash is distinct from t.fingerprint then
      raise exception 'Business data changed during undo installation: %', t.table_name;
    end if;
  end loop;
end; $verify$;
commit;
select true as business_data_unchanged,
  (select count(*) from flexcon_undo_private.tables) as audited_tables,
  (select count(*) from flexcon_undo_private.rpcs) as audited_rpcs,
  (select count(*) from pg_trigger where tgrelid in (select format('public.%I',table_name)::regclass from flexcon_undo_private.tables) and tgenabled='D') as disabled_triggers,
  has_function_privilege('anon','public.flexcon_undo_last_operation(text,uuid)','execute') as undo_rpc_ready;
`
}
