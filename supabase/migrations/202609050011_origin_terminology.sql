-- データ構造を維持したまま、利用者向けのエラー表記を「産地」に統一します。
begin;

do $migration$
declare
  v_function record;
  v_definition text;
begin
  for v_function in
    select procedure_record.oid
    from pg_proc as procedure_record
    join pg_namespace as namespace_record
      on namespace_record.oid = procedure_record.pronamespace
    where namespace_record.nspname = 'public'
      and procedure_record.proname like 'flexcon_%'
      and pg_get_functiondef(procedure_record.oid) like '%県名%'
  loop
    v_definition := pg_get_functiondef(v_function.oid);
    execute replace(v_definition, '県名', '産地');
  end loop;
end;
$migration$;

commit;
