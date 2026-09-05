import { PDFDocument, PrintScaling } from 'pdf-lib'

export type GradingNoticeRecord = {
  authorizationNo: string
  fullName: string
  prefecture: string
  municipality: string
  feedRiceVariety: string
  inspectionDate: string
  inspectionLocation: string
  fiscalYear: number
  brand: string
  grade: string
  reason: string
  kind: 'flexcon' | 'paper_bag'
  quantity: number
  moisture: number | null
}

type GradingNoticePage = Omit<GradingNoticeRecord, 'quantity' | 'moisture'> & {
  quantity: number
  moistureAverage: number | null
}

const PAGE_WIDTH = 841.68
const PAGE_HEIGHT = 595.2
const CANVAS_SCALE = 2
const FONT_SCALE = 1.1
const TEXT_VERTICAL_OFFSET = 1.25
const FONT_FAMILY = '"Yu Gothic", "Meiryo", "Noto Sans JP", sans-serif'

function normalized(value: string) {
  return value.trim()
}

function isFeedRice(brand: string) {
  return normalized(brand) === '飼料用玄米'
}

function groupKey(record: GradingNoticeRecord) {
  return JSON.stringify([
    normalized(record.authorizationNo),
    record.inspectionDate,
    normalized(record.inspectionLocation),
    record.fiscalYear,
    normalized(record.brand),
    normalized(record.grade),
    normalized(record.reason),
    record.kind,
  ])
}

export function aggregateGradingNoticeRecords(records: GradingNoticeRecord[]): GradingNoticePage[] {
  const grouped = new Map<string, { page: GradingNoticePage; moistureTotal: number; moistureCount: number }>()

  for (const source of records) {
    const record = {
      ...source,
      authorizationNo: normalized(source.authorizationNo),
      fullName: normalized(source.fullName),
      prefecture: normalized(source.prefecture),
      municipality: normalized(source.municipality),
      feedRiceVariety: normalized(source.feedRiceVariety),
      inspectionLocation: normalized(source.inspectionLocation),
      brand: normalized(source.brand),
      grade: normalized(source.grade),
      reason: normalized(source.reason),
    }
    const key = groupKey(record)
    const current = grouped.get(key)
    const moisture = record.moisture !== null && Number.isFinite(record.moisture) ? record.moisture : null
    if (current) {
      current.page.quantity += record.quantity
      if (moisture !== null) {
        current.moistureTotal += moisture
        current.moistureCount += 1
      }
      continue
    }
    grouped.set(key, {
      page: { ...record, quantity: record.quantity, moistureAverage: moisture },
      moistureTotal: moisture ?? 0,
      moistureCount: moisture === null ? 0 : 1,
    })
  }

  const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })
  return [...grouped.values()].map(({ page, moistureTotal, moistureCount }) => ({
    ...page,
    quantity: Math.round(page.quantity),
    moistureAverage: moistureCount > 0 ? Math.round((moistureTotal / moistureCount) * 10) / 10 : null,
  })).sort((left, right) => (
    collator.compare(left.authorizationNo, right.authorizationNo)
    || left.inspectionDate.localeCompare(right.inspectionDate)
    || collator.compare(left.inspectionLocation, right.inspectionLocation)
    || left.fiscalYear - right.fiscalYear
    || collator.compare(left.brand, right.brand)
    || collator.compare(left.grade, right.grade)
    || collator.compare(left.reason, right.reason)
    || left.kind.localeCompare(right.kind)
  ))
}

function setFont(context: CanvasRenderingContext2D, size: number, weight = 600) {
  context.font = `${weight} ${size * FONT_SCALE}px ${FONT_FAMILY}`
}

function fittedFontSize(context: CanvasRenderingContext2D, text: string, width: number, size: number, minimumSize = 7) {
  let fitted = size
  setFont(context, fitted)
  while (fitted > minimumSize && context.measureText(text).width > width) {
    fitted -= 0.25
    setFont(context, fitted)
  }
  return fitted
}

function drawTextInBox(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  size: number,
  align: CanvasTextAlign = 'center',
  minimumSize = 7,
  weight = 600,
) {
  const value = text.trim()
  if (!value) return
  const fitted = fittedFontSize(context, value, width - 8, size, minimumSize)
  setFont(context, fitted, weight)
  context.textAlign = align
  context.textBaseline = 'middle'
  const textX = align === 'left' ? x + 5 : align === 'right' ? x + width - 5 : x + width / 2
  context.fillText(value, textX, y + height / 2 + TEXT_VERTICAL_OFFSET)
}

function japaneseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return ''
  return `令和 ${year - 2018} 年 ${month} 月 ${day} 日`
}

function createOverlayCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(PAGE_WIDTH * CANVAS_SCALE)
  canvas.height = Math.round(PAGE_HEIGHT * CANVAS_SCALE)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('格付結果通知書の描画領域を作成できませんでした。')
  context.scale(CANVAS_SCALE, CANVAS_SCALE)
  context.fillStyle = '#000'
  return { canvas, context }
}

