import { PDFDocument, PrintScaling } from 'pdf-lib'

export type InspectionLedgerAuthorization = {
  authorizationNo: string
  fullName: string
  address: string
}

export type InspectionLedgerRecord = {
  fiscalYear: number
  purchaseDate: string
  inspectionDate: string
  inspectorName: string
  inspectionLocation: string
  origin: string
  brand: string
  grade: string
  reason: string
  kind: 'flexcon' | 'paper_bag'
  quantityCount: number
  weightKg: number
  moisture: number | null
}

type AggregatedLedgerRecord = InspectionLedgerRecord & {
  moistureAverage: number | null
}

type InspectionLedgerData = {
  authorization: InspectionLedgerAuthorization
  records: InspectionLedgerRecord[]
}

const PAGE_WIDTH = 841.68
const PAGE_HEIGHT = 595.2
const CANVAS_SCALE = 2
const ROWS_PER_PAGE = 12
const FONT_FAMILY = '"Yu Mincho", "YuMincho", serif'
const DATA_TOP = 192.48
const DATA_ROW_HEIGHT = 28.56

const GRADE_COLUMNS: Record<string, { x: number; width: number }> = {
  '1等': { x: 340.32, width: 26.4 },
  '2等': { x: 366.72, width: 26.4 },
  '合格': { x: 393.12, width: 26.4 },
  '3等': { x: 419.52, width: 26.4 },
}

function normalized(value: string) {
  return value.trim()
}

function recordKey(record: InspectionLedgerRecord) {
  return JSON.stringify([
    record.inspectionDate,
    record.purchaseDate,
    normalized(record.inspectionLocation),
    record.fiscalYear,
    normalized(record.origin),
    normalized(record.brand),
    record.kind,
    record.weightKg,
    normalized(record.grade),
    normalized(record.reason),
    normalized(record.inspectorName),
  ])
}

export function aggregateInspectionLedgerRecords(records: InspectionLedgerRecord[]) {
  const grouped = new Map<string, {
    record: AggregatedLedgerRecord
    moistureTotal: number
    moistureQuantity: number
  }>()

  records.forEach((source) => {
    const record = {
      ...source,
      inspectorName: normalized(source.inspectorName),
      inspectionLocation: normalized(source.inspectionLocation),
      origin: normalized(source.origin),
      brand: normalized(source.brand),
      grade: normalized(source.grade),
      reason: normalized(source.reason),
    }
    const key = recordKey(record)
    const moisture = record.moisture !== null && Number.isFinite(record.moisture) ? record.moisture : null
    const current = grouped.get(key)
    if (current) {
      current.record.quantityCount += record.quantityCount
      if (moisture !== null) {
        current.moistureTotal += moisture * record.quantityCount
        current.moistureQuantity += record.quantityCount
      }
      return
    }
    grouped.set(key, {
      record: { ...record, moistureAverage: moisture },
      moistureTotal: moisture === null ? 0 : moisture * record.quantityCount,
      moistureQuantity: moisture === null ? 0 : record.quantityCount,
    })
  })

  const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })
  return [...grouped.values()].map(({ record, moistureTotal, moistureQuantity }) => ({
    ...record,
    moistureAverage: moistureQuantity > 0 ? Math.round((moistureTotal / moistureQuantity) * 10) / 10 : null,
  })).sort((left, right) => (
    left.inspectionDate.localeCompare(right.inspectionDate)
    || left.purchaseDate.localeCompare(right.purchaseDate)
    || collator.compare(left.inspectionLocation, right.inspectionLocation)
    || left.fiscalYear - right.fiscalYear
    || collator.compare(left.brand, right.brand)
    || left.kind.localeCompare(right.kind)
    || collator.compare(left.grade, right.grade)
    || collator.compare(left.reason, right.reason)
  ))
}

function setFont(context: CanvasRenderingContext2D, size: number, weight = 500) {
  context.font = `${weight} ${size}px ${FONT_FAMILY}`
}

function fittedFontSize(context: CanvasRenderingContext2D, text: string, width: number, size: number, minimumSize = 3.5) {
  let fitted = size
  setFont(context, fitted)
  while (fitted > minimumSize && context.measureText(text).width > width) {
    fitted -= 0.2
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
  size = 6.5,
  minimumSize = 3.5,
  align: CanvasTextAlign = 'center',
) {
  const value = text.trim()
  if (!value) return
  const fitted = fittedFontSize(context, value, width - 3, size, minimumSize)
  setFont(context, fitted)
  context.textAlign = align
  context.textBaseline = 'middle'
  const textX = align === 'left' ? x + 2 : align === 'right' ? x + width - 2 : x + width / 2
  context.fillText(value, textX, y + height / 2)
}

function ledgerDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return ''
  return `${year - 2018}・${month}・${day}`
}

function cropType(brand: string) {
  return brand === '飼料用玄米' ? '飼料用玄米' : '水稲うるち玄米'
}

function createOverlayCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(PAGE_WIDTH * CANVAS_SCALE)
  canvas.height = Math.round(PAGE_HEIGHT * CANVAS_SCALE)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('検査請求者別検査台帳の描画領域を作成できませんでした。')
  context.scale(CANVAS_SCALE, CANVAS_SCALE)
  context.fillStyle = '#000'
  return { canvas, context }
}

