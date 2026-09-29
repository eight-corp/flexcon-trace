import assert from 'node:assert/strict'
import test from 'node:test'
import { certificateDefaultRange } from '../src/lib/certificateDefaultRange.ts'

const records = (count, printed = []) => Array.from({ length: count }, (_, index) => ({
  flexcon_no: index + 1,
  certificate_print_count: printed.includes(index + 1) ? 1 : 0,
}))

test('defaults to all unprinted certificates when nothing has been printed', () => {
  assert.deepEqual(certificateDefaultRange(records(14)), { start: '1', count: '14' })
})

test('starts after a printed prefix and counts through the final row', () => {
  assert.deepEqual(certificateDefaultRange(records(14, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), { start: '11', count: '4' })
})

test('stops at the next printed row when there is an unprinted gap', () => {
  assert.deepEqual(certificateDefaultRange(records(14, [1, 2, 3, 4, 6, 7, 8, 9, 10])), { start: '5', count: '1' })
  assert.deepEqual(certificateDefaultRange(records(14, [1, 2, 3, 4, 8, 9, 10])), { start: '5', count: '3' })
})

test('counts existing rows, not missing serial numbers, and does not mutate candidates', () => {
  const candidates = [
    { flexcon_no: 8, certificate_print_count: 2 },
    { flexcon_no: 6, certificate_print_count: null },
    { flexcon_no: 3, certificate_print_count: 0 },
    { flexcon_no: 2, certificate_print_count: 1 },
  ]
  const original = structuredClone(candidates)
  assert.deepEqual(certificateDefaultRange(candidates), { start: '3', count: '2' })
  assert.deepEqual(candidates, original)
})

test('all printed leaves the range empty for manual reprints', () => {
  assert.deepEqual(certificateDefaultRange(records(14, Array.from({ length: 14 }, (_, i) => i + 1))), { start: '', count: '' })
  assert.deepEqual(certificateDefaultRange([]), { start: '', count: '' })
})
