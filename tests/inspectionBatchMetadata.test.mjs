import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const uuid = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
const migration = readFileSync(new URL('../supabase/migrations/202609290002_fill_missing_inspection_metadata.sql', import.meta.url), 'utf8')

test('batch inspection metadata fills only unset fields', async t => {
  const db = new PGlite()
  try {
    await db.exec(readFileSync(new URL('./fixtures/inspectionDatabase.sql', import.meta.url), 'utf8'))
    const sql = readFileSync(new URL('../supabase/migrations/202609070007_inspection_registration_summary.sql', import.meta.url), 'utf8')
    const start = sql.indexOf('create or replace function public.flexcon_split_inspection_paper_bags(')
    await db.exec(sql.slice(start, sql.indexOf('$$;', start) + 3))
    await db.exec(readFileSync(new URL('../supabase/migrations/202609290001_consolidate_inspection_authorizations.sql', import.meta.url), 'utf8'))
    await db.exec(migration)
    await db.exec("insert into flexcon_inspection_options(option_type,name) values ('inspector','New'),('inspector','Other'),('grade','1等'),('grade','2等'),('grade','3等'),('grade','合格')")
    await db.query("select flexcon_append_inspection_registration('tester',$1::uuid,8,'2026-09-29','BULK','2026-09-28','A','Rice',0,0,50)", [uuid(21)])
    await db.query("select flexcon_add_inspection_group_with_warehouse('tester',$1::uuid,8,'2026-09-29',null,'A','Rice',1,1,1020,0,$2::uuid,'OTHER')", [uuid(2), uuid(11)])
    await db.exec("update flexcon_inspection_flexcons set inspector_name='Existing',grade='2等',reason='胴割れ' where lot_number='20260001001'; update flexcon_inspection_flexcons set inspector_name='  ',grade='' where lot_number='20260001002'")
    const snapshots = async () => ({
      flexcons: (await db.query('select * from flexcon_inspection_flexcons order by id')).rows,
      papers: (await db.query('select * from flexcon_inspection_paper_bags order by id')).rows,
    })
    const apply = (date = '2026-09-29', inspector = 'New', location = 'A', grade = '1等', worker = 'tester', registration = 21) =>
      db.query('select flexcon_set_inspection_registration_metadata($1,$2::uuid,$3::date,$4,$5,$6)', [worker, uuid(registration), date, inspector, location, grade])

    await t.test('retains each populated field, reasons, inventory metadata and unrelated records', async () => {
      const before = await snapshots()
      await apply()
      const after = await snapshots()
      const existing = before.flexcons.find(row => row.lot_number === '20260001001')
      assert.deepEqual(after.flexcons.find(row => row.id === existing.id), existing)
      const filled = after.flexcons.find(row => row.lot_number === '20260001002')
      assert.equal(new Date(filled.inspection_date).toISOString().slice(0, 10), '2026-09-29')
      assert.equal(filled.inspector_name, 'New')
      assert.equal(filled.inspection_location, 'B')
      assert.equal(filled.grade, '1等')
      assert.equal(filled.warehouse_id, uuid(12))
      assert.equal(filled.settlement_no, 'OLD-B')
      const bulk = after.flexcons.find(row => row.record_kind === 'bulk')
      assert.equal(new Date(bulk.inspection_date).toISOString().slice(0, 10), '2026-09-28')
      assert.equal(bulk.grade, '1等')
      const paper = after.papers.find(row => row.registration_id === uuid(21))
      assert.equal(paper.inspector_name, 'New')
      assert.equal(paper.inspection_location, 'B')
      assert.equal(paper.warehouse_id, uuid(12))
      assert.equal(paper.grade, '1等')
      assert.deepEqual(after.flexcons.filter(row => row.authorization_id === uuid(2)), before.flexcons.filter(row => row.authorization_id === uuid(2)))
      assert.deepEqual(after.papers.filter(row => row.authorization_id === uuid(2)), before.papers.filter(row => row.authorization_id === uuid(2)))
    })
    await t.test('a repeated application does not change fields or audit timestamps', async () => {
      const before = await snapshots()
      await apply('2026-09-30', 'Other', 'B', '3等')
      assert.deepEqual(await snapshots(), before)
    })
    await t.test('unspecified parameters leave other empty fields and existing reasons alone', async () => {
      await db.exec("update flexcon_inspection_paper_bags set inspector_name='',inspection_date=null,inspection_location='  ',grade='2等',reason='胴割れ' where registration_id='00000000-0000-0000-0000-000000000021'")
      await apply(null, 'New', null, null)
      const row = (await snapshots()).papers.find(row => row.registration_id === uuid(21))
      assert.equal(row.inspector_name, 'New')
      assert.equal(row.inspection_date, null)
      assert.equal(row.inspection_location, '  ')
      assert.equal(row.grade, '2等')
      assert.equal(row.reason, '胴割れ')
      await apply(null, null, 'A', '1等')
      const saved = (await snapshots()).papers.find(candidate => candidate.id === row.id)
      assert.equal(saved.inspection_location, 'A')
      assert.equal(saved.grade, '2等')
      assert.equal(saved.reason, '胴割れ')
    })
    await t.test('grade compatibility considers only ungraded details and rejects atomically', async () => {
      await db.exec("update flexcon_inspection_flexcons set brand='飼料用玄米',grade='合格' where record_kind='bulk'; update flexcon_inspection_flexcons set grade=null where lot_number='20260001002'")
      await apply(null, null, null, '2等')
      assert.equal((await snapshots()).flexcons.find(row => row.record_kind === 'bulk').grade, '合格')
      await db.exec("update flexcon_inspection_flexcons set grade=null where record_kind='bulk'")
      const before = await snapshots()
      await assert.rejects(apply('2026-09-30', 'Other', 'B', '1等'), /銘柄/)
      assert.deepEqual(await snapshots(), before)
      await apply(null, null, null, '合格')
      assert.equal((await snapshots()).flexcons.find(row => row.record_kind === 'bulk').grade, '合格')
      assert.equal((await snapshots()).papers.find(row => row.registration_id === uuid(21)).reason, '胴割れ')
    })
    await t.test('worker, registration and master validation cannot alter details', async () => {
      const before = await snapshots()
      await assert.rejects(apply(null, 'New', null, null, 'intruder'), /unauthorized/)
      await assert.rejects(apply(null, 'New', null, null, 'tester', 999), /見つかりません/)
      await assert.rejects(apply(null, 'Unknown', null, null), /検査員/)
      await assert.rejects(apply(null, null, 'Unknown', null), /検査場所/)
      await assert.rejects(apply(null, null, null, 'Unknown'), /等級/)
      await assert.rejects(apply(null, null, null, null), /1つ以上/)
      assert.deepEqual(await snapshots(), before)
    })
    await t.test('reapplying the function migration does not update any data', async () => {
      const before = await snapshots()
      await db.exec(migration)
      assert.deepEqual(await snapshots(), before)
    })
  } finally { await db.close() }
})
