import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { undoDatabase } from './fixtures/undoDatabase.mjs'
import { undoDeploymentSql } from './fixtures/undoDeployment.mjs'
import { validHeader, validItems } from './fixtures/purchaseStatementDatabase.mjs'

test('queued image receipts remain one-step undoable without asynchronous work replacing later operations', async () => {
  const { db, rpc } = await undoDatabase()
  try {
    await db.exec(undoDeploymentSql(fs.readFileSync('supabase/migrations/202610160001_operator_undo.sql', 'utf8')))
    assert.equal((await db.query("select count(*)::int n from flexcon_undo_private.tables where table_name='flexcon_purchase_statement_jobs'")).rows[0].n, 1)
    const secret = (await db.query('select secret from flexcon_queue_private.settings')).rows[0].secret
    const enqueue = async () => {
      const id = crypto.randomUUID()
      await rpc('tester', 'flexcon_purchase_queue_reserve', { p_worker_id: 'tester', p_job_id: id, p_fingerprint: 'a'.repeat(64) })
      await rpc('tester', 'flexcon_purchase_queue_ready', { p_worker_id: 'tester', p_job_id: id })
      return id
    }
    const claim = () => rpc('tester', 'flexcon_purchase_queue_claim', { p_secret: secret })
    const complete = job => rpc('tester', 'flexcon_purchase_queue_complete', { p_job_id: job.id, p_lease_token: job.leaseToken,
      p_header: validHeader(job.id), p_items: validItems(), p_warnings: ['確認事項'] })
    for (const phase of ['queued', 'processing', 'succeeded']) {
      const id = await enqueue()
      let job
      if (phase !== 'queued') job = await claim()
      if (phase === 'succeeded') assert.equal(await complete(job), true)
      else {
        assert.equal((await rpc('other', 'flexcon_list_pending_purchase_statements', { p_worker_id: 'other' })).length, 0)
        await assert.rejects(rpc('other', 'flexcon_confirm_purchase_statement', { p_worker_id: 'other', p_draft_id: id, p_header: validHeader(id), p_items: validItems() }), /解析/)
        assert.equal((await db.query('select count(*)::int n from flexcon_purchase_statements')).rows[0].n, 0)
      }
      await assert.rejects(rpc('tester', 'flexcon_dismiss_failed_purchase_statement_job', { p_worker_id: 'tester', p_job_id: id }), /失敗した画像だけ/)
      const status = await rpc('tester', 'flexcon_get_undo_status', { p_worker_id: 'tester' })
      assert.equal(status.available, true, phase)
      await rpc('tester', 'flexcon_undo_last_operation', { p_worker_id: 'tester', p_operation_id: status.operationId })
      assert.equal((await db.query('select count(*)::int n from flexcon_purchase_statement_drafts where id=$1', [id])).rows[0].n, 0)
      assert.equal((await db.query('select status from flexcon_purchase_statement_jobs where id=$1', [id])).rows[0].status, 'cancelled')
      if (job) assert.equal(await complete(job), false)
      assert.equal(await claim(), null)
    }
    const first = await enqueue()
    const second = await enqueue()
    const before = await rpc('tester', 'flexcon_get_undo_status', { p_worker_id: 'tester' })
    const job = await claim()
    assert.equal(job.id, first)
    await complete(job)
    const after = await rpc('tester', 'flexcon_get_undo_status', { p_worker_id: 'tester' })
    assert.equal(after.operationId, before.operationId)
    assert.equal(after.available, true)
    assert.equal((await db.query("select count(*)::int n from flexcon_undo_private.events where table_name='flexcon_purchase_statement_jobs'")).rows[0].n, 0)
    await rpc('tester', 'flexcon_undo_last_operation', { p_worker_id: 'tester', p_operation_id: after.operationId })
    assert.equal((await db.query('select status from flexcon_purchase_statement_jobs where id=$1', [second])).rows[0].status, 'cancelled')
    const saved = await rpc('other', 'flexcon_confirm_purchase_statement', { p_worker_id: 'other', p_draft_id: first, p_header: validHeader(first), p_items: validItems() })
    assert.ok(saved)
    const reviewUndo = await rpc('other', 'flexcon_get_undo_status', { p_worker_id: 'other' })
    await rpc('other', 'flexcon_undo_last_operation', { p_worker_id: 'other', p_operation_id: reviewUndo.operationId })
    assert.equal((await rpc('other', 'flexcon_list_pending_purchase_statements', { p_worker_id: 'other' })).length, 1)
  } finally { await db.close() }
})

test('only the reader or an administrator can dismiss a failed job, without deleting its receipt', async () => {
  const { db, rpc } = await undoDatabase()
  try {
    const id = crypto.randomUUID()
    const secret = (await db.query('select secret from flexcon_queue_private.settings')).rows[0].secret
    const args = actor => ({ p_worker_id: actor, p_job_id: id })
    const dismiss = actor => rpc(actor, 'flexcon_dismiss_failed_purchase_statement_job', args(actor))
    const list = actor => rpc(actor, 'flexcon_list_purchase_statement_jobs', { p_worker_id: actor })
    const stored = async () => (await db.query(
      'select j.status,j.upload_id,j.dismissed_by_worker_id,d.image_path from flexcon_purchase_statement_jobs j join flexcon_purchase_statement_drafts d using(id) where id=$1',
      [id],
    )).rows[0]
    await rpc('tester', 'flexcon_purchase_queue_reserve', { ...args('tester'), p_fingerprint: 'b'.repeat(64) })
    await rpc('tester', 'flexcon_purchase_queue_ready', args('tester'))
    const job = await rpc('tester', 'flexcon_purchase_queue_claim', { p_secret: secret })
    assert.equal(await rpc('tester', 'flexcon_purchase_queue_fail', {
      p_job_id: id, p_lease_token: job.leaseToken, p_error: '画像を開けません',
    }), true)
    await assert.rejects(dismiss('other'))
    await assert.rejects(dismiss('viewer'))
    const before = await stored()
    assert.equal(before.status, 'failed')
    assert.equal((await list('other'))[0].error, '画像を開けません')
    await dismiss('tester')
    assert.deepEqual(await stored(), { ...before, status: 'cancelled', dismissed_by_worker_id: 'tester' })
    assert.deepEqual(await list('tester'), [])
    assert.deepEqual(await list('other'), [])
    await assert.rejects(dismiss('tester'), /失敗した画像だけ/)
    await assert.rejects(rpc('tester', 'flexcon_retry_purchase_statement_job', args('tester')))
    assert.equal(await rpc('tester', 'flexcon_purchase_queue_claim', { p_secret: secret }), null)
    assert.deepEqual(await rpc('other', 'flexcon_list_pending_purchase_statements', { p_worker_id: 'other' }), [])
    const undo = await rpc('tester', 'flexcon_get_undo_status', { p_worker_id: 'tester' })
    assert.equal(undo.available, true)
    await rpc('tester', 'flexcon_undo_last_operation', { p_worker_id: 'tester', p_operation_id: undo.operationId })
    assert.deepEqual(await stored(), before)
    assert.equal((await list('other'))[0].error, '画像を開けません')
    await dismiss('admin')
    assert.equal((await stored()).dismissed_by_worker_id, 'admin')
    assert.equal((await db.query('select count(*)::int n from flexcon_purchase_statements')).rows[0].n, 0)
  } finally { await db.close() }
})
