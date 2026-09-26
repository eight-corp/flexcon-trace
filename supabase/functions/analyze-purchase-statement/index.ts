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

async function classifyTaxTreatment(model: string, apiKey: string, mimeType: string, taxRegionBase64: string) {
  if (!taxRegionBase64) return ''
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { text: `これは仕切書右上の金額列見出しを拡大・高コントラスト化した画像です。「金額（税抜・税込）」のうち、手書きの丸で囲まれた文字だけを判定してください。税込が囲まれていればinclusive、税抜が囲まれていればexclusive、判断不能なら空文字を返してください。印刷された括弧ではなく、文字に重なる手書きの楕円、途切れた楕円、下線につながる囲みを確認してください。金額計算から推測しないでください。` },
        { inlineData: { mimeType, data: taxRegionBase64 } },
      ] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { tax_treatment: { type: 'STRING' } },
          required: ['tax_treatment'],
        },
        thinkingConfig: { thinkingLevel: 'LOW' },
      },
    }),
  })
  if (!response.ok) return ''
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const text = data.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text
  if (!text) return ''
  const value = (JSON.parse(text) as { tax_treatment?: unknown }).tax_treatment
  return value === 'inclusive' || value === 'exclusive' ? value : ''
}

async function generateStatement(
  models: string[],
  apiKey: string,
  mimeType: string,
  imageBase64: string,
  headerRegionBase64: string,
  taxRegionBase64: string,
  paymentRegionBase64: string,
  detailRegionBase64: string,
  productMasterNames: string[],
  originMasterNames: string[],
) {
  const productMasterPrompt = productMasterNames.length > 0
    ? `\n品名マスタ候補: ${productMasterNames.map((name) => JSON.stringify(name)).join('、')}\n画像の筆跡と一致する候補がある場合だけ、その候補の正式表記をproduct_nameへ使う。似た別銘柄へ置き換えず、一致しない場合は画像どおりに読む。`
    : ''
  const originMasterPrompt = originMasterNames.length > 0
    ? `\n産地マスタ候補: ${originMasterNames.map((name) => JSON.stringify(name)).join('、')}\n画像に一致する産地がある場合は正式表記をoriginへ使う。`
    : ''
  for (const [modelIndex, model] of models.entries()) {
    const thinkingLevel = model === 'gemini-3.1-flash-lite' ? 'MINIMAL' : 'LOW'
    let response: Response
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(modelIndex === 0 ? 20_000 : 30_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
            { text: `${prompt}${productMasterPrompt}${originMasterPrompt}` },
          { text: '仕切書全体の画像:' },
          { inlineData: { mimeType, data: imageBase64 } },
          ...(headerRegionBase64 ? [
            { text: '同じ画像の右上の見出し部分を拡大した補助画像。№と登録番号の間にある「仕入先」欄の記載をissuerとして読み取り、伝票番号と登録番号もこの画像を優先して確認する:' },
            { inlineData: { mimeType, data: headerRegionBase64 } },
          ] : []),
          ...(taxRegionBase64 ? [
            { text: '同じ画像の右上側を拡大した補助画像。金額列見出しの「税抜・税込」の囲みは、この画像を優先して判定する:' },
            { inlineData: { mimeType, data: taxRegionBase64 } },
          ] : []),
          ...(paymentRegionBase64 ? [
            { text: '同じ画像の左下側を拡大した補助画像。「現金払い・振込払い」の手書きの囲みは、この画像だけを優先して支払方法として判定する:' },
            { inlineData: { mimeType, data: paymentRegionBase64 } },
          ] : []),
          ...(detailRegionBase64 ? [
            { text: '同じ画像の明細表を拡大した補助画像。品名、数量、単価、金額はこの画像を優先し、筆跡を一文字ずつ確認する:' },
            { inlineData: { mimeType, data: detailRegionBase64 } },
          ] : []),
        ] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema,
          thinkingConfig: { thinkingLevel },
        },
      }),
      })
    } catch (error) {
      const fallbackModel = models[modelIndex + 1]
      if (fallbackModel && error instanceof DOMException && error.name === 'TimeoutError') {
        console.warn('Gemini request timed out; switching models.', { model, fallbackModel })
        continue
      }
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new GeminiUnavailableError('AI画像読取りが時間内に完了しませんでした。もう一度お試しください。')
      }
      throw error
    }
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
  const role = session.permissions?.purchase_statements
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
          origin: { type: 'STRING' },
          product_name: { type: 'STRING' },
          package_type: { type: 'STRING' },
          quantity: { type: 'NUMBER' },
          unit: { type: 'STRING' },
          unit_price: { type: 'NUMBER' },
          amount: { type: 'NUMBER' },
        },
        required: ['crop_year', 'origin', 'product_name', 'package_type', 'quantity', 'unit', 'unit_price', 'amount'],
      },
    },
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['statement_date', 'document_number', 'recipient', 'issuer', 'payment_method', 'tax_treatment', 'tax_rate', 'tax_amount', 'total_amount', 'invoice_number', 'lines', 'warnings'],
}

