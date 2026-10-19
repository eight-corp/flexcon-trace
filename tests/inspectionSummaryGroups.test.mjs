import assert from 'node:assert/strict'
import test from 'node:test'
import { groupInspectionSummaryRecords, inspectionSummaryKindLabel } from '../src/lib/inspectionSummaryGroups.ts'

test('summary rows split by inspection date, brand and all three packaging kinds', () => {
  const records = [
    { id: 1, inspection_date: '2026-10-04', brand: 'Rice', kind: 'standard' },
    { id: 2, inspection_date: '2026-10-04', brand: ' Rice ', kind: 'standard' },
    { id: 3, inspection_date: '2026-10-04', brand: 'Rice', kind: 'bulk' },
    { id: 4, inspection_date: '2026-10-04', brand: 'Rice', kind: 'paper' },
    { id: 5, inspection_date: '2026-10-04', brand: 'Feed', kind: 'standard' },
    { id: 6, inspection_date: '2026-10-06', brand: 'Rice', kind: 'standard' },
    { id: 7, inspection_date: null, brand: null, kind: 'standard' },
    { id: 8, inspection_date: null, brand: '', kind: 'standard' },
  ]
  const before = structuredClone(records)
  const groups = groupInspectionSummaryRecords(records, record => record.kind)
  assert.equal(groups.length, 6)
  assert.equal(new Set(groups.map(group => group.key)).size, 6)
  assert.deepEqual(groups.find(group => group.brand === 'Rice' && group.kind === 'standard' && group.inspectionDate === '2026-10-04').records.map(record => record.id), [1, 2])
  assert.deepEqual(groups.at(-1).records.map(record => record.id), [7, 8])
  assert.deepEqual(groups.filter(group => group.brand === 'Rice' && group.inspectionDate === '2026-10-04').map(group => inspectionSummaryKindLabel(group.kind)), ['推フレ', 'バラ', '紙袋'])
  assert.deepEqual(records, before)
  assert.deepEqual(groupInspectionSummaryRecords([], record => record.kind), [])
})
