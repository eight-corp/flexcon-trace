import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { purchaseStatementDatabase, validHeader, validItems } from './fixtures/purchaseStatementDatabase.mjs'

test('queue edge saves images before AI, authenticates every action, retries uploads and preserves OCR rules', async () => {
  const { db, rpc } = await purchaseStatementDatabase()
  try {
    await db.exec(fs.readFileSync('supabase/migrations/202611140001_purchase_statement_queue.sql', 'utf8'))
    await db.exec(fs.readFileSync('supabase/migrations/202611200003_purchase_statement_reader_name.sql', 'utf8'))
    const secret = (await db.query('select secret from flexcon_queue_private.settings')).rows[0].secret
    const objects = new Map(), tasks = [], calls = []
    let handler, failPayload = true, providerFailure, failSave = false
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
    const fetchMock = async (input, options = {}) => {
      const url = new URL(input), body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : null
      calls.push({ url, options, body })
      if (url.hostname === 'generativelanguage.googleapis.com') {
        if (typeof providerFailure === 'number') return json({ error: { message: 'test provider failure; private sentinel' } }, providerFailure)
        if (providerFailure === 'timeout') throw new DOMException('private sentinel', 'TimeoutError')
        if (providerFailure === 'network') throw new TypeError('private sentinel')
        if (providerFailure === 'invalid') return json({ candidates: [{ content: { parts: [{ text: '<private sentinel>' }] } }] })
        if (providerFailure === 'empty') return json({})
        if (providerFailure === 'blocked') return json({ promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'private sentinel' } })
        const taxOnly = !body.generationConfig.responseSchema.properties.lines
        const result = taxOnly ? { tax_treatment: 'inclusive' } : { ...validHeader('EDGE'), lines: providerFailure === 'no-lines' ? [] : [...validItems(), { ...validItems()[0], crop_year: '', product_name: '免税', amount: 30 }], warnings: ['確認事項'] }
        return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] })
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.split('/').at(-1)
        if (name === 'business_session') return json({ ok: true, workerId: options.headers['x-business-session'], permissions: { purchase_statements: options.headers['x-business-session'] === 'viewer' ? 'viewer' : 'operator' } })
        if (name === 'flexcon_purchase_queue_complete' && failSave) return json({ message: 'private sentinel' }, 400)
        try { return json(await rpc(options.headers['x-business-session'] || 'reader', name, body)) }
        catch (error) { return json({ message: error.message }, 400) }
      }
      const path = url.pathname.replace('/storage/v1/object/', '')
      if (options.method === 'POST' && !path.startsWith('sign/')) {
        if (path.startsWith('purchase-statement-queue/') && failPayload) { failPayload = false; return json({}, 500) }
        if (objects.has(path)) return json({ statusCode: '409' }, 400)
        assert.equal(options.headers['x-upsert'], 'false')
        objects.set(path, options.body)
        return json({})
      }
      if (path.startsWith('authenticated/')) return objects.has(path.slice(14)) ? new Response(objects.get(path.slice(14))) : json({}, 404)
      if (path.startsWith('sign/')) return json({ signedURL: '/object/sign/test?token=private' })
      throw new Error(`Unexpected fetch: ${input}`)
    }
    const globals = { Request, Response, Uint8Array, atob, Date, Set, Error, crypto, TextEncoder, AbortSignal, DOMException,
      console: { warn() {}, error() {} }, fetch: fetchMock,
      Deno: { env: { get: key => key === 'SUPABASE_URL' ? 'https://supabase.test' : key === 'GEMINI_MODEL' || key === 'GEMINI_FALLBACK_MODEL' ? undefined : 'test-secret' }, serve: callback => { handler = callback } },
      EdgeRuntime: { waitUntil: task => tasks.push(task) } }
    const engineExports = {}
    const transpile = source => ts.transpile(source, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS })
    vm.runInNewContext(transpile(fs.readFileSync('supabase/functions/analyze-purchase-statement/index.ts', 'utf8').replace('import.meta.main', 'false')), { ...globals, exports: engineExports })
    const queueExports = {}
    vm.runInNewContext(transpile(fs.readFileSync('supabase/functions/purchase-statement-queue/index.ts', 'utf8')), { ...globals, exports: queueExports, require: () => engineExports })
    const invoke = (body, actor = 'reader', workerSecret = '') => handler(new Request('https://edge.test', { method: 'POST',
      headers: workerSecret ? { 'x-queue-secret': workerSecret } : { apikey: 'test', authorization: 'Bearer test', 'x-business-session': actor, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
    const id = crypto.randomUUID()
    const enqueue = { action: 'enqueue', jobId: id, image: { imageBase64: '/9j/', mimeType: 'image/jpeg', taxRegionBase64: '/9j/', detailRegionBase64: '/9j/', productMasterNames: ['青天のへきれき'], originMasterNames: ['青森'] } }
    const denied = await invoke(enqueue, 'viewer')
    assert.equal(denied.status, 400)
    assert.equal((await denied.json()).reason, 'access_denied')
    const missingSession = await invoke(enqueue, '')
    assert.equal(missingSession.status, 400)
    assert.equal((await missingSession.json()).reason, 'session_expired')
    assert.equal(objects.size, 0)
    assert.equal((await invoke({}, 'reader', 'bad-secret')).status, 400)
    const invalidId = crypto.randomUUID()
    const invalid = await invoke({ ...enqueue, jobId: invalidId, image: { imageBase64: 'N0xU', mimeType: 'image/jpeg' } })
    assert.equal((await invalid.json()).reason, 'invalid_image')
    assert.equal((await db.query('select id from flexcon_purchase_statement_jobs where id=$1', [invalidId])).rows.length, 0)
    const uploadFailure = await invoke(enqueue)
    assert.equal(uploadFailure.status, 400)
    assert.equal((await uploadFailure.json()).reason, 'payload_upload')
    assert.equal(objects.size, 1)
    assert.equal((await invoke(enqueue)).status, 200)
    assert.equal((await invoke(enqueue)).status, 200)
    assert.equal(objects.size, 2)
    assert.equal(calls.some(call => call.url.hostname === 'generativelanguage.googleapis.com'), false)
    assert.equal((await invoke({}, 'reader', secret)).status, 200)
    await Promise.all(tasks.splice(0))
    const draft = (await rpc('reviewer', 'flexcon_list_pending_purchase_statements', { p_worker_id: 'reviewer' }))[0]
    assert.equal(draft.id, id)
    assert.equal(draft.created_by_worker_id, 'reader')
    assert.equal(draft.recipient, 'Reader', 'Use the original logged-in reader rather than the OCR name or reviewer')
    assert.equal(draft.tax_treatment, 'inclusive')
    assert.equal(draft.items[1].amount, -30)
    assert.equal(draft.items[1].crop_year, '2026')
    assert.ok(draft.warnings.includes('確認事項'))
    const providerCalls = calls.filter(call => call.url.hostname === 'generativelanguage.googleapis.com')
    const prompt = providerCalls.find(call => call.body.generationConfig.responseSchema.properties.lines).body.contents[0].parts[0].text
    for (const rule of ['数量列', '仕入先', '品名マスタ候補', '青天のへきれき', '訂正後の数字', '角張った囲み', '和暦']) assert.ok(prompt.includes(rule))
    const schema = providerCalls.find(call => call.body.generationConfig.responseSchema.properties.lines).body.generationConfig.responseSchema
    assert.equal(Object.hasOwn(schema.properties, 'recipient'), false)
    assert.equal((await invoke({ action: 'signed-url', jobId: id }, 'viewer')).status, 200)
    const failsWith = async (pattern, changeStored) => {
      const failedId = crypto.randomUUID()
      assert.equal((await invoke({ ...enqueue, jobId: failedId })).status, 200)
      const payloadPath = [...objects.keys()].find(key => key.startsWith(`purchase-statement-queue/${failedId}/`))
      changeStored?.(payloadPath)
      assert.equal((await invoke({}, 'reader', secret)).status, 200)
      await Promise.all(tasks.splice(0))
      const failed = (await db.query('select status,last_error from flexcon_purchase_statement_jobs where id=$1', [failedId])).rows[0]
      assert.equal(failed.status, 'failed')
      assert.match(failed.last_error, pattern)
      assert.doesNotMatch(failed.last_error, /private sentinel|test-secret/)
      return failed
    }
    for (const [failure,pattern] of [
      [503, /一時的に応答できません/], [429, /利用上限/], [403, /認証またはモデル設定/], [400, /解析要求を受け付け/],
      ['network', /通信に失敗/], ['timeout', /時間内に完了/], ['no-lines', /明細を1行も/],
      ['invalid', /返された結果を処理できません/], ['empty', /読取結果が返りません/], ['blocked', /制限により結果/],
    ]) {
      providerFailure = failure
      await failsWith(pattern)
    }
    providerFailure = undefined
    await failsWith(/保存画像が見つかりません/, key => objects.delete(key))
    await failsWith(/保存されたデータを開けません/, key => objects.set(key, 'invalid JSON; private sentinel'))
    failSave = true
    await failsWith(/確認待ちに保存できません/)
    assert.equal((await rpc('reviewer', 'flexcon_list_pending_purchase_statements', { p_worker_id: 'reviewer' })).length, 1)
  } finally { await db.close() }
})
