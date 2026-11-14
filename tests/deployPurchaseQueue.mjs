import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const output = path.resolve(process.argv[2] || '../../artifacts/purchase-statement-queue')
fs.mkdirSync(output, { recursive: true })
const migration = fs.readFileSync('supabase/migrations/202611140001_purchase_statement_queue.sql', 'utf8').replace(/^begin;\s*/, '').replace(/commit;\s*$/, '')
const audit = (mode) => `do $guard$ declare r record; v_hash text; begin
  for r in ${mode === 'before' ? "select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','business_private') and c.relkind='r'" : 'select * from queue_before'} loop
    execute format('lock table %I.%I in share mode',r.nspname,r.relname);
    execute format('select md5(coalesce(string_agg(j,E''\\n'' order by j),'''')) from (select to_jsonb(t)::text j from %I.%I t) s',r.nspname,r.relname) into v_hash;
    ${mode === 'before' ? 'insert into queue_before values(r.nspname,r.relname,v_hash);' : "if v_hash is distinct from r.digest then raise exception 'Existing data changed: %.%',r.nspname,r.relname; end if;"}
  end loop;
end $guard$;`
fs.writeFileSync(path.join(output, 'deploy-guarded.sql'), `begin;\ncreate temp table queue_before(nspname text,relname text,digest text) on commit drop;\n${audit('before')}\n${migration}\n${audit('after')}\nselect 'Queue installed; existing business data unchanged' result,count(*) existing_tables_checked from queue_before;\ncommit;\n`)
// Flatten the local dependency for the dashboard editor, preserving every OCR rule verbatim.
const engine = fs.readFileSync('supabase/functions/analyze-purchase-statement/index.ts', 'utf8').split('if (import.meta.main) Deno.serve')[0]
const worker = fs.readFileSync('supabase/functions/purchase-statement-queue/index.ts', 'utf8').replace(/^import .*\r?\n/, '')
fs.writeFileSync(path.join(output, 'queue-function.ts'), engine + '\n' + worker)
const config = { window: {} }
vm.runInNewContext(fs.readFileSync('../garlic-liff-scanner/shared/business-config.js', 'utf8'), config)
const { url, key } = config.window.BusinessConfig
if (url !== 'https://gkazhcddknmgzglcdwtk.supabase.co' || !/^eyJ[A-Za-z0-9_.-]+$/.test(key)) throw new Error('Expected the existing public project anon JWT')
const scheduler = fs.readFileSync('supabase/deploy-purchase-queue-scheduler.sql', 'utf8')
fs.writeFileSync(path.join(output, 'deploy-scheduler.sql'), scheduler.replace('begin;', `begin;\nupdate flexcon_queue_private.settings set gateway_key='${key}' where singleton;`))
console.log(output)
