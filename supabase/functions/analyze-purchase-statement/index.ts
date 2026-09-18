const allowedOrigins = new Set([
  'https://eight-corp.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

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

const retryableGeminiStatuses = new Set([429, 500, 502, 503, 504])

class GeminiUnavailableError extends Error {}

async function generateStatement(
  models: string[],
  apiKey: string,
  mimeType: string,
  imageBase64: string,
) {
  for (const [modelIndex, model] of models.entries()) {
    const thinkingLevel = model === 'gemini-3.1-flash-lite' ? 'MINIMAL' : 'LOW'
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema,
          thinkingConfig: { thinkingLevel },
        },
      }),
    })
    const responseText = await response.text()
    let data: {
      error?: { message?: string }
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    } = {}
    try { data = JSON.parse(responseText) } catch {}

    if (response.ok) return data

    const retryable = retryableGeminiStatuses.has(response.status)
    if (!retryable) throw new Error(data.error?.message ?? 'Geminiで画像を解析できませんでした。')

    console.warn('Gemini request was temporarily unavailable.', {
      model,
      status: response.status,
      message: data.error?.message,
    })
    const fallbackModel = models[modelIndex + 1]
    if (fallbackModel) {
      console.warn('Switching to fallback Gemini model.', { model, fallbackModel })
      continue
    }
    throw new GeminiUnavailableError('AI画像読取りサービスが混み合っています。少し時間をおいて、もう一度お試しください。仕切書の内容が原因ではありません。')
  }

  throw new GeminiUnavailableError('AI画像読取りサービスが混み合っています。少し時間をおいて、もう一度お試しください。')
}

type BusinessSession = {
  ok?: boolean
  workerId?: string
  permissions?: Record<string, string>
  error?: string
}

async function requireRiceShippingOperator(request: Request) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const apiKey = request.headers.get('apikey')
  const authorization = request.headers.get('authorization')
  const businessSession = request.headers.get('x-business-session')
  if (!supabaseUrl || !apiKey || !authorization || !businessSession) throw new Error('ログイン情報を確認できません。')

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/business_session`, {
    method: 'POST',
    headers: {
      apikey: apiKey,
      authorization,
      'x-business-session': businessSession,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  const session = await response.json() as BusinessSession
  const role = session.permissions?.rice_shipping
  if (!response.ok || session.ok === false || !session.workerId || !['admin', 'operator'].includes(role ?? '')) {
    throw new Error(session.error ?? '仕切書を読み取る権限がありません。')
  }
}

const responseSchema = {
  type: 'OBJECT',
  properties: {
    statement_date: { type: 'STRING' },
    document_number: { type: 'STRING' },
    recipient: { type: 'STRING' },
    issuer: { type: 'STRING' },
    payment_method: { type: 'STRING' },
    tax_treatment: { type: 'STRING' },
    tax_rate: { type: 'NUMBER' },
    tax_amount: { type: 'NUMBER' },
    total_amount: { type: 'NUMBER' },
    invoice_number: { type: 'STRING' },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          crop_year: { type: 'STRING' },
          product_name: { type: 'STRING' },
          package_type: { type: 'STRING' },
          quantity: { type: 'NUMBER' },
          unit: { type: 'STRING' },
          unit_price: { type: 'NUMBER' },
          amount: { type: 'NUMBER' },
        },
        required: ['crop_year', 'product_name', 'package_type', 'quantity', 'unit', 'unit_price', 'amount'],
      },
    },
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['statement_date', 'document_number', 'recipient', 'issuer', 'payment_method', 'tax_treatment', 'tax_rate', 'tax_amount', 'total_amount', 'invoice_number', 'lines', 'warnings'],
}

const prompt = `
この画像は日本の仕切書です。画像に書かれている情報だけを読み取り、指定されたJSON形式で返してください。

