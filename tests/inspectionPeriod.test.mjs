import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesInspectionPeriod } from '../src/lib/inspectionPeriod.ts'

const rows = [
  { id: 'earlier', inspection_date: '2026-09-28', purchase_date: '2026-09-03' },
  { id: 'start', inspection_date: '2026-09-29', purchase_date: '2026-09-04' },
  { id: 'end', inspection_date: '2026-10-01', purchase_date: '2026-09-03' },
  { id: 'undated', inspection_date: null, purchase_date: '2026-09-03' },
]
const selected = period => rows.filter(row => matchesInspectionPeriod(row, period)).map(row => row.id)

test('inspection date boundaries are inclusive and open ended', () => {
  assert.deepEqual(selected({ basis: 'inspection', start: '2026-09-29', end: '2026-10-01' }), ['start', 'end'])
  assert.deepEqual(selected({ basis: 'inspection', start: '2026-10-01', end: '' }), ['end'])
  assert.deepEqual(selected({ basis: 'inspection', start: '', end: '2026-09-29' }), ['earlier', 'start'])
})

test('undated records remain in unrestricted totals and can be filtered by purchase date', () => {
  assert.deepEqual(selected({ basis: 'inspection', start: '', end: '' }), ['earlier', 'start', 'end', 'undated'])
  assert.deepEqual(selected({ basis: 'purchase', start: '2026-09-03', end: '2026-09-03' }), ['earlier', 'end', 'undated'])
})

test('reversed periods yield no records', () => {
  assert.deepEqual(selected({ basis: 'inspection', start: '2026-10-01', end: '2026-09-29' }), [])
})
