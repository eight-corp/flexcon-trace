import { analyzePurchaseStatement, validateAnalysisInput, type AnalysisInput } from '../analyze-purchase-statement/index.ts'

const origins = new Set(['https://eight-corp.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const imageBucket = 'purchase-statement-images'
const payloadBucket = 'purchase-statement-queue'
declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void }

function response(request: Request, body: unknown, status = 200) {
  const origin = request.headers.get('origin') ?? ''
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origins.has(origin) ? origin : 'https://eight-corp.github.io',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-business-session',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin',
  } })
}

function serviceHeaders() {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!key) throw new Error('解析サービスの設定がありません。')
  return { apikey: key, authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

function baseUrl() {
  const url = Deno.env.get('SUPABASE_URL')
  if (!url) throw new Error('Supabaseの設定がありません。')
  return url
}

async function rpc<T>(name: string, args: unknown, headers: Record<string, string>) {
  const result = await fetch(`${baseUrl()}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args) })
  const data = await result.json()
  if (!result.ok) throw new Error(data.message ?? '待ち行列を更新できませんでした。')
  return data as T
}

async function session(request: Request, writing: boolean) {
  const headers = Object.fromEntries(['apikey', 'authorization', 'x-business-session'].map(key => [key, request.headers.get(key) ?? '']))
  if (Object.values(headers).some(value => !value)) throw new Error('ログイン情報を確認できません。')
  const user = await rpc<{ ok: boolean; workerId?: string; permissions?: Record<string, string> }>('business_session', {}, { ...headers, 'Content-Type': 'application/json' })
  if (!user.ok || !user.workerId || !(writing ? ['admin', 'operator'] : ['admin', 'operator', 'viewer']).includes(user.permissions?.purchase_statements ?? '')) throw new Error('仕切書を利用する権限がありません。')
  return { workerId: user.workerId, headers: { ...headers, 'Content-Type': 'application/json' } }
}

async function upload(bucket: string, path: string, body: string | Uint8Array, contentType: string) {
  const result = await fetch(`${baseUrl()}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST', headers: { ...serviceHeaders(), 'Content-Type': contentType, 'x-upsert': 'false' }, body,
  })
  if (!result.ok) {
    const data = await result.json().catch(() => ({}))
    // A lost acknowledgement must not require a second immutable image or a second job.
    if (result.status !== 409 && String(data.statusCode) !== '409') throw new Error('画像を保存できませんでした。再試行してください。')
  }
}

export function reviewPayload(statement: Record<string, unknown>) {
  if (!Array.isArray(statement.lines) || !statement.lines.length) throw new Error('仕切書の明細を読み取れませんでした。')
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const positive = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null
  let cropYear: string | null = null
  const warnings = Array.isArray(statement.warnings) ? statement.warnings.filter((value): value is string => typeof value === 'string') : []
  const items = statement.lines.map((line: Record<string, unknown>, index: number) => {
    const year = Number(line.crop_year)
    if (Number.isInteger(year) && year >= 1900 && year <= 2100) cropYear = String(year)
    else if (!cropYear) warnings.push(`${index + 1}行目の産年を読み取れず、直前の産年もありません。`)
    const product = text(line.product_name)
    return { crop_year: cropYear, origin: text(line.origin), product_name: product, package_type: text(line.package_type),
      quantity: positive(line.quantity), unit: text(line.unit), unit_price: positive(line.unit_price),
      amount: product === '免税' && Number.isFinite(Number(line.amount)) && Number(line.amount) !== 0 ? -Math.abs(Number(line.amount)) : positive(line.amount) }
  })
  return { header: {
    statement_date: text(statement.statement_date).match(/^\d{4}-\d{2}-\d{2}$/)?.[0] ?? '',
    document_number: text(statement.document_number), recipient: text(statement.recipient), issuer: text(statement.issuer),
    payment_method: ['cash', 'transfer'].includes(text(statement.payment_method)) ? text(statement.payment_method) : '',
    tax_treatment: ['exclusive', 'inclusive'].includes(text(statement.tax_treatment)) ? text(statement.tax_treatment) : '',
    tax_rate: positive(statement.tax_rate), tax_amount: positive(statement.tax_amount), total_amount: positive(statement.total_amount), invoice_number: text(statement.invoice_number),
  }, items, warnings: [...new Set(warnings.filter(Boolean))] }
}

