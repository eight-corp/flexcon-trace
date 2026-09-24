import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesFilterText } from '../src/lib/tableFilters.ts'

test('column text search is partial, trimmed, and width-insensitive', () => {
  assert.equal(matchesFilterText('青森県', ' 青森 '), true)
  assert.equal(matchesFilterText('ロットＡ１２３', 'a123'), true)
  assert.equal(matchesFilterText('青森県', '岩手'), false)
  assert.equal(matchesFilterText('', '   '), true)
})
