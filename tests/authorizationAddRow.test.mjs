import assert from 'node:assert/strict'
import test from 'node:test'
import { withAuthorizationAddRow } from '../src/lib/authorizationTable.ts'

const rows = [{ authorization_no: '2' }, { authorization_no: '10' }]

test('add row participates in numeric number sorting in both directions', () => {
  assert.deepEqual(withAuthorizationAddRow(rows, '11', { key: 'authorization_no', direction: 'asc' }), [...rows, null])
  assert.deepEqual(withAuthorizationAddRow([...rows].reverse(), '11', { key: 'authorization_no', direction: 'desc' }), [null, rows[1], rows[0]])
  assert.deepEqual(withAuthorizationAddRow(rows, '3', { key: 'authorization_no', direction: 'asc' }), [rows[0], null, rows[1]])
  assert.deepEqual(rows.map((row) => row.authorization_no), ['2', '10'])
})

test('add row remains available with no results and stays last for other sorts', () => {
  assert.deepEqual(withAuthorizationAddRow([], '11', { key: 'authorization_no', direction: 'desc' }), [null])
  assert.deepEqual(withAuthorizationAddRow(rows, '11', null), [...rows, null])
  assert.deepEqual(withAuthorizationAddRow(rows, '11', { key: 'full_name', direction: 'desc' }), [...rows, null])
})
