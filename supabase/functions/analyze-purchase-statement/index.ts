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
    settlement_no: { type: 'STRING' },
    crop_year: { type: 'STRING' },
    purchased_at: { type: 'STRING' },
    origin: { type: 'STRING' },
    producer_name: { type: 'STRING' },
    purchase_price: { type: 'NUMBER' },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          product_name: { type: 'STRING' },
          package_type: { type: 'STRING', enum: ['FL', '紙袋', 'その他'] },
          quantity: { type: 'NUMBER' },
          unit: { type: 'STRING', enum: ['俵', 'kg', '本', '袋'] },
        },
        required: ['product_name', 'package_type', 'quantity', 'unit'],
      },
    },
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['settlement_no', 'crop_year', 'purchased_at', 'origin', 'producer_name', 'purchase_price', 'lines', 'warnings'],
}

const prompt = `
この画像は日本の米穀の仕切書です。画像に書かれている情報だけを読み取り、指定されたJSON形式で返してください。

- settlement_no: 仕切書番号。見えなければ空文字。
- crop_year: 産年を西暦4桁で返す。和暦の場合は西暦へ変換する。見えなければ空文字。
- purchased_at: 仕入日を YYYY-MM-DD 形式で返す。見えなければ空文字。
- origin: 産地の都道府県名。「青森県」のように都道府県まで付ける。見えなければ空文字。
- producer_name: 仕入元、生産者、販売者に相当する氏名または名称。見えなければ空文字。
- purchase_price: 仕切書全体の最終合計・支払額（税込）を数値だけで返す。単価や税抜小計ではない。見えない、または確信が持てない場合は0。
- lines: 米穀の明細だけを上から順番に返す。金額、単価、税額は含めない。
- product_name: 品名から包装表記を除いた名称。
- package_type: フレコン、FL、フレキシブルコンテナは「FL」。紙袋は「紙袋」。判別できない場合は「その他」。
- quantity と unit: 記載された数量と単位をそのまま返す。推測でkg換算しない。
- 読めない文字や確信の低い箇所は作り足さず、warningsへ日本語で記載する。
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

    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-3.8-flash'
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': geminiApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema,
        },
      }),
    })
    const geminiData = await geminiResponse.json() as {
      error?: { message?: string }
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    if (!geminiResponse.ok) throw new Error(geminiData.error?.message ?? 'Geminiで画像を解析できませんでした。')
    const responseText = geminiData.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text
    if (!responseText) throw new Error('Geminiから読取結果が返りませんでした。')
    const statement = JSON.parse(responseText)
    return jsonResponse(request, { statement })
  } catch (error) {
    return jsonResponse(request, { error: error instanceof Error ? error.message : '仕切書を解析できませんでした。' }, 400)
  }
})
