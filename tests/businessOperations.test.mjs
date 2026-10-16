import assert from 'node:assert/strict'
import test from 'node:test'
import { pendingBusinessWrites, trackBusinessWrite, undoActionLabel, waitForBusinessWrites } from '../src/lib/businessOperations.ts'

test('shared mutation tracking excludes reads and waits for queued writes to finish', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { dispatchEvent() {}, setTimeout }
  try {
    trackBusinessWrite(new URL('https://db.test/rest/v1/rpc/flexcon_get_undo_status'), 'POST')()
    trackBusinessWrite(new URL('https://db.test/rest/v1/flexcon_shipments'), 'GET')()
    assert.equal(pendingBusinessWrites(), 0)
    const finishFirst = trackBusinessWrite(new URL('https://db.test/rest/v1/rpc/flexcon_save_inspection_detail_with_settlement'), 'POST')
    assert.equal(pendingBusinessWrites(), 1)
    let settled = false
    const settledPromise = waitForBusinessWrites().then(() => { settled = true })
    finishFirst()
    const finishSecond = trackBusinessWrite(new URL('https://db.test/functions/v1/purchase-statement-image'), 'POST')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(settled, false)
    assert.equal(pendingBusinessWrites(), 1)
    finishSecond()
    await settledPromise
    assert.equal(pendingBusinessWrites(), 0)
  } finally { globalThis.window = previousWindow }
})

test('undo confirmation labels describe the saved operation', () => {
  assert.equal(undoActionLabel('flexcon_add_memo_visible'), 'メモの登録')
  assert.equal(undoActionLabel('flexcon_delete_inspection_registration_date'), '検査記録の削除')
  assert.equal(undoActionLabel('flexcon_confirm_purchase_statement'), '仕切書の確認')
  assert.equal(undoActionLabel('flexcon_bulk_delete_inventory_records'), '入出庫記録の削除')
  assert.equal(undoActionLabel('flexcon_attach_purchase_statement_image'), '仕切書画像の変更')
})
