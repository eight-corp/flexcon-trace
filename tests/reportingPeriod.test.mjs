import assert from 'node:assert/strict'
import test from 'node:test'
import { currentReportingPeriod, reportingYearPeriod, validReportingPeriod, matchesReportingPeriod, inspectionReportingDate, shipmentReportingDate } from '../src/lib/reportingPeriod.ts'

test('reporting years start on September 1, including January and the August boundary', () => {
  assert.deepEqual(currentReportingPeriod(new Date(2026, 7, 31, 23, 59)), reportingYearPeriod(2025))
  assert.deepEqual(currentReportingPeriod(new Date(2026, 8, 1)), reportingYearPeriod(2026))
  assert.deepEqual(currentReportingPeriod(new Date(2027, 0, 1)), reportingYearPeriod(2026))
  assert.deepEqual(reportingYearPeriod(2026), { start: '2026-09-01', end: '2027-08-31' })
})

test('shared periods are inclusive, open ended, validated and never coerce reversed dates', () => {
  const period = reportingYearPeriod(2026)
  assert.deepEqual(['2026-08-31', '2026-09-01', '2027-08-31', '2027-09-01'].filter(date => matchesReportingPeriod(date, period)), ['2026-09-01', '2027-08-31'])
  assert.equal(matchesReportingPeriod(null, { start: '', end: '' }), true)
  assert.equal(matchesReportingPeriod(null, period), false)
  assert.equal(matchesReportingPeriod('2026-09-01', { start: '', end: '2026-09-01' }), true)
  for (const invalid of [null, {}, { start: 2026, end: '' }, { start: '2026-02-30', end: '' }, { start: 'x', end: '' }, { start: '2027-09-01', end: '2026-08-31' }]) assert.equal(validReportingPeriod(invalid), false)
  for (const valid of [period, { start: '', end: '' }, { start: '2028-02-29', end: '' }]) assert.equal(validReportingPeriod(valid), true)
})

test('inspection year uses inspection date with a purchase date fallback, not crop year', () => {
  const period = reportingYearPeriod(2026)
  assert.equal(matchesReportingPeriod(inspectionReportingDate({ inspection_date: '2026-08-31', purchase_date: '2026-09-01' }), period), false)
  assert.equal(matchesReportingPeriod(inspectionReportingDate({ inspection_date: '2026-09-01', purchase_date: '2026-08-31' }), period), true)
  assert.equal(matchesReportingPeriod(inspectionReportingDate({ inspection_date: null, purchase_date: '2026-09-01' }), period), true)
})

test('shipment timestamps are converted to the local calendar day', () => {
  const instant = new Date(2026, 8, 1, 0, 0, 0)
  assert.equal(shipmentReportingDate(instant.toISOString()), '2026-09-01')
  assert.equal(shipmentReportingDate('bad'), '')
})