function drawLedgerOverlay(
  authorization: InspectionLedgerAuthorization,
  records: AggregatedLedgerRecord[],
  pageNumber: number,
) {
  const { canvas, context } = createOverlayCanvas()

  drawTextInBox(context, authorization.fullName, 28.8, 97.92, 286.56, 19.2, 8, 5, 'left')
  drawTextInBox(context, authorization.address, 315.36, 97.92, 451.68, 19.2, 7.5, 4.5, 'left')
  drawTextInBox(context, authorization.authorizationNo, 767.04, 97.92, 37.92, 19.2, 7)
  drawTextInBox(context, '3等', 419.52, 151.2, 26.4, 41.28, 5.5, 4)

  records.forEach((record, index) => {
    const top = DATA_TOP + index * DATA_ROW_HEIGHT
    const halfHeight = DATA_ROW_HEIGHT / 2
    const isFeedRice = record.brand === '飼料用玄米'
    const packaging = record.kind === 'paper_bag' ? '紙袋' : '推フレ'
    const weight = `${record.weightKg.toLocaleString('ja-JP')}kg`
    const quantity = record.quantityCount.toLocaleString('ja-JP')
    const moisture = record.moistureAverage === null ? '' : `${record.moistureAverage.toFixed(1)}%`

    drawTextInBox(context, ledgerDate(record.inspectionDate), 28.8, top, 37.44, DATA_ROW_HEIGHT, 6, 3.5)
    drawTextInBox(context, ledgerDate(record.purchaseDate), 66.24, top, 37.92, DATA_ROW_HEIGHT, 6, 3.5)
    drawTextInBox(context, record.inspectionLocation, 104.16, top, 36.96, DATA_ROW_HEIGHT, 6, 3.5)
    drawTextInBox(context, cropType(record.brand), 141.12, top, 50.88, DATA_ROW_HEIGHT, 5.8, 3.5)
    drawTextInBox(context, String(record.fiscalYear), 192, top, 19.68, DATA_ROW_HEIGHT, 7)
    drawTextInBox(context, record.origin, 211.68, top, 28.8, DATA_ROW_HEIGHT, 6, 3.5)
    drawTextInBox(context, isFeedRice ? '' : record.brand, 240.48, top, 50.4, DATA_ROW_HEIGHT, 6, 3.5)
    drawTextInBox(context, packaging, 290.88, top, 24.48, DATA_ROW_HEIGHT, 6, 3.5)
    drawTextInBox(context, weight, 315.36, top, 24.96, DATA_ROW_HEIGHT, 5.5, 3.3)

    const gradeColumn = GRADE_COLUMNS[record.grade]
    if (gradeColumn) {
      drawTextInBox(context, quantity, gradeColumn.x, top, gradeColumn.width, halfHeight, 6.5, 4)
      drawTextInBox(context, record.reason, gradeColumn.x, top + halfHeight, gradeColumn.width, halfHeight, 5, 3.2)
    }
    drawTextInBox(context, quantity, 498.72, top, 26.4, DATA_ROW_HEIGHT, 6.5, 4)
    drawTextInBox(context, quantity, 709.92, top, 28.8, DATA_ROW_HEIGHT, 6.5, 4)
    drawTextInBox(context, moisture, 738.72, top, 28.32, DATA_ROW_HEIGHT, 5.8, 3.5, 'right')
    drawTextInBox(context, record.inspectorName, 767.04, top, 37.92, DATA_ROW_HEIGHT, 5.8, 3.5)
  })

  drawTextInBox(context, `P${pageNumber}`, 780, 559, 25, 16, 6, 5, 'right')
  return canvas
}

function canvasToPng(canvas: HTMLCanvasElement) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('検査請求者別検査台帳の画像を作成できませんでした。'))
      resolve(await blob.arrayBuffer())
    }, 'image/png')
  })
}

export async function generateInspectionLedgerPdf({ authorization, records }: InspectionLedgerData) {
  const aggregatedRecords = aggregateInspectionLedgerRecords(records)
  if (aggregatedRecords.length === 0) {
    throw new Error('検査請求者別検査台帳に出力できる検査記録がありません。')
  }

  const templateResponse = await fetch(`${import.meta.env.BASE_URL}inspection-ledger-template.pdf`)
  if (!templateResponse.ok) throw new Error('検査請求者別検査台帳のひな型を読み込めませんでした。')
  const templateBytes = await templateResponse.arrayBuffer()
  const pdf = await PDFDocument.create()
  const [templatePage] = await pdf.embedPdf(templateBytes, [0])
  const viewerPreferences = pdf.catalog.getOrCreateViewerPreferences()
  viewerPreferences.setPrintScaling(PrintScaling.None)
  viewerPreferences.setPickTrayByPDFSize(true)

  const pageCount = Math.ceil(aggregatedRecords.length / ROWS_PER_PAGE)
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageRecords = aggregatedRecords.slice(pageIndex * ROWS_PER_PAGE, (pageIndex + 1) * ROWS_PER_PAGE)
    const overlayCanvas = drawLedgerOverlay(authorization, pageRecords, pageIndex + 1)
    const overlay = await pdf.embedPng(await canvasToPng(overlayCanvas))
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    page.drawPage(templatePage, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT })
    page.drawImage(overlay, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT })
  }

  pdf.setTitle(`検査請求者別検査台帳 ${authorization.fullName}`)
  pdf.setSubject('様式第6号 検査請求者別検査台帳')
  pdf.setCreator('(株)エイト 米穀出荷管理')
  const savedBytes = await pdf.save()
  const savedBuffer = savedBytes.buffer.slice(savedBytes.byteOffset, savedBytes.byteOffset + savedBytes.byteLength) as ArrayBuffer
  return { blob: new Blob([savedBuffer], { type: 'application/pdf' }), pageCount }
}
