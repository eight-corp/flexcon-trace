import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const migration = fs.readFileSync('supabase/migrations/202610150001_inspection_date_deletion.sql', 'utf8')
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
export async function deletionDatabase() {
  const db = new PGlite()
  await db.exec(fs.readFileSync('tests/fixtures/inspectionDatabase.sql', 'utf8'))
  for (const [file, name] of [
    ['202609070007_inspection_registration_summary.sql', 'flexcon_split_inspection_paper_bags'],
    ['202609080002_separate_standard_bulk_numbers.sql', 'flexcon_save_inspection_flexcon'],
    ['202609050010_inspection_officers.sql', 'flexcon_save_inspection_paper_bags'],
  ]) {
    const sql = fs.readFileSync(`supabase/migrations/${file}`, 'utf8')
    const start = sql.indexOf(`create or replace function public.${name}(`)
    await db.exec(sql.slice(start, sql.indexOf('$$;', start) + 3))
  }
  await db.exec(fs.readFileSync('supabase/migrations/202609290001_consolidate_inspection_authorizations.sql', 'utf8'))
  await db.exec(`create table flexcon_flexcons(id uuid primary key default gen_random_uuid(),lot_number text unique,status text default 'available');
    create table flexcon_shipment_items(lot_number text);
    alter table flexcon_inspection_flexcons add column certificate_print_count integer default 0;
    update flexcon_inspection_flexcons set inspection_date='2026-10-14', certificate_print_count=3 where flexcon_no=1;
    update flexcon_inspection_flexcons set inspection_date='2026-10-15' where flexcon_no=2;
    update flexcon_inspection_paper_bags set inspection_date='2026-10-15';
    insert into flexcon_flexcons(lot_number) select lot_number from flexcon_inspection_flexcons;
    insert into flexcon_inspection_flexcons(registration_id,authorization_id,fiscal_year,purchase_date,inspection_date,record_kind,flexcon_no,lot_number,brand,quantity_kg,created_by_worker_id)
      values ('${uuid(21)}','${uuid(1)}',8,'2026-10-15','2026-10-15','bulk',3,'20260001003','Rice',125,'tester');
    insert into flexcon_inspection_flexcons(registration_id,authorization_id,fiscal_year,purchase_date,inspection_date,record_kind,flexcon_no,lot_number,brand,quantity_kg,created_by_worker_id)
      values ('${uuid(21)}','${uuid(1)}',8,'2026-10-15',null,'standard',4,'20260001004','Rice',1020,'tester');`)
  await db.exec(migration)
  return db
}
export async function dateIds(db, date) {
  return {
    flexcons: (await db.query('select id from flexcon_inspection_flexcons where registration_id=$1 and inspection_date is not distinct from $2::date order by id', [uuid(21), date])).rows.map(r => r.id),
    papers: (await db.query('select id from flexcon_inspection_paper_bags where registration_id=$1 and inspection_date is not distinct from $2::date order by id', [uuid(21), date])).rows.map(r => r.id),
  }
}
const remove = async (db, date, ids, worker = 'tester', registration = uuid(21)) => db.query('select flexcon_delete_inspection_registration_date($1,$2::uuid,$3::date,$4::uuid[],$5::uuid[])', [worker, registration, date, ids.flexcons, ids.papers])
const snapshot = async db => {
  const result = {}
  for (const table of ['flexcon_inspection_registrations','flexcon_inspection_flexcons','flexcon_inspection_paper_bags','flexcon_flexcons','flexcon_inspection_deletion_archives','flexcon_inventory_balances']) result[table] = (await db.query(`select * from ${table} order by 1`)).rows
  return result
}

