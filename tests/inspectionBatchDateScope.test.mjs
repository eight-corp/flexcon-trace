import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const uuid = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8')
const migration = read('../supabase/migrations/202610150002_inspection_metadata_date_scope.sql')

test('batch inspection date scopes are atomic and intersect with kind and number range', async t => {
  const db = new PGlite()
  try {
    await db.exec(read('./fixtures/inspectionDatabase.sql'))
    const oldSql = read('../supabase/migrations/202609070007_inspection_registration_summary.sql')
    const start = oldSql.indexOf('create or replace function public.flexcon_split_inspection_paper_bags(')
    await db.exec(oldSql.slice(start, oldSql.indexOf('$$;', start) + 3))
    for (const file of ['202609290001_consolidate_inspection_authorizations.sql', '202609290002_fill_missing_inspection_metadata.sql', '202609290003_inspection_metadata_range_override.sql', '202610150002_inspection_metadata_date_scope.sql']) {
      await db.exec(read(`../supabase/migrations/${file}`))
    }
    await db.exec("insert into flexcon_inspection_options(option_type,name) values ('inspector','New'),('inspector','Other'),('grade','1等'),('grade','2等'),('grade','合格')")
    await db.query("select flexcon_append_inspection_registration('tester',$1::uuid,8,'2026-10-02','OCT2','2026-10-02','A','Rice',2,1,50)", [uuid(21)])
    await db.query("select flexcon_append_inspection_registration('tester',$1::uuid,8,'2026-10-04','OCT4','2026-10-04','A','Rice',1,1,0)", [uuid(21)])
    await db.query("select flexcon_add_inspection_group_with_warehouse('tester',$1::uuid,8,'2026-10-02','2026-10-02','A','Rice',1,1,1020,0,$2::uuid,'OTHER')", [uuid(2), uuid(11)])
    const snapshots = async () => ({
      flexcons: (await db.query('select * from flexcon_inspection_flexcons order by id')).rows,
      papers: (await db.query('select * from flexcon_inspection_paper_bags order by id')).rows,
    })
    const apply = async (values = {}) => {
      const args = { target: 'all', start: null, end: null, overwrite: false, date: null, inspector: 'New', location: null, grade: null, worker: 'tester', registration: 21, scope: null, undated: false, ...values }
      const result = await db.query('select flexcon_set_inspection_registration_metadata_scope($1,$2::uuid,$3::date,$4,$5,$6,$7,$8::integer,$9::integer,$10::boolean,$11::date,$12::boolean) as count', [args.worker, uuid(args.registration), args.date, args.inspector, args.location, args.grade, args.target, args.start, args.end, args.overwrite, args.scope, args.undated])
      return result.rows[0].count
    }
    const dateOf = row => row.inspection_date ? new Date(row.inspection_date).toISOString().slice(0, 10) : null
    const eligible = row => row.registration_id === uuid(21) && row.record_kind !== 'bulk'
    const assertUnchanged = (before, after, predicate) => {
      for (const kind of ['flexcons', 'papers']) assert.deepEqual(after[kind].filter(row => !predicate(row)), before[kind].filter(row => !predicate(row)))
    }
    const scopedTest = async (name, fn) => t.test(name, async () => {
      await db.exec('begin')
      try { await fn() } finally { await db.exec('rollback') }
    })
    await scopedTest('a selected date fills only that date and ignores incompatible brands on other dates', async () => {
      await db.exec("update flexcon_inspection_flexcons set brand='飼料用玄米',grade=null where inspection_date='2026-10-04' or record_kind='bulk'")
      const before = await snapshots()
      const targeted = row => eligible(row) && dateOf(row) === '2026-10-02'
      assert.equal(await apply({ scope: '2026-10-02', grade: '1等' }), 3)
      const after = await snapshots()
      assertUnchanged(before, after, targeted)
      for (const row of [...after.flexcons, ...after.papers].filter(targeted)) {
        assert.equal(row.inspector_name, 'New')
        assert.equal(row.grade, '1等')
      }
      assert.equal(await apply({ scope: '2026-10-02', inspector: 'Other' }), 0)
      assert.deepEqual(await snapshots(), after)
    })
    await scopedTest('date changes capture their original targets before any writes', async () => {
      const before = await snapshots()
      const ids = new Set([...before.flexcons, ...before.papers].filter(row => eligible(row) && dateOf(row) === '2026-10-02').map(row => row.id))
      assert.equal(await apply({ scope: '2026-10-02', overwrite: true, date: '2026-10-04', grade: '2等' }), ids.size)
      const after = await snapshots()
      assertUnchanged(before, after, row => ids.has(row.id))
      for (const row of [...after.flexcons, ...after.papers].filter(row => ids.has(row.id))) {
        assert.equal(dateOf(row), '2026-10-04')
        assert.equal(row.grade, '2等')
      }
    })
    await scopedTest('date and inclusive number range both apply to standard records', async () => {
      const before = await snapshots()
      const targeted = row => eligible(row) && row.record_kind === 'standard' && row.flexcon_no === 4
      assert.equal(await apply({ scope: '2026-10-02', target: 'standard', start: 4, end: 5, overwrite: true, grade: '2等' }), 1)
      assertUnchanged(before, await snapshots(), targeted)
    })
    await scopedTest('paper-only date filter leaves all flexcons untouched', async () => {
      const before = await snapshots()
      assert.equal(await apply({ scope: '2026-10-04', target: 'paper', overwrite: true, location: 'B' }), 1)
      assertUnchanged(before, await snapshots(), row => eligible(row) && !('record_kind' in row) && dateOf(row) === '2026-10-04')
    })
    await scopedTest('undated selection can fill dates without selecting existing dates', async () => {
      const before = await snapshots()
      const ids = new Set([...before.flexcons, ...before.papers].filter(row => eligible(row) && !dateOf(row)).map(row => row.id))
      assert.equal(ids.size, 2)
      assert.equal(await apply({ undated: true, date: '2026-10-15', grade: '1等' }), 2)
      const after = await snapshots()
      assertUnchanged(before, after, row => ids.has(row.id))
      for (const row of [...after.flexcons, ...after.papers].filter(row => ids.has(row.id))) assert.equal(dateOf(row), '2026-10-15')
    })
    await scopedTest('all dates and old clients remain compatible and still exclude bulk', async () => {
      const before = await snapshots()
      const count = [...before.flexcons, ...before.papers].filter(eligible).length
      assert.equal(await apply({ overwrite: true }), count)
      assertUnchanged(before, await snapshots(), eligible)
      const result = await db.query("select flexcon_set_inspection_registration_metadata_range('tester',$1::uuid,null,'Other',null,null,'all',null,null,true) as count", [uuid(21)])
      assert.equal(result.rows[0].count, count)
      assertUnchanged(before, await snapshots(), eligible)
    })
    await t.test('invalid and empty scopes reject without writes', async () => {
      const before = await snapshots()
      for (const values of [{ scope: '2026-10-02', undated: true }, { scope: '2026-01-01' }, { scope: '2026-10-02', target: 'standard', start: 5 }, { scope: '2026-10-02', target: 'bulk' }, { scope: '2026-10-02', worker: 'intruder' }]) await assert.rejects(apply(values))
      assert.deepEqual(await snapshots(), before)
      await db.exec(migration)
      assert.deepEqual(await snapshots(), before)
    })
  } finally { await db.close() }
})
