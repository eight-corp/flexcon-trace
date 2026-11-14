import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { purchaseStatementDatabase, validHeader, validItems } from './fixtures/purchaseStatementDatabase.mjs'

const migration = fs.readFileSync('supabase/migrations/202611140001_purchase_statement_queue.sql', 'utf8')
test('durable purchase queue isolates operators, leases work once, and preserves independent review', async t => {
  const { db, rpc } = await purchaseStatementDatabase()
  try {
    await db.exec('create role service_role')
    await db.exec(migration)
    const secret = (await db.query('select secret from flexcon_queue_private.settings')).rows[0].secret
    const id = crypto.randomUUID(), second = crypto.randomUUID()
    const reserve = (actor, job = id, fingerprint = 'a'.repeat(64)) => rpc(actor, 'flexcon_purchase_queue_reserve', { p_worker_id: actor, p_job_id: job, p_fingerprint: fingerprint })
    const ready = job => rpc('reader', 'flexcon_purchase_queue_ready', { p_worker_id: 'reader', p_job_id: job })
    const claim = () => rpc('reader', 'flexcon_purchase_queue_claim', { p_secret: secret })
    const complete = (job, token = job.leaseToken) => rpc('reader', 'flexcon_purchase_queue_complete', {
      p_job_id: job.id, p_lease_token: token, p_header: validHeader('QUEUE'), p_items: validItems(), p_warnings: ['確認事項'],
    })
    await t.test('install is idempotent; private tables and worker RPCs reject client roles', async () => {
      await db.exec(migration)
      assert.equal((await db.query('select secret from flexcon_queue_private.settings')).rows[0].secret, secret)
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await db.query(`select has_table_privilege($1,'flexcon_purchase_statement_jobs','SELECT') ok`, [role])).rows[0].ok, false)
        for (const fn of ['flexcon_purchase_queue_claim(text)', 'flexcon_purchase_queue_complete(uuid,uuid,jsonb,jsonb,jsonb)', 'flexcon_purchase_queue_fail(uuid,uuid,text)']) {
          assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') ok', [role, fn])).rows[0].ok, false)
        }
      }
      await assert.rejects(reserve('viewer'))
      await assert.rejects(rpc('reader', 'flexcon_purchase_queue_reserve', { p_worker_id: 'reviewer', p_job_id: id, p_fingerprint: 'a'.repeat(64) }))
      await assert.rejects(rpc('reader', 'flexcon_purchase_queue_claim', { p_secret: 'bad' }))
    })
    await t.test('upload retry keeps the same job and rejects changes or another reader', async () => {
      const first = await reserve('reader')
      assert.equal(first.status, 'uploading')
      assert.deepEqual(await reserve('reader'), first)
      await assert.rejects(reserve('reviewer'))
      await assert.rejects(reserve('reader', id, 'b'.repeat(64)))
      assert.equal(await claim(), null)
      await ready(id)
      await ready(id)
      await reserve('reader', second)
      await ready(second)
      assert.equal((await db.query('select count(*)::int n from flexcon_purchase_statement_jobs')).rows[0].n, 2)
    })
    let job
    await t.test('concurrent claims serialize globally and stale callbacks cannot commit', async () => {
      job = await claim()
      assert.equal(job.id, id)
      assert.equal(await claim(), null)
      assert.equal(await complete(job, crypto.randomUUID()), false)
      await db.query("update flexcon_purchase_statement_jobs set lease_until=clock_timestamp()-interval '1 minute' where id=$1", [id])
      const recovered = await claim()
      assert.equal(recovered.id, id)
      assert.notEqual(recovered.leaseToken, job.leaseToken)
      assert.equal(await complete(job), false)
      job = recovered
    })
    await t.test('completion creates one pending draft, never stock, and reader cannot confirm it', async () => {
      assert.equal(await complete(job), true)
      assert.equal(await complete(job), false)
      const drafts = await rpc('reviewer', 'flexcon_list_pending_purchase_statements', { p_worker_id: 'reviewer' })
      assert.equal(drafts.length, 1)
      assert.equal(drafts[0].created_by_worker_id, 'reader')
      assert.deepEqual(drafts[0].warnings, ['確認事項'])
      assert.match(drafts[0].image_path, new RegExp(`^${id}/[0-9a-f-]+\\.jpg$`))
      assert.equal((await db.query('select count(*)::int n from flexcon_purchase_statements')).rows[0].n, 1)
      await assert.rejects(rpc('reader', 'flexcon_confirm_purchase_statement', { p_worker_id: 'reader', p_draft_id: id, p_header: validHeader('QUEUE'), p_items: validItems() }), /本人/)
      await rpc('reviewer', 'flexcon_confirm_purchase_statement', { p_worker_id: 'reviewer', p_draft_id: id, p_header: validHeader('QUEUE'), p_items: validItems() })
      const status = await rpc('reader', 'flexcon_list_purchase_statement_jobs', { p_worker_id: 'reader' })
      assert.equal(status.find(row => row.id === id).confirmed, true)
    })
    await t.test('failure leaves evidence and next work can continue; retry uses the original reader', async () => {
      const failed = await claim()
      assert.equal(failed.id, second)
      await rpc('reader', 'flexcon_purchase_queue_fail', { p_job_id: second, p_lease_token: failed.leaseToken, p_error: 'failed' })
      const imagePath = await rpc('viewer', 'flexcon_purchase_queue_image', { p_worker_id: 'viewer', p_job_id: second })
      assert.match(imagePath, new RegExp(`^${second}/`))
      await assert.rejects(rpc('viewer', 'flexcon_retry_purchase_statement_job', { p_worker_id: 'viewer', p_job_id: second }))
      await rpc('reviewer', 'flexcon_retry_purchase_statement_job', { p_worker_id: 'reviewer', p_job_id: second })
      const recovered = await claim()
      assert.equal(recovered.id, second)
      assert.equal(await complete(recovered), true)
      assert.equal((await db.query('select created_by_worker_id from flexcon_purchase_statement_drafts where id=$1', [second])).rows[0].created_by_worker_id, 'reader')
    })
    await t.test('repeated crashed workers eventually fail visibly rather than silently losing work', async () => {
      const third = crypto.randomUUID()
      await reserve('reader', third); await ready(third)
      for (let n = 0; n < 3; n++) {
        assert.equal((await claim()).id, third)
        await db.query("update flexcon_purchase_statement_jobs set lease_until=clock_timestamp()-interval '1 minute' where id=$1", [third])
      }
      assert.equal(await claim(), null)
      assert.equal((await db.query('select status from flexcon_purchase_statement_jobs where id=$1', [third])).rows[0].status, 'failed')
    })
  } finally { await db.close() }
})
