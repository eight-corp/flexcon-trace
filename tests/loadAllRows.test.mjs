import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAllRows } from '../src/lib/loadAllRows.ts'

test('all pages are loaded without truncation, duplication or skipped boundary rows', async () => {
  for (const count of [0, 999, 1000, 1001, 1807, 2000, 2501]) {
    const rows = Array.from({ length: count }, (_, id) => ({ id }))
    const requests = []
    const result = await loadAllRows(async (from, to) => {
      requests.push([from, to])
      return { data: rows.slice(from, to + 1), error: null }
    })
    assert.deepEqual(result, { data: rows, error: null })
    assert.equal(requests.length, Math.floor(count / 1000) + 1)
    requests.forEach(([from, to], page) => assert.deepEqual([from, to], [page * 1000, page * 1000 + 999]))
  }
})

test('a failed later page cannot be mistaken for a complete result', async () => {
  const error = { message: 'page failed' }
  assert.deepEqual(await loadAllRows(async from => from === 0
    ? { data: Array.from({ length: 1000 }, (_, id) => ({ id })), error: null }
    : { data: null, error }), { data: null, error })
  assert.deepEqual(await loadAllRows(async () => ({ data: null, error: null })), { data: [], error: null })
})