function looksLikePackageDescription(value: string) {
  const compact = value.replace(/\s/g, '')
  return /[（(].*[)）]/.test(compact)
    && /(?:俵|kg|㎏|袋|本|フレコン)/i.test(compact)
    && /[×xX＋+]/.test(compact)
}

const prefectureOrigins = [
  '北海道', '青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木', '群馬', '埼玉', '千葉', '東京', '神奈川',
  '新潟', '富山', '石川', '福井', '山梨', '長野', '岐阜', '静岡', '愛知', '三重', '滋賀', '京都', '大阪', '兵庫',
  '奈良', '和歌山', '鳥取', '島根', '岡山', '広島', '山口', '徳島', '香川', '愛媛', '高知', '福岡', '佐賀', '長崎',
  '熊本', '大分', '宮崎', '鹿児島', '沖縄',
]

function normalizeStatementLines(statement: Record<string, unknown>, originMasterNames: string[]) {
  if (!Array.isArray(statement.lines)) return statement
  const normalized: Array<Record<string, unknown>> = []
  const originCandidates = [...new Set([...originMasterNames, ...prefectureOrigins])].sort((left, right) => right.length - left.length)
  let previousProductName = ''
  let previousOrigin = ''
  let previousCropYear = ''

  for (const rawLine of statement.lines) {
    if (!rawLine || typeof rawLine !== 'object') continue
    const line = { ...(rawLine as Record<string, unknown>) }
    let rawProductName = typeof line.product_name === 'string' ? line.product_name.trim() : ''
    let rawOrigin = typeof line.origin === 'string' ? line.origin.trim() : ''
    const rawCropYear = typeof line.crop_year === 'string' ? line.crop_year.trim() : String(line.crop_year ?? '').trim()
    if (!rawOrigin && rawProductName) {
      const matchedOrigin = originCandidates.find((origin) => rawProductName.startsWith(origin) && rawProductName.slice(origin.length).replace(/^[\s　・:：-]+/, '').trim())
      if (matchedOrigin) {
        rawOrigin = matchedOrigin
        rawProductName = rawProductName.slice(matchedOrigin.length).replace(/^[\s　・:：-]+/, '').trim()
      }
    }
    line.origin = rawOrigin
    const rawPackageType = typeof line.package_type === 'string' ? line.package_type.trim() : ''
    const productIsPackageOnly = looksLikePackageDescription(rawProductName)
    const packageText = rawPackageType || (productIsPackageOnly ? rawProductName : '')
    const quantity = Number(line.quantity) || 0
    const unitPrice = Number(line.unit_price) || 0
    const amount = Number(line.amount) || 0
    const hasNumbers = quantity !== 0 || unitPrice !== 0 || amount !== 0
    const hasQuantityAndUnitPrice = quantity !== 0 && unitPrice !== 0

    if (!hasNumbers) {
      if (packageText && normalized.length > 0 && (productIsPackageOnly || !rawProductName)) {
        const previous = normalized[normalized.length - 1]
        const previousPackage = typeof previous.package_type === 'string' ? previous.package_type.trim() : ''
        previous.package_type = [previousPackage, packageText].filter(Boolean).join(' / ')
      }
      if (rawProductName && !productIsPackageOnly && rawProductName !== '免税') previousProductName = rawProductName
      if (rawOrigin) previousOrigin = rawOrigin
      if (/^\d{4}$/.test(rawCropYear)) previousCropYear = rawCropYear
      continue
    }

    if (hasQuantityAndUnitPrice && (productIsPackageOnly || !rawProductName) && previousProductName) {
      line.product_name = previousProductName
      line.origin = rawOrigin || previousOrigin
      line.crop_year = rawCropYear || previousCropYear
      if (!rawPackageType && packageText) line.package_type = packageText
    } else {
      line.product_name = rawProductName
    }

    if (rawProductName && !productIsPackageOnly && rawProductName !== '免税') previousProductName = rawProductName
    if (rawOrigin) previousOrigin = rawOrigin
    if (/^\d{4}$/.test(rawCropYear)) previousCropYear = rawCropYear
    normalized.push(line)
  }

  statement.lines = normalized
  return statement
}

