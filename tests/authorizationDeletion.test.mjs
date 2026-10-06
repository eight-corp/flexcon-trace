import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('authorization deletion protects inspection records and checks worker access', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create table flexcon_authorizations(id uuid primary key);
      create function flexcon_require_active_worker(worker_id text) returns void language plpgsql as $$
      begin
        if worker_id is distinct from 'tester' then raise exception 'unauthorized'; end if;
      end;
      $$;
      create table flexcon_inspection_registrations(id integer primary key, authorization_id uuid references flexcon_authorizations on delete cascade);
      create table flexcon_inspection_flexcons(id integer primary key, record_kind text, authorization_id uuid references flexcon_authorizations on delete cascade);
      create table flexcon_inspection_paper_bags(id integer primary key, authorization_id uuid references flexcon_authorizations on delete cascade);
      create table related_record(authorization_id uuid references flexcon_authorizations);
      insert into flexcon_authorizations select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1,6) n;
      insert into flexcon_inspection_flexcons values (1,'standard','00000000-0000-0000-0000-000000000002'),(2,'bulk','00000000-0000-0000-0000-000000000003');
      insert into flexcon_inspection_paper_bags values (1,'00000000-0000-0000-0000-000000000004');
      insert into flexcon_inspection_registrations values (1,'00000000-0000-0000-0000-000000000005');
      insert into related_record values ('00000000-0000-0000-0000-000000000006');
    `)
    await db.exec(fs.readFileSync('supabase/migrations/202610060001_safe_authorization_deletion.sql', 'utf8'))
    const remove = (number, worker = 'tester') => db.query('select flexcon_delete_authorization($1,$2)', [worker, `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`])
    await assert.rejects(remove(1, 'inactive'), /unauthorized/)
    await assert.rejects(remove(1, null), /unauthorized/)
    for (const number of [2, 3, 4, 5]) await assert.rejects(remove(number), /検査記録がある委任状は削除できません/)
    await assert.rejects(remove(6), /関連する記録がある委任状は削除できません/)
    assert.equal((await db.query('select count(*)::int as count from flexcon_authorizations')).rows[0].count, 6)
    assert.equal((await db.query('select count(*)::int as count from flexcon_inspection_flexcons')).rows[0].count, 2)
    assert.equal((await db.query('select count(*)::int as count from flexcon_inspection_paper_bags')).rows[0].count, 1)
    assert.equal((await db.query('select count(*)::int as count from flexcon_inspection_registrations')).rows[0].count, 1)
    await remove(1)
    assert.equal((await db.query('select count(*)::int as count from flexcon_authorizations')).rows[0].count, 5)
    await assert.rejects(remove(1), /委任状情報が見つかりません/)
  } finally {
    await db.close()
  }
})