共通項目:
- statement_date: 日付を YYYY-MM-DD 形式で返す。見えなければ空文字。
- document_number: 伝票番号。見えなければ空文字。
- recipient: 宛先欄の「担当者」と「様」の間に記載された名称だけを返す。敬称は含めない。見えなければ空文字。
- issuer: 発行元の会社名または氏名。見えなければ空文字。
- payment_method: 仕切書の左下に印刷された「（現金払い・振込払い）」だけを確認する。手書きの丸で囲まれている方が現金払いならcash、振込払いならtransferを返す。括弧や印刷文字を丸印と誤認しない。両方・丸なし・判別不能なら空文字にしてwarningsへ確認事項を追加する。
- tax_treatment: 仕切書の右上に印刷された「金額（税抜・税込）」だけを確認する。手書きの丸で囲まれている方が税抜ならexclusive（外税）、税込ならinclusive（内税）を返す。括弧や印刷文字を丸印と誤認せず、金額計算から推測しない。両方・丸なし・判別不能なら空文字にしてwarningsへ確認事項を追加する。
- tax_rate: 税率をパーセントの数値で返す（10%なら10）。見えなければ0。
- tax_amount: 消費税額を数値だけで返す。見えなければ0。
- total_amount: 税込合計金額または最終支払額を数値だけで返す。税抜小計ではない。見えなければ0。
- invoice_number: 登録番号（インボイス番号）。Tから始まる表記をそのまま返す。見えなければ空文字。

明細項目:
- linesは明細を上から順番に返す。同じ明細の情報が複数行にまたがっている場合は、罫線と上下左右の位置関係を確認して1件に結合する。改行ごとに別明細へ分割しない。
- crop_year: その明細に明記された産年を西暦4桁で返す。和暦は西暦へ変換する。省略されている行は推測せず空文字。
- product_name: 品名。産年と荷姿は除く。
- 品名が「免税」の行は商品名ではなく、インボイス登録番号のない仕入元に対する金額を表す明細である。「免税」をproduct_nameへそのまま入れ、対応する金額の絶対値に必ずマイナス符号を付けてamountへ返し、他の商品明細へ合算しない。画像上ですでにマイナスならそのまま負数にする。数量が記載されていなければquantityは0とし、架空の数量を補わない。
- package_type: 荷姿の記載を返す（例: フレコン、紙袋、30kg袋）。見えなければ空文字。
- quantity: 数量を数値だけで返す。見えなければ0。
- unit: 数量の単位を返す（例: 本、袋、俵、kg）。見えなければ空文字。
- unit_price: 単価を数値だけで返す。見えなければ0。
- amount: その明細の金額を数値だけで返す。見えなければ0。

明細ごとに数量×単価と金額を照合し、明細金額の合計、消費税額、税込合計金額の関係も確認する。不一致、読めない文字、確信の低い箇所は作り足さず、warningsへ日本語で記載する。
`

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  if (request.method !== 'POST') return jsonResponse(request, { error: 'POSTで送信してください。' }, 405)

  try {
    await requireRiceShippingOperator(request)
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY')
    if (!geminiApiKey) return jsonResponse(request, { error: 'Gemini APIキーが設定されていません。' }, 503)

    const body = await request.json() as { imageBase64?: string; mimeType?: string }
    const imageBase64 = body.imageBase64 ?? ''
    const mimeType = body.mimeType ?? ''
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return jsonResponse(request, { error: '対応していない画像形式です。' }, 400)
    if (!imageBase64 || imageBase64.length > 12_000_000) return jsonResponse(request, { error: '画像が大きすぎます。撮影し直してください。' }, 413)

    const primaryModel = Deno.env.get('GEMINI_MODEL') || 'gemini-3.1-flash-lite'
    const fallbackModel = Deno.env.get('GEMINI_FALLBACK_MODEL') || 'gemini-3.7-flash'
    const models = [...new Set([primaryModel, fallbackModel].filter(Boolean))]
    const geminiData = await generateStatement(models, geminiApiKey, mimeType, imageBase64)
    const responseText = geminiData.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text
    if (!responseText) throw new Error('Geminiから読取結果が返りませんでした。')
    const statement = JSON.parse(responseText)
    return jsonResponse(request, { statement })
  } catch (error) {
    const status = error instanceof GeminiUnavailableError ? 503 : 400
    return jsonResponse(request, { error: error instanceof Error ? error.message : '仕切書を解析できませんでした。' }, status)
  }
})
