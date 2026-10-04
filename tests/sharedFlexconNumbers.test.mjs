import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const file = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const uuid = (number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
const migration = file('../supabase/migrations/202610040001_shared_flexcon_numbers.sql')
function existingFunction(migrationFile, name) {
  const sql = file(`../supabase/migrations/${migrationFile}`)
  const start = sql.indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0)
  return sql.slice(start, sql.indexOf('$$;', start) + 3)
}

test('standard and bulk share one number sequence per authorization', async () => {
  const db = new PGlite()
  try {
    await db.exec(file('./fixtures/inspectionDatabase.sql'))
    await db.exec('alter table flexcon_inspection_flexcons add column certificate_print_count integer default 0')
    await db.exec('create table flexcon_shipment_items (lot_number text); create table flexcon_flexcons (lot_number text)')
    await db.exec(existingFunction('202609070007_inspection_registration_summary.sql', 'flexcon_split_inspection_paper_bags'))
    await db.exec(existingFunction('202609080002_separate_standard_bulk_numbers.sql', 'flexcon_save_inspection_flexcon'))
    await db.exec(existingFunction('202609050010_inspection_officers.sql', 'flexcon_save_inspection_paper_bags'))
    await db.exec(file('../supabase/migrations/202609290001_consolidate_inspection_authorizations.sql'))
    await db.exec(file('../supabase/migrations/202609260002_add_inspection_registration_details.sql'))
    await db.query(`insert into flexcon_inspection_flexcons
      (registration_id,authorization_id,fiscal_year,purchase_date,inspection_location,record_kind,flexcon_no,lot_number,brand,quantity_kg,created_by_worker_id,updated_by_worker_id)
      values ($1::uuid,$2::uuid,8,'2026-09-01','A','bulk',1,'00000001001','Rice',50,'tester','tester'),
             ($1::uuid,$2::uuid,8,'2026-09-01','A','bulk',7,'00000001007','Rice',50,'tester','tester')`, [uuid(21), uuid(1)])

    await db.exec(migration)
    const initial = (await db.query('select record_kind, flexcon_no, lot_number from flexcon_inspection_flexcons order by flexcon_no')).rows
    assert.deepEqual(initial.map(row => [row.record_kind, row.flexcon_no, row.lot_number]), [
      ['standard', 1, '20260001001'], ['standard', 2, '20260001002'],
      ['bulk', 7, '00000001007'], ['bulk', 8, '00000001008'],
    ])

    await db.query("select flexcon_append_inspection_registration('tester',$1::uuid,8,'2026-09-29','NEW','2026-09-29','A','Rice',2,0,50)", [uuid(21)])
    assert.deepEqual((await db.query("select record_kind,flexcon_no from flexcon_inspection_flexcons where settlement_no='NEW' order by flexcon_no")).rows.map(row => [row.record_kind,row.flexcon_no]), [
      ['standard',9], ['standard',10], ['bulk',11],
    ])

    const secondRegistration = (await db.query("select flexcon_add_inspection_group_with_warehouse('tester',$1::uuid,8,'2026-09-29','2026-09-29','A','Rice',0,1,0,0,$2::uuid,'NEW') ->> 'registration_id' as id", [uuid(2), uuid(11)])).rows[0].id
    assert.equal((await db.query("select flexcon_add_inspection_registration_detail('tester',$1::uuid,'bulk',25) as count", [secondRegistration])).rows[0].count, 1)
    assert.equal((await db.query("select flexcon_add_inspection_registration_detail('tester',$1::uuid,'standard',2) as count", [secondRegistration])).rows[0].count, 2)
    assert.deepEqual((await db.query('select record_kind,flexcon_no from flexcon_inspection_flexcons where authorization_id=$1::uuid order by flexcon_no', [uuid(2)])).rows.map(row => [row.record_kind,row.flexcon_no]), [
      ['bulk',1], ['standard',2], ['standard',3],
    ])

    await assert.rejects(db.query("update flexcon_inspection_flexcons set flexcon_no=9 where lot_number='00000001008'"), /unique constraint/)
    await db.exec(migration)
    assert.equal((await db.query('select count(distinct flexcon_no)::integer as count from flexcon_inspection_flexcons where authorization_id=$1::uuid', [uuid(1)])).rows[0].count, 7)
  } finally {
    await db.close()
  }
})