function drawGradingNoticeOverlay(page: GradingNoticePage) {
  const { canvas, context } = createOverlayCanvas()
  const quantityUnit = page.kind === 'paper_bag' ? '袋' : 'kg'
  const packaging = page.kind === 'paper_bag' ? '紙袋・30kg' : '推フレ'
  const requestQuantity = `${page.quantity.toLocaleString('ja-JP')}${quantityUnit}`
  const moisture = page.moistureAverage === null ? '' : page.moistureAverage.toFixed(1)

  drawTextInBox(context, page.authorizationNo, 704.4, 126.6, 94.2, 25.2, 10)
  drawTextInBox(context, japaneseDate(page.inspectionDate), 151.8, 151.8, 139.8, 24.6, 10)
  drawTextInBox(context, String(page.fiscalYear), 346.8, 151.8, 53.4, 24.6, 12)
  drawTextInBox(context, page.prefecture, 97.8, 176.4, 108, 25.2, 10)
  drawTextInBox(context, `株式会社エイト　${page.inspectionLocation}`, 291.6, 176.4, 327, 25.2, 10, 'left', 7)
  drawTextInBox(context, page.fullName, 618.6, 176.4, 180, 25.2, 10, 'center', 7)
  drawTextInBox(context, page.municipality, 205.8, 201.6, 141, 24.6, 10)
  drawTextInBox(context, packaging, 454.8, 201.6, 343.8, 24.6, 10, 'left')
  drawTextInBox(context, requestQuantity, 346.8, 226.2, 108, 25.2, 10)

  if (!isFeedRice(page.brand)) {
    drawTextInBox(context, page.brand, 42, 279.6, 109.8, 111, 18, 'center', 9)
  }
  drawTextInBox(context, page.grade, 151.8, 279.6, 108.6, 111, 24, 'center', 10)
  drawTextInBox(context, page.quantity.toLocaleString('ja-JP'), 260.4, 279.6, 86.4, 92, 23, 'center', 10)
  drawTextInBox(context, quantityUnit, 315, 367.5, 27, 20, 14, 'right', 10)
  drawTextInBox(context, moisture, 346.8, 279.6, 108, 92, 23, 'center', 10)
  drawTextInBox(context, page.reason, 454.8, 279.6, 163.8, 111, 18, 'center', 8)
  if (isFeedRice(page.brand)) {
    drawTextInBox(context, page.feedRiceVariety, 672.5, 293.8, 126, 14.4, 8.5, 'left', 6)
  }

  drawTextInBox(context, japaneseDate(page.inspectionDate), 97.8, 423.6, 162.6, 13.5, 10, 'left', 8)
  drawTextInBox(context, page.fullName, 97.8, 450.6, 162.6, 13.5, 10, 'right', 7)
  return canvas
}

function canvasToPng(canvas: HTMLCanvasElement) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('格付結果通知書の画像を作成できませんでした。'))
      resolve(await blob.arrayBuffer())
    }, 'image/png')
  })
}

export async function generateGradingNoticePdf(records: GradingNoticeRecord[]) {
  const pages = aggregateGradingNoticeRecords(records)
  if (pages.length === 0) throw new Error('格付結果通知書に出力できる検査記録がありません。')

  const [standardTemplateResponse, feedTemplateResponse] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}grading-notice-template.pdf`),
    fetch(`${import.meta.env.BASE_URL}grading-notice-feed-template.pdf`),
  ])
  if (!standardTemplateResponse.ok || !feedTemplateResponse.ok) {
    throw new Error('格付結果通知書のひな型を読み込めませんでした。')
  }
  const [standardTemplateBytes, feedTemplateBytes] = await Promise.all([
    standardTemplateResponse.arrayBuffer(),
    feedTemplateResponse.arrayBuffer(),
  ])
  const pdf = await PDFDocument.create()
  const [standardTemplatePage] = await pdf.embedPdf(standardTemplateBytes, [0])
  const [feedTemplatePage] = await pdf.embedPdf(feedTemplateBytes, [0])
  const viewerPreferences = pdf.catalog.getOrCreateViewerPreferences()
  viewerPreferences.setPrintScaling(PrintScaling.None)
  viewerPreferences.setPickTrayByPDFSize(true)

  for (const noticePage of pages) {
    const overlay = await pdf.embedPng(await canvasToPng(drawGradingNoticeOverlay(noticePage)))
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    const templatePage = isFeedRice(noticePage.brand) ? feedTemplatePage : standardTemplatePage
    page.drawPage(templatePage, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT })
    page.drawImage(overlay, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT })
  }

  pdf.setTitle('格付結果通知書')
  pdf.setSubject('検査格付結果通知票')
  pdf.setCreator('(株)エイト 米穀出荷管理')
  const savedBytes = await pdf.save()
  const savedBuffer = savedBytes.buffer.slice(savedBytes.byteOffset, savedBytes.byteOffset + savedBytes.byteLength) as ArrayBuffer
  return { blob: new Blob([savedBuffer], { type: 'application/pdf' }), pageCount: pages.length }
}
