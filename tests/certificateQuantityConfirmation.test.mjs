import assert from 'node:assert/strict'
import test from 'node:test'
import { certificateQuantityConfirmation } from '../src/lib/certificateQuantityConfirmation.ts'

const weights = { branded_rice: 1020, feed_rice: 1000 }
const record = (no, quantity, brand = 'まっしぐら') => ({ flexcon_no: no, quantity_kg: quantity, brand })

test('certificate quantity confirmation is unnecessary for empty or standard-weight targets', () => {
  assert.equal(certificateQuantityConfirmation([], weights), null)
  assert.equal(certificateQuantityConfirmation([record(1, 1020), record(2, 1000, '飼料用玄米')], weights), null)
})

test('certificate confirmation shows actual quantities and groups consecutive numbers without altering inputs', () => {
  const targets = [record(4, 1080), record(1, 1080), record(2, 1080), record(3, 1020), record(5, 1030, '飼料用玄米')]
  const original = structuredClone(targets)
  const message = certificateQuantityConfirmation(targets, weights)
  assert.match(message, /まっしぐら　№1～2、4（3本）/)
  assert.match(message, /現在：1,080kg／本　初期値：1,020kg／本/)
  assert.match(message, /飼料用玄米　№5（1本）/)
  assert.match(message, /現在：1,030kg／本　初期値：1,000kg／本/)
  assert.doesNotMatch(message, /№3/)
  assert.match(message, /現在の数量で間違いありませんか？$/)
  assert.deepEqual(targets, original)
})

test('comparison uses current master weights and only the provided print range', () => {
  assert.equal(certificateQuantityConfirmation([record(1, 1080)], { branded_rice: 1080, feed_rice: 1000 }), null)
  assert.equal(certificateQuantityConfirmation([record(1, 1030, ' 飼料用玄米 ')], { branded_rice: 1080, feed_rice: 1030 }), null)
  const message = certificateQuantityConfirmation([record(7, 990), record(8, 1030)], weights)
  assert.match(message, /現在：990kg／本/)
  assert.match(message, /現在：1,030kg／本/)
  assert.match(message, /№7（1本）/)
  assert.match(message, /№8（1本）/)
})