type ClaimedJob = { id: string; leaseToken: string; payloadPath: string }

async function processJob(job: ClaimedJob) {
  const headers = serviceHeaders()
  try {
    const stored = await fetch(`${baseUrl()}/storage/v1/object/authenticated/${payloadBucket}/${job.payloadPath}`, { headers })
    if (!stored.ok) throw new Error('保存画像を取得できませんでした。再試行してください。')
    const input = await stored.json() as AnalysisInput
    const result = await analyzePurchaseStatement(input)
    const payload = reviewPayload(result.statement)
    await rpc('flexcon_purchase_queue_complete', { p_job_id: job.id, p_lease_token: job.leaseToken, p_header: payload.header, p_items: payload.items, p_warnings: payload.warnings }, headers)
  } catch (error) {
    // Never store provider responses, credentials or image contents in public status messages.
    console.error('Purchase statement job failed', { jobId: job.id, error: error instanceof Error ? error.message : 'unknown' })
    await rpc('flexcon_purchase_queue_fail', { p_job_id: job.id, p_lease_token: job.leaseToken, p_error: '解析を完了できませんでした。時間をおいて再試行してください。' }, headers)
  }
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return response(request, {})
  if (request.method !== 'POST') return response(request, { error: 'POSTで送信してください。' }, 405)
  try {
    const secret = request.headers.get('x-queue-secret')
    if (secret) {
      // The database authenticates this secret before claiming any work. Cron retries expired leases.
      const job = await rpc<ClaimedJob | null>('flexcon_purchase_queue_claim', { p_secret: secret }, serviceHeaders())
      if (job) EdgeRuntime.waitUntil(processJob(job).catch(error => console.error('Queue lease will be retried', { jobId: job.id, error: String(error) })))
      return response(request, { ok: true })
    }
    const body = await request.json() as { action?: string; jobId?: string; image?: AnalysisInput }
    const user = await session(request, body.action !== 'signed-url')
    if (!uuid.test(body.jobId ?? '')) throw new Error('画像IDが不正です。')
    if (body.action === 'signed-url') {
      const path = await rpc<string>('flexcon_purchase_queue_image', { p_worker_id: user.workerId, p_job_id: body.jobId }, user.headers)
      const signed = await fetch(`${baseUrl()}/storage/v1/object/sign/${imageBucket}/${path}`, { method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ expiresIn: 600 }) })
      const data = await signed.json()
      const url = data.signedURL ?? data.signedUrl
      if (!signed.ok || !url) throw new Error('画像を開けませんでした。')
      return response(request, { signedUrl: url.startsWith('http') ? url : `${baseUrl()}/storage/v1${url}` })
    }
    if (body.action !== 'enqueue' || !body.image || body.image.mimeType !== 'image/jpeg') throw new Error('撮影画像がありません。')
    validateAnalysisInput(body.image)
    const json = JSON.stringify(body.image)
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))].map(value => value.toString(16).padStart(2, '0')).join('')
    const job = await rpc<{ id: string; status: string; uploadId: string }>('flexcon_purchase_queue_reserve', { p_worker_id: user.workerId, p_job_id: body.jobId, p_fingerprint: fingerprint }, user.headers)
    if (job.status === 'uploading') {
      const path = `${job.id}/${job.uploadId}`
      const bytes = Uint8Array.from(atob(body.image.imageBase64!), character => character.charCodeAt(0))
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('JPEG画像を確認できませんでした。撮影し直してください。')
      await upload(imageBucket, `${path}.jpg`, bytes, 'image/jpeg')
      await upload(payloadBucket, `${path}.json`, json, 'application/json')
      await rpc('flexcon_purchase_queue_ready', { p_worker_id: user.workerId, p_job_id: job.id }, user.headers)
    }
    return response(request, { jobId: job.id, status: job.status === 'uploading' ? 'queued' : job.status })
  } catch (error) {
    return response(request, { error: error instanceof Error ? error.message : '画像を保存できませんでした。' }, 400)
  }
})