const prompt = `
この画像は日本の仕切書です。画像に書かれている情報だけを読み取り、指定されたJSON形式で返してください。

位置を使う項目は、文字列だけでなく罫線で区切られた列と手書きの囲みを拡大して確認する。薄い、途切れている、下線とつながっている手書きの楕円も丸印として扱う。

共通項目:
- statement_date: 日付を YYYY-MM-DD 形式で返す。見えなければ空文字。
- document_number: 伝票番号。見えなければ空文字。
- recipient: 宛先欄の「担当者」と「様」の間に記載された名称だけを返す。敬称は含めない。見えなければ空文字。
- issuer: 右上の「№」欄と「登録番号」欄の間にある「仕入先」欄の会社名または氏名だけを返す。発行元の社名・印影や宛先欄の名称を混同しない。見えなければ空文字。
- payment_method: 仕切書の左下に印刷された「（現金払い・振込払い）」だけを確認する。税抜・税込の丸は支払方法と無関係である。左下の拡大画像で、手書きの丸または下線を伴う囲みが現金払いに付いていればcash、振込払いに付いていればtransferを返す。丸が文字全体を閉じていなくても、片方だけを明確に囲む筆跡なら選択済みとする。両方・印なし・判別不能なら空文字にしてwarningsへ確認事項を追加する。
- tax_treatment: 明細表の最上段右端にある金額列の見出し「金額（税抜・税込）」だけを拡大して確認する。「税抜」「税込」の文字そのものを囲む手書きの楕円を探す。税込を囲んでいればinclusive（内税）、税抜を囲んでいればexclusive（外税）を返す。下部の「税込合計金額」という印刷文字は判定に使わない。括弧や印刷文字を丸印と誤認せず、金額計算から推測しない。両方・丸なし・判別不能なら空文字にしてwarningsへ確認事項を追加する。
- tax_rate: 税率をパーセントの数値で返す（10%なら10）。見えなければ0。
- tax_amount: 消費税額を数値だけで返す。見えなければ0。
- total_amount: 税込合計金額または最終支払額を数値だけで返す。税抜小計ではない。見えなければ0。
- invoice_number: 登録番号（インボイス番号）。Tから始まる表記をそのまま返す。見えなければ空文字。

明細項目:
- 基本は、印刷された表の1行を1明細として上から順番に返す。
- 数量・単価・金額がすべて空欄の行は、独立した明細としてlinesへ入れない。その行の品名、産地、産年は次の数値入り行へ引き継ぐための情報として使い、荷姿は直前または次の対応する明細の補足情報としてだけ使う。
- 1つの品名や荷姿が複数の印刷行にまたがる場合も、数量・単価・金額がすべて空欄の行を明細件数に含めない。
- 数量列と単価列の両方に値がある行は必ず独立した明細にする。その行の品名欄が「18俵×2フレコン＋203kg」のような荷姿だけの場合は、直近の上の明細にある産年、産地、品名をそれぞれcrop_year、origin、product_nameへ引き継ぎ、荷姿の文字はpackage_typeへ入れる。荷姿を品名として扱わない。
- crop_year: その明細に明記された産年を西暦4桁で返す。和暦は西暦へ変換する。省略されている行は推測せず空文字。
- origin: 品名欄に書かれた都道府県名や地域名などの産地だけを返す（例: 「青森 青天のへきれき」なら「青森」）。記載がなければ空文字。産地をproduct_nameへ含めない。
- product_name: 産地を除いた品名だけを返す（例: 「青森 青天のへきれき」なら「青天のへきれき」）。産年と荷姿も除く。手書きの一文字ずつを確認し、特に米の銘柄を字形が似た別銘柄へ勝手に置き換えない。「青天のへきれき」は一つの正式な銘柄名であり、「萩のきらめき」と読み替えない。品名マスタ候補が提示され、画像の筆跡と一致する候補がある場合はその正式表記を使う。
- 品名が「免税」の行は商品名ではなく、インボイス登録番号のない仕入元に対する金額を表す明細である。「免税」をproduct_nameへそのまま入れ、対応する金額の絶対値に必ずマイナス符号を付けてamountへ返し、他の商品明細へ合算しない。画像上ですでにマイナスならそのまま負数にする。数量が記載されていなければquantityは0とし、架空の数量を補わない。
- package_type: 荷姿の記載を返す（例: フレコン、紙袋、30kg袋）。見えなければ空文字。
- quantity: 印刷されたタイトル行「数量」の真下にある数量列の同じ行のセルだけから数値を返す。品名列や荷姿の括弧内にある「18俵×4フレコン」「50kg×6本」などの数値は、絶対にquantityへ使わない。数量列が空欄なら0。
- unit: 数量列の同じセルに数量と一緒に書かれた単位だけを返す（例: 本、袋、俵、kg）。品名列や括弧内の単位を使わない。見えなければ空文字。
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
    if (!geminiApiKey) return jsonResponse(request, { error: 'Gemini画像読取りのAPIキーが設定されていません。' }, 503)

    const body = await request.json() as { imageBase64?: string; headerRegionBase64?: string; taxRegionBase64?: string; paymentRegionBase64?: string; detailRegionBase64?: string; productMasterNames?: unknown; originMasterNames?: unknown; mimeType?: string }
    const imageBase64 = body.imageBase64 ?? ''
    const headerRegionBase64 = body.headerRegionBase64 ?? ''
    const taxRegionBase64 = body.taxRegionBase64 ?? ''
    const paymentRegionBase64 = body.paymentRegionBase64 ?? ''
    const detailRegionBase64 = body.detailRegionBase64 ?? ''
    const productMasterNames = Array.isArray(body.productMasterNames)
      ? body.productMasterNames.filter((name): name is string => typeof name === 'string').map((name) => name.trim()).filter(Boolean).slice(0, 100)
      : []
    const originMasterNames = Array.isArray(body.originMasterNames)
      ? body.originMasterNames.filter((name): name is string => typeof name === 'string').map((name) => name.trim()).filter(Boolean).slice(0, 100)
      : []
    const mimeType = body.mimeType ?? ''
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return jsonResponse(request, { error: '対応していない画像形式です。' }, 400)
    if (!imageBase64 || imageBase64.length > 12_000_000) return jsonResponse(request, { error: '画像が大きすぎます。撮影し直してください。' }, 413)
    if (headerRegionBase64.length > 4_000_000) return jsonResponse(request, { error: '見出しの拡大画像が大きすぎます。撮影し直してください。' }, 413)
    if (taxRegionBase64.length > 4_000_000) return jsonResponse(request, { error: '税区分の拡大画像が大きすぎます。撮影し直してください。' }, 413)
    if (paymentRegionBase64.length > 4_000_000) return jsonResponse(request, { error: '支払方法の拡大画像が大きすぎます。撮影し直してください。' }, 413)
    if (detailRegionBase64.length > 6_000_000) return jsonResponse(request, { error: '明細の拡大画像が大きすぎます。撮影し直してください。' }, 413)

    const primaryModel = Deno.env.get('GEMINI_MODEL') || 'gemini-3.1-flash-lite'
    const fallbackModel = Deno.env.get('GEMINI_FALLBACK_MODEL') || 'gemini-3.7-flash'
    const models = [...new Set([primaryModel, fallbackModel].filter(Boolean))]
    let statementResult: PromiseSettledResult<unknown>
    let taxResult: PromiseSettledResult<string> = { status: 'fulfilled', value: '' }
    ;[statementResult, taxResult] = await Promise.allSettled([
      generateStatement(models, geminiApiKey, mimeType, imageBase64, headerRegionBase64, taxRegionBase64, paymentRegionBase64, detailRegionBase64, productMasterNames, originMasterNames),
      classifyTaxTreatment(models.at(-1) ?? models[0], geminiApiKey, mimeType, taxRegionBase64),
    ])
    if (statementResult.status === 'rejected') throw statementResult.reason
    const responseText = (statementResult.value as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates?.[0]?.content?.parts?.find((part) => part.text)?.text ?? ''
    if (!responseText) throw new Error('Geminiから読取結果が返りませんでした。')
    const statement = normalizeStatementLines(JSON.parse(responseText) as Record<string, unknown>, originMasterNames)
    const taxTreatment = taxResult.status === 'fulfilled' ? taxResult.value : ''
    if (taxTreatment) {
      const originalTaxTreatment = statement.tax_treatment
      statement.tax_treatment = taxTreatment
      if (originalTaxTreatment && originalTaxTreatment !== taxTreatment && Array.isArray(statement.warnings)) {
        statement.warnings.push('消費税区分は拡大画像の専用判定を優先しました。丸印を確認してください。')
      }
    }
    return jsonResponse(request, { statement, provider: 'gemini', model: models[0] })
  } catch (error) {
    const status = error instanceof GeminiUnavailableError ? 503 : 400
    return jsonResponse(request, { error: error instanceof Error ? error.message : '仕切書を解析できませんでした。' }, status)
  }
})
