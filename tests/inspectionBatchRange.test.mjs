import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const uuid = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
const migration = readFileSync(new URL('../supabase/migrations/202609290003_inspection_metadata_range_override.sql', import.meta.url), 'utf8')

test('batch ranges and overwrite never apply to bulk records', async t => {
  const db = new PGlite()
  try {
    await db.exec(readFileSync(new URL('./fixtures/inspectionDatabase.sql', import.meta.url), 'utf8'))
    const oldSql = readFileSync(new URL('../supabase/migrations/202609070007_inspection_registration_summary.sql', import.meta.url), 'utf8')
    const start = oldSql.indexOf('create or replace function public.flexcon_split_inspection_paper_bags(')
    await db.exec(oldSql.slice(start, oldSql.indexOf('$$;', start) + 3))
    await db.exec(readFileSync(new URL('../supabase/migrations/202609290001_consolidate_inspection_authorizations.sql', import.meta.url), 'utf8'))
    await db.exec(readFileSync(new URL('../supabase/migrations/202609290002_fill_missing_inspection_metadata.sql', import.meta.url), 'utf8'))
    await db.exec(migration)
    await db.exec("insert into flexcon_inspection_options(option_type,name) values ('inspector','New'),('inspector','Other'),('grade','1等'),('grade','2等'),('grade','合格')")
    await db.query("select flexcon_append_inspection_registration('tester',$1::uuid,8,'2026-09-29','APPEND',null,'A','Rice',2,1,50)", [uuid(21)])
    await db.query("select flexcon_add_inspection_group_with_warehouse('tester',$1::uuid,8,'2026-09-29',null,'A','Rice',1,1,1020,0,$2::uuid,'OTHER')", [uuid(2), uuid(11)])
    await db.exec("update flexcon_inspection_flexcons set inspector_name='Existing',grade='2等',reason='胴割れ' where flexcon_no=1 and record_kind='standard'; update flexcon_inspection_flexcons set brand='飼料用玄米',grade=null where record_kind='bulk'")
    const snapshots = async () => ({
      flexcons: (await db.query('select * from flexcon_inspection_flexcons order by id')).rows,
      papers: (await db.query('select * from flexcon_inspection_paper_bags order by id')).rows,
    })
    const apply = async (values = {}) => {
      const args = { target: 'all', start: null, end: null, overwrite: false, date: null, inspector: 'New', location: null, grade: null, worker: 'tester', registration: 21, ...values }
      const result = await db.query('select flexcon_set_inspection_registration_metadata_range($1,$2::uuid,$3::date,$4,$5,$6,$7,$8::integer,$9::integer,$10::boolean) as count', [args.worker, uuid(args.registration), args.date, args.inspector, args.location, args.grade, args.target, args.start, args.end, args.overwrite])
      return result.rows[0].count
    }
    const standard = row => row.registration_id === uuid(21) && row.record_kind === 'standard'
    const assertUntargeted = (before, after, targets) => {
      assert.deepEqual(after.flexcons.filter(row => !targets.has(row.id)), before.flexcons.filter(row => !targets.has(row.id)))
      assert.deepEqual(after.papers.filter(row => !targets.has(row.id)), before.papers.filter(row => !targets.has(row.id)))
    }
    await t.test('inclusive range fills only missing metadata', async () => {
      const before = await snapshots()
      assert.equal(await apply({ target: 'standard', start: 1, end: 2, date: '2026-10-01', location: 'A', grade: '1等' }), 1)
      const after = await snapshots()
      const changed = after.flexcons.find(row => standard(row) && row.flexcon_no === 2)
      assert.equal(changed.inspector_name, 'New')
      assert.equal(changed.grade, '1等')
      assert.equal(changed.inspection_location, 'B')
      assert.equal(changed.warehouse_id, uuid(12))
      assert.equal(changed.settlement_no, 'OLD-B')
      assertUntargeted(before, after, new Set([changed.id]))
      assert.equal(await apply({ target: 'standard', start: 1, end: 2, date: '2026-10-02', inspector: 'Other', location: 'B', grade: '2等' }), 0)
      assert.deepEqual(await snapshots(), after)
    })
    await t.test('overwrite affects only the range and only supplied fields', async () => {
      const before = await snapshots()
      assert.equal(await apply({ target: 'standard', start: 2, end: 3, overwrite: true, inspector: 'Other', grade: '2等' }), 2)
      const after = await snapshots()
      const targets = new Set(after.flexcons.filter(row => standard(row) && row.flexcon_no >= 2 && row.flexcon_no <= 3).map(row => row.id))
      for (const row of after.flexcons.filter(row => targets.has(row.id))) {
        const previous = before.flexcons.find(item => item.id === row.id)
        assert.equal(row.inspector_name, 'Other')
        assert.equal(row.grade, '2等')
        for (const field of ['inspection_date', 'inspection_location', 'reason', 'warehouse_id', 'settlement_no', 'lot_number', 'quantity_kg', 'moisture', 'purchase_date']) assert.deepEqual(row[field], previous[field])
      }
      assertUntargeted(before, after, targets)
      assert.equal(await apply({ target: 'standard', start: 2, end: 3, overwrite: true, inspector: 'Other', grade: '2等' }), 0)
      assert.deepEqual(await snapshots(), after)
    })
    await t.test('paper and all targets exclude bulk and other registrations', async () => {
      let before = await snapshots()
      assert.equal(await apply({ target: 'paper', overwrite: true, location: 'A' }), 2)
      let after = await snapshots()
      const papers = new Set(after.papers.filter(row => row.registration_id === uuid(21)).map(row => row.id))
      assertUntargeted(before, after, papers)
      before = after
      await apply({ overwrite: true, date: '2026-10-03', inspector: 'Other', location: 'B', grade: '1等' })
      after = await snapshots()
      const targets = new Set([...after.flexcons.filter(standard), ...after.papers.filter(row => row.registration_id === uuid(21))].map(row => row.id))
      assertUntargeted(before, after, targets)
      for (const row of [...after.flexcons, ...after.papers].filter(row => targets.has(row.id))) {
        assert.equal(row.grade, '1等')
        assert.equal(row.reason, null)
        assert.equal(row.inspection_location, 'B')
      }
    })
    await t.test('partial bounds and grade validation use only the selected range', async () => {
      await db.exec("update flexcon_inspection_flexcons set brand='飼料用玄米',grade='合格' where flexcon_no=4 and record_kind='standard'")
      await apply({ target: 'standard', end: 3, overwrite: true, grade: '2等' })
      const before = await snapshots()
      await assert.rejects(apply({ target: 'standard', start: 3, overwrite: true, grade: '2等' }), /銘柄/)
      assert.deepEqual(await snapshots(), before)
      await apply({ target: 'standard', start: 4, inspector: null, overwrite: true, grade: '合格' })
      assert.equal(await apply({ target: 'standard', inspector: null, grade: '2等' }), 0)
    })
    await t.test('old clients also leave bulk untouched', async () => {
      await db.exec("update flexcon_inspection_flexcons set inspector_name=null where record_kind='standard'")
      const before = await snapshots()
      await db.query('select flexcon_set_inspection_registration_metadata($1,$2::uuid,null,$3,null,null)', ['tester', uuid(21), 'New'])
      const after = await snapshots()
      assertUntargeted(before, after, new Set(after.flexcons.filter(standard).map(row => row.id)))
    })
    await t.test('invalid scope, bounds and authentication reject without any writes', async () => {
      const before = await snapshots()
      for (const values of [{ target: 'bulk' }, { target: null }, { target: 'standard', start: 0 }, { target: 'standard', start: 3, end: 2 }, { target: 'paper', start: 1 }, { target: 'all', end: 1 }, { target: 'standard', start: 999 }, { worker: 'intruder' }, { registration: 999 }, { inspector: 'Unknown' }, { location: 'Unknown' }, { grade: 'Unknown' }, { inspector: null }]) await assert.rejects(apply(values))
      assert.deepEqual(await snapshots(), before)
      await db.exec(migration)
      assert.deepEqual(await snapshots(), before)
    })
  } finally { await db.close() }
})
