import { PDFDocument, PrintScaling } from 'pdf-lib'
import QRCode from 'qrcode'

export type CertificateAuthorization = {
  authorizationNo: string
  fullName: string
  address: string
  prefecture: string
  feedRiceVariety: string
}

export type CertificateFlexcon = {
  flexconNo: number
  lotNumber: string
  fiscalYear: number
  inspectionDate: string | null
  brand: string
  quantityKg: number
  grade: string
  reason: string
}

type CertificateData = {
  authorization: CertificateAuthorization
  flexcons: CertificateFlexcon[]
}

const DESIGN_WIDTH = 595.2
const DESIGN_HEIGHT = 420.72
const PAGE_WIDTH = 210 * 72 / 25.4
const PAGE_HEIGHT = 148 * 72 / 25.4
const CANVAS_SCALE = 4
const FONT_FAMILY = '"Yu Mincho", "Yu Gothic", "Noto Serif JP", "Noto Sans JP", serif'

function setFont(context: CanvasRenderingContext2D, size: number, weight = 700) {
  context.font = `${weight} ${size * CANVAS_SCALE}px ${FONT_FAMILY}`
}

function drawFittedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  align: CanvasTextAlign = 'left',
  minimumSize = 6,
) {
  const value = text.trim()
  if (!value) return
  let fittedSize = size
  setFont(context, fittedSize)
  while (fittedSize > minimumSize && context.measureText(value).width > width * CANVAS_SCALE) {
    fittedSize -= 0.25
    setFont(context, fittedSize)
  }
  context.textAlign = align
  context.textBaseline = 'top'
  context.fillText(value, x * CANVAS_SCALE, y * CANVAS_SCALE)
}

function drawCenteredText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  minimumSize = 6,
) {
  drawFittedText(context, text, x + width / 2, y, width, size, 'center', minimumSize)
}

function japaneseDate(value: string | null) {
  if (!value) return '令和　　年　　月　　日'
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return '令和　　年　　月　　日'
  return `令和 ${year - 2018} 年 ${month} 月 ${day} 日`
}

function prefectureLabel(prefecture: string) {
  const normalized = prefecture.trim().replace(/県$/, '')
  return normalized ? `${normalized}県産` : ''
}

function cropType(brand: string) {
  return brand.includes('飼料用') ? '飼料用玄米' : '水稲うるち玄米'
}

function displayedBrand(authorization: CertificateAuthorization, flexcon: CertificateFlexcon) {
  if (flexcon.brand === '飼料用玄米' && authorization.feedRiceVariety.trim()) {
    return authorization.feedRiceVariety.trim()
  }
  return flexcon.brand
}

function createOverlayCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(PAGE_WIDTH * CANVAS_SCALE)
  canvas.height = Math.round(PAGE_HEIGHT * CANVAS_SCALE)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('PDF描画用の画面を作成できませんでした。')
  context.scale(PAGE_WIDTH / DESIGN_WIDTH, PAGE_HEIGHT / DESIGN_HEIGHT)
  context.fillStyle = '#000'
  return { canvas, context }
}

async function drawCertificateOverlay(
  authorization: CertificateAuthorization,
  flexcon: CertificateFlexcon,
) {
  const { canvas, context } = createOverlayCanvas()

  drawFittedText(context, authorization.authorizationNo, 129, 39, 55, 9)
  drawFittedText(context, String(flexcon.flexconNo), 480, 39, 45, 9)
  drawFittedText(context, authorization.fullName, 307, 78, 205, 9.5)
  drawFittedText(context, authorization.address, 307, 94, 205, 9.5, 'left', 6.5)
  drawCenteredText(context, japaneseDate(flexcon.inspectionDate), 188, 138, 116, 9.5)

  drawCenteredText(context, cropType(flexcon.brand), 83, 238, 77, 11.5, 8)
  drawCenteredText(context, String(flexcon.fiscalYear), 160, 232, 28, 18, 12)
  drawCenteredText(context, prefectureLabel(authorization.prefecture), 188, 205, 78, 9)
  drawCenteredText(context, displayedBrand(authorization, flexcon), 188, 253, 78, 12, 7)
  drawCenteredText(context, flexcon.grade, 306, 236, 89, 15, 8)
  drawCenteredText(context, flexcon.quantityKg.toLocaleString('ja-JP'), 395, 226, 65, 16, 10)
  drawCenteredText(context, flexcon.reason, 460, 236, 52, 9, 6)
  drawCenteredText(context, japaneseDate(flexcon.inspectionDate), 266, 310, 103, 9.5)

  const qrCanvas = document.createElement('canvas')
  await QRCode.toCanvas(qrCanvas, flexcon.lotNumber, {
    width: 512,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#00000000' },
  })
  context.imageSmoothingEnabled = false
  context.drawImage(
    qrCanvas,
    87.5 * CANVAS_SCALE,
    312 * CANVAS_SCALE,
    68 * CANVAS_SCALE,
    68 * CANVAS_SCALE,
  )

  return canvas
}

function canvasToPng(canvas: HTMLCanvasElement) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('検査証明書の画像を作成できませんでした。'))
      resolve(await blob.arrayBuffer())
    }, 'image/png')
  })
}

export async function generateInspectionCertificatePdf({ authorization, flexcons }: CertificateData) {
  if (flexcons.length === 0) throw new Error('PDFに出力するフレコンがありません。')

  const templateResponse = await fetch(`${import.meta.env.BASE_URL}certificate-template.pdf`)
  if (!templateResponse.ok) throw new Error('検査証明書のひな型を読み込めませんでした。')
  const templateBytes = await templateResponse.arrayBuffer()
  const pdf = await PDFDocument.create()
  const [templatePage] = await pdf.embedPdf(templateBytes, [0])
  const viewerPreferences = pdf.catalog.getOrCreateViewerPreferences()
  viewerPreferences.setPrintScaling(PrintScaling.None)
  viewerPreferences.setPickTrayByPDFSize(true)

  for (const flexcon of flexcons) {
    const overlayCanvas = await drawCertificateOverlay(authorization, flexcon)
    const overlay = await pdf.embedPng(await canvasToPng(overlayCanvas))
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    page.drawPage(templatePage, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT })
    page.drawImage(overlay, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT })
  }

  pdf.setTitle(`検査証明書 ${authorization.fullName}`)
  pdf.setSubject('農産物検査証明書')
  pdf.setCreator('フレコントレース')
  const savedBytes = await pdf.save()
  const savedBuffer = savedBytes.buffer.slice(
    savedBytes.byteOffset,
    savedBytes.byteOffset + savedBytes.byteLength,
  ) as ArrayBuffer
  return new Blob([savedBuffer], { type: 'application/pdf' })
}
