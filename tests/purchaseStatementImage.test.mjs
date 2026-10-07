import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const code = ts.transpile(fs.readFileSync('supabase/functions/purchase-statement-image/index.ts', 'utf8'), { target: ts.ScriptTarget.ESNext })
const id = '10000000-0000-4000-8000-000000000001'
function imageService({ actor = 'reader', role = 'operator', confirmed = false, legacy = false, imagePath = '', uploadStatus = 200, patchMissing = false } = {}) {
  const calls = []
  let handler
  let path = imagePath
  vm.runInNewContext(code, {
    Request, Response, Uint8Array, atob, Date, Set, Error,
    Deno: { serve: callback => { handler = callback }, env: { get: key => key === 'SUPABASE_URL' ? 'https://supabase.test' : 'fake-service-key' } },
    fetch: async (input, options = {}) => {
      const url = new URL(input)
      calls.push({ url, options })
      const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.pathname === '/rest/v1/rpc/business_session') return response({ ok: true, workerId: actor, permissions: { purchase_statements: role } })
      if (url.pathname === '/rest/v1/flexcon_purchase_statements' && !options.method) return response(legacy ? [{ image_path: path }] : [])
      if (url.pathname === '/rest/v1/flexcon_purchase_statement_drafts' && !options.method) return response([{ image_path: path, created_by_worker_id: 'reader', confirmed_at: confirmed ? '2026-10-07' : null }])
      if (url.pathname.startsWith('/storage/v1/object/sign/')) return response({ signedURL: `/object/sign/purchase-statement-images/${path}?token=fake` })
      if (url.pathname.startsWith('/storage/v1/object/')) return response({}, uploadStatus)
      if (options.method === 'PATCH') {
        if (patchMissing) return response([])
        path = JSON.parse(options.body).image_path
        return response([{ image_path: path }])
      }
      throw new Error(`Unexpected request ${input}`)
    },
  })
  const invoke = body => handler(new Request('https://edge.test', { method: 'POST', headers: { apikey: 'fake-key', authorization: 'Bearer fake-token', 'x-business-session': 'fake-session', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
  return { invoke, calls }
}
const upload = { action: 'upload', statementId: id, imageBase64: 'AQID', mimeType: 'image/jpeg' }

test('pending image uploads are restricted to the reader and cannot replace review evidence', async () => {
  for (const options of [{ actor: 'reviewer' }, { confirmed: true }, { role: 'viewer' }]) {
    const service = imageService(options)
    assert.equal((await service.invoke(upload)).status, 400)
    assert.equal(service.calls.some(call => call.url.pathname.startsWith('/storage/')), false)
  }
  const service = imageService()
  const result = await service.invoke(upload)
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { imagePath: `${id}/original.jpg` })
  const storage = service.calls.find(call => call.url.pathname.startsWith('/storage/'))
  assert.equal(storage.options.headers['x-upsert'], 'false')
  const patch = service.calls.find(call => call.options.method === 'PATCH')
  assert.equal(patch.url.pathname, '/rest/v1/flexcon_purchase_statement_drafts')
  assert.equal(patch.url.searchParams.get('confirmed_at'), 'is.null')
  const count = service.calls.length
  assert.equal((await service.invoke(upload)).status, 200)
  assert.equal(service.calls.slice(count).some(call => call.url.pathname.startsWith('/storage/')), false)
})

test('storage and linking failures never report success, retries recover uploaded files', async () => {
  assert.equal((await imageService({ uploadStatus: 500 }).invoke(upload)).status, 400)
  assert.equal((await imageService({ patchMissing: true }).invoke(upload)).status, 400)
  assert.equal((await imageService({ uploadStatus: 409 }).invoke(upload)).status, 200)
  const legacy = imageService({ legacy: true })
  assert.equal((await legacy.invoke(upload)).status, 200)
  assert.equal(legacy.calls.find(call => call.url.pathname.startsWith('/storage/')).options.headers['x-upsert'], 'true')
  const viewing = imageService({ actor: 'reviewer', imagePath: `${id}/original.jpg` })
  const signed = await viewing.invoke({ action: 'signed-url', statementId: id })
  assert.equal(signed.status, 200)
  assert.match((await signed.json()).signedUrl, /original.jpg/)
})
