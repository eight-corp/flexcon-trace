import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatJapaneseCropYear,
  formatJapaneseDate,
  formatJapaneseDateForFilename,
  formatJapaneseDateLong,
  formatJapaneseDateTime,
  formatDisplayCropYear,
  formatDisplayDate,
  formatDisplayDateTime,
  parseDisplayDate,
  parseJapaneseDate,
} from '../src/lib/japaneseEra.ts'

test('era boundary dates are formatted and parsed without changing the stored ISO date', () => {
  for (const [iso, japanese] of [
    ['1989-01-07', '昭和64年1月7日'],
    ['1989-01-08', '平成元年1月8日'],
    ['2019-04-30', '平成31年4月30日'],
    ['2019-05-01', '令和元年5月1日'],
    ['2026-09-24', '令和8年9月24日'],
  ]) {
    assert.equal(formatJapaneseDate(iso), japanese)
    assert.equal(parseJapaneseDate(japanese), iso)
  }
})

test('invalid calendar and era dates are rejected', () => {
  assert.equal(parseJapaneseDate('令和8/02/30'), null)
  assert.equal(parseJapaneseDate('平成31/05/01'), null)
  assert.equal(parseJapaneseDate('令和元/04/30'), null)
  assert.equal(parseJapaneseDate('令和8年2月30日'), null)
})

test('crop year and PDF text use Japanese eras', () => {
  assert.equal(formatJapaneseCropYear(2026), '令和8年産')
  assert.equal(formatJapaneseCropYear(2019), '令和元年産')
  assert.equal(formatJapaneseCropYear(8), '令和8年産')
  assert.equal(formatJapaneseDateLong('2026-09-24'), '令和8年9月24日')
  assert.equal(formatJapaneseDateForFilename('2026-09-24'), '令和8年9月24日')
})

test('date-time display uses the same full date format', () => {
  assert.equal(formatJapaneseDateTime('2026-09-24T15:30:00'), '令和8年9月24日 15:30')
})

test('screen calendar mode changes only presentation and keeps ISO dates', () => {
  assert.equal(formatDisplayDate('2026-09-24', 'wareki'), '令和8年9月24日')
  assert.equal(formatDisplayDate('2026-09-24', 'seireki'), '2026年9月24日')
  assert.equal(formatDisplayDateTime('2026-09-24T15:30:00', 'seireki'), '2026年9月24日 15:30')
  assert.equal(formatDisplayCropYear(8, 'seireki'), '2026年産')
  assert.equal(formatDisplayCropYear(2026, 'seireki'), '2026年産')
  assert.equal(parseDisplayDate('2026年9月24日', 'seireki'), '2026-09-24')
  assert.equal(parseDisplayDate('２０２６/９/２４', 'seireki'), '2026-09-24')
  assert.equal(parseDisplayDate('令和8年9月24日', 'wareki'), '2026-09-24')
  assert.equal(parseDisplayDate('2026年2月29日', 'seireki'), null)
  assert.equal(parseDisplayDate('令和8年9月24日', 'seireki'), null)
})
