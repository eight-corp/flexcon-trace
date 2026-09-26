const allowedOrigins = new Set([
  'https://eight-corp.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

const bucketName = 'purchase-statement-images'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://eight-corp.github.io',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-business-session',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function jsonResponse(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8' },
  })
}

type BusinessSession = {
  ok?: boolean
  workerId?: string
  permissions?: Record<string, string>
  error?: string
}

async function requirePurchaseStatementUser(request: Request, allowedRoles: string[]) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const apiKey = request.headers.get('apikey')
  const authorization = request.headers.get('authorization')
  const businessSession = request.headers.get('x-business-session')
  if (!supabaseUrl || !apiKey || !authorization || !businessSession) throw new Error('ログイン情報を確認できません。')

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/business_session`, {
    method: 'POST',
    headers: { apikey: apiKey, authorization, 'x-business-session': businessSession, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const session = await response.json() as BusinessSession
  const role = session.permissions?.purchase_statements ?? ''
  if (!response.ok || session.ok === false || !session.workerId || !allowedRoles.includes(role)) {
    throw new Error(session.error ?? '仕切書画像を利用する権限がありません。')
  }
  return { workerId: session.workerId, role }
}

function serviceHeaders(contentType = 'application/json') {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) throw new Error('画像保存サービスの設定がありません。')
  return { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'Content-Type': contentType }
}

async function statementImagePath(statementId: string) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) throw new Error('Supabaseの設定がありません。')
  const response = await fetch(`${supabaseUrl}/rest/v1/flexcon_purchase_statements?id=eq.${encodeURIComponent(statementId)}&select=image_path`, {
    headers: serviceHeaders(),
  })
  const rows = await response.json() as Array<{ image_path?: string }>
  if (!response.ok || rows.length !== 1) throw new Error('仕切書が見つかりません。')
  return rows[0].image_path ?? ''
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  if (request.method !== 'POST') return jsonResponse(request, { error: 'POSTで送信してください。' }, 405)

  try {
    const body = await request.json() as { action?: string; statementId?: string; imageBase64?: string; mimeType?: string; imagePath?: string }
    const action = body.action ?? ''
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    if (!supabaseUrl) throw new Error('Supabaseの設定がありません。')

    if (action === 'upload') {
      await requirePurchaseStatementUser(request, ['admin', 'operator'])
      const statementId = body.statementId ?? ''
      const imageBase64 = body.imageBase64 ?? ''
      if (!uuidPattern.test(statementId)) throw new Error('仕切書IDが不正です。')
      if (body.mimeType !== 'image/jpeg') throw new Error('保存できる画像形式はJPEGです。')
      if (!imageBase64 || imageBase64.length > 12_000_000) throw new Error('画像が大きすぎます。')
      await statementImagePath(statementId)

      const imagePath = `${statementId}/original.jpg`
      const bytes = Uint8Array.from(atob(imageBase64), (character) => character.charCodeAt(0))
      const upload = await fetch(`${supabaseUrl}/storage/v1/object/${bucketName}/${imagePath}`, {
        method: 'POST',
        headers: { ...serviceHeaders('image/jpeg'), 'x-upsert': 'true', 'cache-control': '3600' },
        body: bytes,
      })
      if (!upload.ok) throw new Error('仕切書画像をStorageへ保存できませんでした。')

      const update = await fetch(`${supabaseUrl}/rest/v1/flexcon_purchase_statements?id=eq.${encodeURIComponent(statementId)}`, {
        method: 'PATCH',
        headers: { ...serviceHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({ image_path: imagePath, updated_at: new Date().toISOString() }),
      })
      if (!update.ok) throw new Error('仕切書と画像を紐付けできませんでした。')
      return jsonResponse(request, { imagePath })
    }

    if (action === 'signed-url') {
      await requirePurchaseStatementUser(request, ['admin', 'operator', 'viewer'])
      const statementId = body.statementId ?? ''
      if (!uuidPattern.test(statementId)) throw new Error('仕切書IDが不正です。')
      const imagePath = await statementImagePath(statementId)
      if (!imagePath) throw new Error('保存された画像がありません。')
      const signed = await fetch(`${supabaseUrl}/storage/v1/object/sign/${bucketName}/${imagePath}`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify({ expiresIn: 600 }),
      })
      const result = await signed.json() as { signedURL?: string; signedUrl?: string }
      const signedPath = result.signedURL ?? result.signedUrl
      if (!signed.ok || !signedPath) throw new Error('仕切書画像を開けませんでした。')
      const signedUrl = signedPath.startsWith('http') ? signedPath : `${supabaseUrl}/storage/v1${signedPath}`
      return jsonResponse(request, { signedUrl })
    }

    if (action === 'delete') {
      await requirePurchaseStatementUser(request, ['admin'])
      const imagePath = body.imagePath ?? ''
      if (!/^[0-9a-f-]{36}\/original\.jpg$/i.test(imagePath)) throw new Error('画像パスが不正です。')
      const removal = await fetch(`${supabaseUrl}/storage/v1/object/${bucketName}/${imagePath}`, {
        method: 'DELETE',
        headers: serviceHeaders(),
      })
      if (!removal.ok && removal.status !== 404) throw new Error('仕切書画像を削除できませんでした。')
      return jsonResponse(request, { ok: true })
    }

    return jsonResponse(request, { error: '操作が不正です。' }, 400)
  } catch (error) {
    return jsonResponse(request, { error: error instanceof Error ? error.message : '仕切書画像を処理できませんでした。' }, 400)
  }
})
