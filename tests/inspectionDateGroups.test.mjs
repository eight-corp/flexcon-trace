import assert from 'node:assert/strict'
import test from 'node:test'
import { groupInspectionRecordsByDate } from '../src/lib/inspectionDateGroups.ts'

test('inspection dates form chronological rows with undated records last', () => {
  const records = [
    { id: 'bulk', inspection_date: '2026-09-29', quantity_kg: 50 },
    { id: 'paper', inspection_date: null, bag_count: 10 },
    { id: 'standard1', inspection_date: '2026-09-02', quantity_kg: 1020 },
    { id: 'standard2', inspection_date: '2026-09-29', quantity_kg: 1020 },
    { id: 'empty-date', inspection_date: '', quantity_kg: 1020 },
  ]
  const original = structuredClone(records)
  const groups = groupInspectionRecordsByDate(records)
  assert.deepEqual(groups.map(([date, rows]) => [date, rows.map(row => row.id)]), [
    ['2026-09-02', ['standard1']],
    ['2026-09-29', ['bulk', 'standard2']],
    [null, ['paper', 'empty-date']],
  ])
  assert.equal(groups.flatMap(([, rows]) => rows).length, records.length)
  assert.equal(new Set(groups.flatMap(([, rows]) => rows.map(row => row.id))).size, records.length)
  assert.deepEqual(records, original)
})

test('empty and single-date records need no artificial extra rows', () => {
  assert.deepEqual(groupInspectionRecordsByDate([]), [])
  assert.deepEqual(groupInspectionRecordsByDate([{ id: 'a', inspection_date: null }]), [[null, [{ id: 'a', inspection_date: null }]]])
})
