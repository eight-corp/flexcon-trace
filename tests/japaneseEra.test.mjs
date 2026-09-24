import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatJapaneseCropYear,
  formatJapaneseDate,
  formatJapaneseDateForFilename,
  formatJapaneseDateLong,
  parseJapaneseDate,
} from '../src/lib/japaneseEra.ts'

test('era boundary dates are formatted and parsed without changing the stored ISO date', () => {
  for (const [iso, japanese] of [
    ['1989-01-07', '昭和64/01/07'],
    ['1989-01-08', '平成元/01/08'],
    ['2019-04-30', '平成31/04/30'],
    ['2019-05-01', '令和元/05/01'],
    ['2026-09-24', '令和8/09/24'],
  ]) {
    assert.equal(formatJapaneseDate(iso), japanese)
    assert.equal(parseJapaneseDate(japanese), iso)
  }
})

test('invalid calendar and era dates are rejected', () => {
  assert.equal(parseJapaneseDate('令和8/02/30'), null)
  assert.equal(parseJapaneseDate('平成31/05/01'), null)
  assert.equal(parseJapaneseDate('令和元/04/30'), null)
})

test('crop year and PDF text use Japanese eras', () => {
  assert.equal(formatJapaneseCropYear(2026), '令和8年産')
  assert.equal(formatJapaneseCropYear(2019), '令和元年産')
  assert.equal(formatJapaneseCropYear(8), '令和8年産')
  assert.equal(formatJapaneseDateLong('2026-09-24'), '令和 8 年 9 月 24 日')
  assert.equal(formatJapaneseDateForFilename('2026-09-24'), '令和8年09月24日')
})
