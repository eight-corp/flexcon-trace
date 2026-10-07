import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { purchaseStatementDatabase, validHeader, validItems } from './fixtures/purchaseStatementDatabase.mjs'

test('purchase statements remain isolated until a different operator confirms', async () => {
  const { db, rpc, legacyId } = await purchaseStatementDatabase()
  const id = randomUUID()
  const submit = { p_worker_id: 'reader', p_draft_id: id, p_source_type: 'camera', p_header: { ...validHeader(), document_number: '', statement_date: '', tax_treatment: '' }, p_items: [{ ...validItems()[0], quantity: null }], p_warnings: ['番号が読めません'] }
  const confirm = { p_worker_id: 'reviewer', p_draft_id: id, p_header: validHeader(), p_items: validItems() }
  try {
    const legacy = (await db.query('select * from flexcon_purchase_statements where id=$1', [legacyId])).rows[0]
    assert.equal(await rpc('reader', 'flexcon_submit_purchase_statement', submit), id)
    assert.equal(await rpc('reader', 'flexcon_submit_purchase_statement', submit), id)
    assert.equal((await db.query('select count(*)::int as count from flexcon_purchase_statement_drafts')).rows[0].count, 1)
    assert.equal((await rpc('viewer', 'flexcon_list_purchase_statements', { p_worker_id: 'viewer' })).length, 1)
    const pending = await rpc('viewer', 'flexcon_list_pending_purchase_statements', { p_worker_id: 'viewer' })
    assert.equal(pending[0].created_by_worker_id, 'reader')
    assert.equal(pending[0].document_number, '')
    assert.deepEqual(pending[0].warnings, ['番号が読めません'])
    await assert.rejects(rpc('reader', 'flexcon_confirm_purchase_statement', { ...confirm, p_worker_id: 'reader' }), /読取者本人/)
    await assert.rejects(rpc('reader', 'flexcon_confirm_purchase_statement', confirm), /unauthorized/)
    await assert.rejects(rpc('viewer', 'flexcon_confirm_purchase_statement', { ...confirm, p_worker_id: 'viewer' }), /unauthorized/)
    await assert.rejects(rpc('reviewer', 'flexcon_confirm_purchase_statement', confirm), /元画像/)
    await db.query("update flexcon_purchase_statement_drafts set image_path=id::text||'/original.jpg' where id=$1", [id])
    await assert.rejects(rpc('reviewer', 'flexcon_confirm_purchase_statement', { ...confirm, p_items: [{ ...validItems()[0], quantity: null }] }), /数量/)
    assert.equal((await db.query('select count(*)::int as count from flexcon_purchase_statements')).rows[0].count, 1)
    const confirmedId = await rpc('reviewer', 'flexcon_confirm_purchase_statement', confirm)
    assert.equal(await rpc('reviewer', 'flexcon_confirm_purchase_statement', confirm), confirmedId)
    await assert.rejects(rpc('admin', 'flexcon_confirm_purchase_statement', { ...confirm, p_worker_id: 'admin' }), /すでに確認済み/)
    assert.equal((await rpc('viewer', 'flexcon_list_pending_purchase_statements', { p_worker_id: 'viewer' })).length, 0)
    const confirmed = (await db.query('select * from flexcon_purchase_statements where id=$1', [confirmedId])).rows[0]
    assert.equal(confirmed.created_by_worker_id, 'reader')
    assert.equal(confirmed.image_path, `${id}/original.jpg`)
    const audit = (await db.query('select * from flexcon_purchase_statement_drafts where id=$1', [id])).rows[0]
    assert.equal(audit.confirmed_by_worker_id, 'reviewer')
    assert.ok(audit.confirmed_at)
    assert.deepEqual((await db.query('select * from flexcon_purchase_statements where id=$1', [legacyId])).rows[0], legacy)
    await assert.rejects(rpc('reader', 'flexcon_save_purchase_statement', { p_worker_id: 'reader', p_statement_id: null, p_source_type: 'camera', p_header: validHeader('BYPASS'), p_items: validItems() }), /確認待ち/)
    await assert.rejects(rpc('reader', 'flexcon_submit_purchase_statement', { ...submit, p_draft_id: randomUUID(), p_items: [] }), /読取明細/)
  } finally { await db.close() }
})

test('duplicate numbers require explicit replacement by a different reviewer and manual entries also wait', async () => {
  const { db, rpc, legacyId } = await purchaseStatementDatabase()
  const id = randomUUID()
  try {
    await rpc('admin', 'flexcon_submit_purchase_statement', { p_worker_id: 'admin', p_draft_id: id, p_source_type: 'manual', p_header: validHeader('LEGACY'), p_items: validItems(), p_warnings: [] })
    const args = { p_worker_id: 'reader', p_draft_id: id, p_header: validHeader('LEGACY'), p_items: [{ ...validItems()[0], quantity: 2, amount: 2000 }] }
    await assert.rejects(rpc('admin', 'flexcon_confirm_purchase_statement', { ...args, p_worker_id: 'admin' }), /読取者本人/)
    await assert.rejects(rpc('reader', 'flexcon_confirm_purchase_statement', args), /duplicate key/)
    assert.equal((await db.query('select confirmed_at from flexcon_purchase_statement_drafts where id=$1', [id])).rows[0].confirmed_at, null)
    assert.equal(await rpc('reader', 'flexcon_confirm_purchase_statement', { ...args, p_replace_statement_id: legacyId }), legacyId)
    assert.equal((await db.query('select count(*)::int as count from flexcon_purchase_statements')).rows[0].count, 1)
    assert.equal(Number((await db.query('select quantity from flexcon_purchase_statement_items where statement_id=$1', [legacyId])).rows[0].quantity), 2)
    const secondId = randomUUID()
    await rpc('reader', 'flexcon_submit_purchase_statement', { p_worker_id: 'reader', p_draft_id: secondId, p_source_type: 'manual', p_header: validHeader('NEW'), p_items: validItems(), p_warnings: [] })
    await assert.rejects(rpc('reader', 'flexcon_delete_pending_purchase_statement', { p_worker_id: 'reader', p_draft_id: secondId }), /unauthorized/)
    await rpc('admin', 'flexcon_delete_pending_purchase_statement', { p_worker_id: 'admin', p_draft_id: secondId })
    assert.equal((await rpc('viewer', 'flexcon_list_pending_purchase_statements', { p_worker_id: 'viewer' })).length, 0)
    // An audit link must not prevent the existing administrator deletion workflow.
    await rpc('admin', 'flexcon_delete_purchase_statement', { p_worker_id: 'admin', p_statement_id: legacyId })
    assert.equal((await db.query('select confirmed_statement_id from flexcon_purchase_statement_drafts where id=$1', [id])).rows[0].confirmed_statement_id, legacyId)
  } finally { await db.close() }
})
