import assert from 'node:assert/strict'
import test from 'node:test'
import { formatInspectionMoisture, formatInspectionQuantity } from '../src/lib/inspectionNumberFormat.ts'

test('inspection moisture displays exactly one decimal without filling empty values', () => {
  for (const [value, expected] of [[13, '13.0'], ['13', '13.0'], [0, '0.0'], [16, '16.0'], [16.1, '16.1'], [13.04, '13.0'], [13.06, '13.1'], ['', ''], ['  ', ''], [null, '']]) {
    assert.equal(formatInspectionMoisture(value), expected)
  }
})

test('inspection quantities group every three digits without changing numeric values', () => {
  for (const [value, expected] of [[0, '0'], [999, '999'], [1000, '1,000'], ['1020', '1,020'], [1000000, '1,000,000'], [2147483647, '2,147,483,647'], ['', '']]) {
    assert.equal(formatInspectionQuantity(value), expected)
    if (value !== '') assert.equal(Number(expected.replaceAll(',', '')), Number(value))
  }
})

test('invalid numeric drafts stay visible for validation rather than being coerced', () => {
  for (const value of ['abc', '-', '.', '13..0']) {
    assert.equal(formatInspectionMoisture(value), value)
    assert.equal(formatInspectionQuantity(value), value)
  }
  assert.equal(formatInspectionQuantity('1.5'), '1.5')
})
