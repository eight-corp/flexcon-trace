import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const migration = readFileSync(new URL('../supabase/migrations/202609290001_consolidate_inspection_authorizations.sql', import.meta.url), 'utf8')
const uuid = (number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
function existingFunction(file, name) {
  const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')
  const start = sql.indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0)
  return sql.slice(start, sql.indexOf('$$;', start) + 3)
}

test('inspection consolidation preserves detail metadata and inventory', async (t) => {
  const db = new PGlite()
  try {
    await db.exec(readFileSync(new URL('./fixtures/inspectionDatabase.sql', import.meta.url), 'utf8'))
    await db.exec(existingFunction('202609070007_inspection_registration_summary.sql', 'flexcon_split_inspection_paper_bags'))
    await db.exec(existingFunction('202609080002_separate_standard_bulk_numbers.sql', 'flexcon_save_inspection_flexcon'))
    await db.exec(existingFunction('202609050010_inspection_officers.sql', 'flexcon_save_inspection_paper_bags'))
    const balances = () => db.query('select * from flexcon_inventory_balances_base order by warehouse_id,unit,grade').then(result => result.rows)
    const before = await balances()
    await db.exec(migration)
    const add = (authorization = 1, settlement = 'NEW-B', worker = 'tester', location = 'B', warehouse = 12) => db.query(
      "select flexcon_add_inspection_group_with_warehouse($1,$2::uuid,8,'2026-09-29','2026-09-29',$3,'Rice',1,5,1020,50,$4::uuid,$5) as result",
      [worker,uuid(authorization),location,uuid(warehouse),settlement],
    ).then(result => result.rows[0].result)

    await t.test('legacy duplicates consolidate without deleting headers or changing stock', async () => {
      assert.deepEqual(await balances(),before)
      assert.equal((await db.query('select count(distinct registration_id)::integer as count from flexcon_inspection_flexcons')).rows[0].count,1)
      assert.equal((await db.query('select count(*)::integer as count from flexcon_inspection_registrations')).rows[0].count,2)
      const rows = (await db.query('select lot_number,warehouse_id,settlement_no from flexcon_inspection_flexcons order by flexcon_no')).rows
      assert.deepEqual(rows.map(row => [row.lot_number,row.warehouse_id,row.settlement_no]),[
        ['20260001001',uuid(11),'OLD-A'],['20260001002',uuid(12),'OLD-B'],
      ])
      assert.deepEqual((await db.query('select distinct settlement_no from flexcon_inventory_ledger order by settlement_no')).rows.map(row => row.settlement_no),['OLD-A','OLD-B'])
    })
    await t.test('same authorization adds all three kinds to the existing registration', async () => {
      const result = await add()
      assert.equal(result.registration_id,uuid(21))
      assert.equal((await db.query('select count(*)::integer as count from flexcon_inspection_registrations')).rows[0].count,2)
      const rows = (await db.query("select record_kind,flexcon_no,warehouse_id,settlement_no from flexcon_inspection_flexcons where settlement_no='NEW-B' order by record_kind")).rows
      assert.deepEqual(rows.map(row => [row.record_kind,row.flexcon_no,row.warehouse_id]),[['bulk',1,uuid(12)],['standard',3,uuid(12)]])
      assert.equal((await db.query('select settlement_no from flexcon_inspection_registrations where id=$1::uuid',[uuid(21)])).rows[0].settlement_no,'OLD-A')
    })
    await t.test('new authorization creates only one header, even after repeated additions', async () => {
      const first = await add(2,'FIRST')
      const second = await add(2,'SECOND')
      assert.equal(first.registration_id,second.registration_id)
      assert.equal((await db.query('select count(*)::integer as count from flexcon_inspection_registrations where authorization_id=$1::uuid',[uuid(2)])).rows[0].count,1)
    })
    await t.test('paper split copies its own warehouse and settlement without changing stock', async () => {
      const beforeSplit = await balances()
      const paper = (await db.query("select * from flexcon_inspection_paper_bags where settlement_no='OLD-B'")).rows[0]
      const result = (await db.query("select flexcon_split_inspection_paper_bags('tester',$1::uuid,4,6) as id",[paper.id])).rows[0]
      const split = (await db.query('select * from flexcon_inspection_paper_bags where id=$1::uuid',[result.id])).rows[0]
      assert.equal(split.warehouse_id,paper.warehouse_id)
      assert.equal(split.settlement_no,paper.settlement_no)
      assert.equal(split.registration_id,uuid(21))
      assert.deepEqual(await balances(),beforeSplit)
    })
    await t.test('detail edits change only their own settlement and never move stock', async () => {
      const row = (await db.query("select * from flexcon_inspection_flexcons where lot_number='20260001002'")).rows[0]
      const beforeEdit = await balances()
      await db.query("select flexcon_save_inspection_detail_with_settlement('tester','flexcon',$1::uuid,$2::uuid,8,'2026-09-03',null,null,'A',2,'Rice',1020,null,null,null,'EDITED')",[row.id,uuid(1)])
      const saved = (await db.query('select warehouse_id,settlement_no from flexcon_inspection_flexcons where id=$1::uuid',[row.id])).rows[0]
      assert.deepEqual(saved,{warehouse_id:uuid(12),settlement_no:'EDITED'})
      assert.deepEqual(await balances(),beforeEdit)
    })
    await t.test('authorization and invalid inputs roll back the complete addition', async () => {
      const beforeFailure = await balances()
      await assert.rejects(add(2,'INVALID','intruder'),/unauthorized/)
      await assert.rejects(add(2,'INVALID','tester','A',12),/搬入先/)
      await assert.rejects(add(2,'X'.repeat(81)),/80文字/)
      assert.deepEqual(await balances(),beforeFailure)
    })
    await t.test('migration can be reapplied without replacing detail metadata', async () => {
      const beforeReapply = await balances()
      await db.exec(migration)
      assert.deepEqual(await balances(),beforeReapply)
      assert.equal((await db.query("select settlement_no from flexcon_inspection_flexcons where lot_number='20260001002'")).rows[0].settlement_no,'EDITED')
    })
  } finally { await db.close() }
})
