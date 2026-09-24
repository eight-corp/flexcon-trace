import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatJapaneseCropYear,
  formatJapaneseDate,
  formatJapaneseDateForFilename,
  formatJapaneseDateLong,
  formatJapaneseDateTime,
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
