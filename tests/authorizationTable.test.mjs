import assert from 'node:assert/strict'
import test from 'node:test'
import { AUTHORIZATION_COLUMNS, authorizationColumnValue, selectAuthorizations } from '../src/lib/authorizationTable.ts'

const records = [
  { id: 'a', authorization_no: '10', full_name: '佐藤', seed_purchase_slip: false, farming_plan: true, address: null, prefecture: '青森県', municipality: null, phone: null, crop_type: null, feed_rice_variety: null, notes: null },
  { id: 'b', authorization_no: '2', full_name: '山田', seed_purchase_slip: true, farming_plan: false, address: '岩手県盛岡市', prefecture: '岩手県', municipality: '盛岡市', phone: null, crop_type: null, feed_rice_variety: null, notes: null },
  { id: 'c', authorization_no: '3', full_name: '鈴木', seed_purchase_slip: false, farming_plan: false, address: null, prefecture: '青森県', municipality: null, phone: null, crop_type: null, feed_rice_variety: null, notes: null },
]

test('authorization columns cover every displayed data field', () => {
  assert.equal(AUTHORIZATION_COLUMNS.length, 11)
  assert.equal(authorizationColumnValue(records[0], 'address'), '')
  assert.equal(authorizationColumnValue(records[0], 'seed_purchase_slip'), 'なし')
  assert.equal(authorizationColumnValue(records[1], 'seed_purchase_slip'), 'あり')
})

test('number sorting is numeric and default order is preserved', () => {
  assert.deepEqual(selectAuthorizations(records, {}, null).map((item) => item.id), ['a', 'b', 'c'])
  assert.deepEqual(selectAuthorizations(records, {}, { key: 'authorization_no', direction: 'asc' }).map((item) => item.id), ['b', 'c', 'a'])
  assert.deepEqual(selectAuthorizations(records, {}, { key: 'authorization_no', direction: 'desc' }).map((item) => item.id), ['a', 'c', 'b'])
})

test('flags and blank values can be filtered together', () => {
  const filtered = selectAuthorizations(records, { seed_purchase_slip: ['なし'], address: [''] }, null)
  assert.deepEqual(filtered.map((item) => item.id), ['a', 'c'])
  assert.deepEqual(selectAuthorizations(records, { prefecture: [] }, null), [])
})