test('inspection list deletion removes only the selected date and archives exact details', async () => {
  const db = await deletionDatabase()
  try {
    const before = await snapshot(db)
    const ids = await dateIds(db, '2026-10-15')
    await remove(db, '2026-10-15', ids)
    const after = await snapshot(db)
    assert.deepEqual(after.flexcon_inspection_registrations, before.flexcon_inspection_registrations)
    assert.deepEqual(after.flexcon_inspection_flexcons, before.flexcon_inspection_flexcons.filter(r => !ids.flexcons.includes(r.id)))
    assert.equal(after.flexcon_inspection_paper_bags.length, 0)
    assert.deepEqual(after.flexcon_flexcons, before.flexcon_flexcons.filter(r => r.lot_number !== '20260001002'))
    const archive = after.flexcon_inspection_deletion_archives[0]
    assert.equal(archive.inspection_date.toISOString().slice(0, 10), '2026-10-15')
    assert.equal(archive.deleted_by_worker_id, 'tester')
    assert.deepEqual(archive.snapshot.flexcons.map(r => r.id).sort(), ids.flexcons)
    assert.deepEqual(archive.snapshot.paper_bags.map(r => r.id).sort(), ids.papers)
    assert.deepEqual(archive.snapshot.lot_records.map(r => r.lot_number), ['20260001002'])
    assert.equal(after.flexcon_inspection_flexcons.find(r => r.flexcon_no === 1).certificate_print_count, 3)
    const balanceUnits = after.flexcon_inventory_balances.map(r => r.unit)
    assert.ok(balanceUnits.includes('本'))
    assert.ok(!balanceUnits.includes('kg') && !balanceUnits.includes('袋'))
    await db.exec(migration)
    assert.deepEqual(await snapshot(db), after)
    const remaining = await dateIds(db, null)
    await remove(db, null, remaining)
    assert.equal((await db.query('select count(*)::int n from flexcon_inspection_flexcons')).rows[0].n, 1)
    await remove(db, '2026-10-14', await dateIds(db, '2026-10-14'))
    assert.equal((await db.query('select count(*)::int n from flexcon_inspection_flexcons')).rows[0].n, 0)
    assert.equal((await db.query('select count(*)::int n from flexcon_inspection_registrations')).rows[0].n, 1)
  } finally { await db.close() }
})

test('stale, mixed-date, foreign, empty and old-client delete requests cannot delete any records', async () => {
  const db = await deletionDatabase()
  try {
    const ids = await dateIds(db, '2026-10-15')
    const before = await snapshot(db)
    for (const operation of [
      () => remove(db, '2026-10-15', ids, 'intruder'),
      () => remove(db, '2026-10-15', ids, 'tester', uuid(22)),
      () => remove(db, '2026-10-14', ids),
      () => remove(db, null, ids),
      () => remove(db, '2026-10-15', { ...ids, flexcons: ids.flexcons.slice(1) }),
      () => remove(db, '2026-10-15', { ...ids, papers: null }),
      () => remove(db, '2026-10-15', { ...ids, flexcons: [...ids.flexcons, ids.flexcons[0]] }),
      () => db.query("select flexcon_delete_inspection_registration('tester',$1::uuid)", [uuid(21)]),
    ]) {
      await assert.rejects(operation())
      assert.deepEqual(await snapshot(db), before)
    }
    await db.query('update flexcon_inspection_flexcons set inspection_date=null where id=$1', [ids.flexcons[0]])
    const changed = await snapshot(db)
    await assert.rejects(remove(db, '2026-10-15', ids), /変更されています/)
    assert.deepEqual(await snapshot(db), changed)
  } finally { await db.close() }
})

test('shipment guards apply only to the selected date, including legacy lot numbers', async () => {
  for (const lot of ['20260001002','0001002','001002']) {
    const db = await deletionDatabase()
    try {
      await db.query('insert into flexcon_shipment_items values($1)', [lot])
      const before = await snapshot(db)
      await assert.rejects(remove(db, '2026-10-15', await dateIds(db, '2026-10-15')), /出荷履歴/)
      assert.deepEqual(await snapshot(db), before)
      await remove(db, '2026-10-14', await dateIds(db, '2026-10-14'))
      assert.equal((await db.query("select count(*)::int n from flexcon_inspection_flexcons where inspection_date='2026-10-15'")).rows[0].n, 2)
    } finally { await db.close() }
  }
})
