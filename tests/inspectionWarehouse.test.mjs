import assert from 'node:assert/strict'
import test from 'node:test'
import { findWarehouseForInspectionLocation } from '../src/lib/inspectionWarehouse.ts'

const options = [
  { id: 'location', option_type: 'location', name: '浪岡倉庫', active: true },
  { id: 'warehouse', option_type: 'warehouse', name: '浪岡倉庫', active: true },
  { id: 'inactive', option_type: 'warehouse', name: '六戸倉庫', active: false },
]

test('inspection location maps only to an active warehouse with the same name', () => {
  assert.equal(findWarehouseForInspectionLocation(' 浪岡倉庫 ', options)?.id, 'warehouse')
  assert.equal(findWarehouseForInspectionLocation('六戸倉庫', options), null)
  assert.equal(findWarehouseForInspectionLocation('八幡平倉庫', options), null)
  assert.equal(findWarehouseForInspectionLocation('', options), null)
})
