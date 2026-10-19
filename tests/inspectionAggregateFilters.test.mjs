import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectionAggregateDisplayValue, inspectionAggregateGroupKey, matchesInspectionAggregateFilters } from '../src/lib/inspectionAggregateFilters.ts'

const row = { kind: 'flexcon', fiscalYear: 8, origin: '青森県', brand: '飼料用玄米', inspectedByGrade: { 合格: 2000 }, inspectedQuantity: 2000, uninspectedQuantity: 50 }
const matches = (columnFilters = {}, textFilters = {}) => matchesInspectionAggregateFilters(row, { columnFilters, textFilters }, 'wareki')

test('aggregate filters use exactly the displayed years, quantities and blank grade cells', () => {
  assert.equal(inspectionAggregateDisplayValue(row, 'fiscalYear', 'wareki'), '令和8年産')
  assert.equal(inspectionAggregateDisplayValue(row, 'fiscalYear', 'seireki'), '2026年産')
  assert.equal(inspectionAggregateDisplayValue(row, 'grade:合格', 'wareki'), '2,000kg')
  assert.equal(inspectionAggregateDisplayValue(row, 'grade:1等', 'wareki'), '')
  assert.equal(inspectionAggregateDisplayValue(row, 'inspectedQuantity', 'wareki'), '2,000kg')
  assert.equal(inspectionAggregateDisplayValue({ ...row, uninspectedQuantity: 0 }, 'uninspectedQuantity', 'wareki'), '0kg')
})

test('aggregate checkboxes and text search intersect across every active column', () => {
  assert.equal(matches(), true)
  assert.equal(matches({ brand: ['飼料用玄米'], origin: ['青森県'] }, { 'grade:合格': '２，０００', fiscalYear: '令和8' }), true)
  assert.equal(matches({ brand: ['飼料用玄米'], origin: ['岩手県'] }), false)
  assert.equal(matches({ brand: [] }), false)
  assert.equal(matches({ brand: undefined }), true)
  assert.equal(matches({ 'grade:1等': [''] }), true)
  assert.equal(matches({ 'grade:合格': [''] }), false)
  assert.equal(matches({ inspectedQuantity: ['2,000kg'] }, { inspectedQuantity: '50' }), false)
  assert.equal(matches({}, { brand: '  飼料用  ', uninspectedQuantity: '５０' }), true)
})

test('detail group selection cannot mix packaging, crop years, origins or brands', () => {
  const key = inspectionAggregateGroupKey(row)
  assert.equal(inspectionAggregateGroupKey({ ...row, inspectedQuantity: 1 }), key)
  for (const values of [{ kind: 'paper' }, { fiscalYear: 7 }, { origin: '岩手県' }, { brand: 'まっしぐら' }]) {
    assert.notEqual(inspectionAggregateGroupKey({ ...row, ...values }), key)
  }
})
