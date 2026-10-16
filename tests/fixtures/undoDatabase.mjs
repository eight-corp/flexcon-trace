import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { undoDeploymentSql } from './undoDeployment.mjs'

export async function undoDatabase() {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema storage; create schema extensions; create schema business_private;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table workers(worker_id text primary key, worker_name text, active boolean default true, role text default 'operator', display_order integer default 0, note text default '');
      create table business_private.apps(app_id text primary key, app_name text, migrated boolean, display_order integer);
      create table business_private.users(worker_id text primary key, enabled boolean default true, system_admin boolean default false);
      create table business_private.permissions(worker_id text, app_id text, role text, primary key(worker_id,app_id));
      create table business_private.sessions(token_hash text primary key, worker_id text, expires_at timestamptz, bootstrap boolean);
      create function business_private.actor(p_bootstrap boolean default false) returns text language sql as $$ select nullif(current_setting('fixture.actor',true),''); $$;
      create function business_private.require_app(p_app text, p_role text, p_worker text) returns void language plpgsql as $$
      declare v_role text; begin
        if business_private.actor() is distinct from p_worker then raise exception 'unauthorized actor'; end if;
        select case when u.system_admin then 'admin' else p.role end into v_role from business_private.users u
          join workers w using(worker_id) left join business_private.permissions p on p.worker_id=u.worker_id and p.app_id=p_app
          where u.worker_id=p_worker and u.enabled and w.active;
        if v_role is null or (p_role='operator' and v_role='viewer') or (p_role='admin' and v_role<>'admin') then raise exception 'unauthorized role'; end if;
      end; $$;
      insert into workers(worker_id,worker_name,role) values ('tester','Tester','operator'),('other','Other','operator'),('admin','Admin','admin'),('viewer','Viewer','viewer');
      insert into business_private.users(worker_id,system_admin) select worker_id,role='admin' from workers;
      insert into business_private.permissions select worker_id,app,role from workers cross join unnest(array['rice_shipping','purchase_statements']) app;
    `)
    for (const file of fs.readdirSync('supabase/migrations').sort()) {
      if (file < '202609010001' || file >= '202610160001') continue
      const sql = fs.readFileSync(`supabase/migrations/${file}`, 'utf8').replace('create extension if not exists pgcrypto;', '')
      try { await db.exec(sql) } catch (error) { throw new Error(`${file}: ${error.message}`, { cause: error }) }
    }
    await db.exec(`create or replace function business_private.actor(p_bootstrap boolean default false) returns text language sql as $$ select nullif(current_setting('fixture.actor',true),''); $$;`)
    await db.exec(undoDeploymentSql(fs.readFileSync('supabase/migrations/202610160001_operator_undo.sql', 'utf8')))
    const rpc = (actor, name, args = {}) => db.transaction(async tx => {
      await tx.query("select set_config('fixture.actor',$1,true)", [actor])
      const entries = Object.entries(args)
      const result = await tx.query(`select public.${name}(${entries.map(([key], index) => `${key} => $${index + 1}`).join(',')}) as result`, entries.map(([, value]) => value !== null && typeof value === 'object' ? JSON.stringify(value) : value))
      return result.rows[0].result
    })
    return { db, rpc }
  } catch (error) { await db.close(); throw error }
}
