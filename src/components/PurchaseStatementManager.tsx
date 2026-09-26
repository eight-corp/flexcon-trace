import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Camera, ChevronDown, ChevronUp, FileImage, Keyboard, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useCalendarMode } from '../lib/calendarMode'
import { JapaneseCropYearInput, JapaneseDateInput } from './JapaneseDateInput'

type Mode = 'reader' | 'list' | 'master'
type Props = { mode: Mode; workerId: string; canOperate: boolean; isAdmin: boolean }
type SourceType = 'camera' | 'manual'
type TaxTreatment = '' | 'exclusive' | 'inclusive'
type HeaderForm = {
  statementDate: string
  documentNumber: string
  recipient: string
  issuer: string
  paymentMethod: '' | 'cash' | 'transfer'
  taxTreatment: TaxTreatment
  taxRate: string
  taxAmount: string
  totalAmount: string
  invoiceNumber: string
}
type ItemForm = {
  cropYear: string
  origin: string
  productName: string
  packageType: string
  quantity: string
  unit: string
  unitPrice: string
  amount: string
}
type Editor = { id: string | null; sourceType: SourceType; header: HeaderForm; items: ItemForm[]; previewUrl: string; imageBase64: string; warnings: string[] }
type StoredItem = {
  id: string
  line_no: number
  crop_year: number | null
  origin: string
  product_name: string
  package_type: string
  quantity: number | null
  unit: string
  unit_price: number | null
  amount: number | null
}
type StoredStatement = {
  id: string
  statement_date: string
  document_number: string
  recipient: string
  issuer: string
  payment_method: '' | 'cash' | 'transfer'
  tax_treatment: TaxTreatment
  tax_rate: number | null
  tax_amount: number | null
  total_amount: number | null
  invoice_number: string
  source_type: SourceType
  image_path: string
  created_by_worker_name: string
  created_at: string
  updated_at: string
  items: StoredItem[]
}
type MasterType = 'recipient' | 'origin' | 'product' | 'category' | 'storage_location' | 'customer'
type MasterValue = {
  id: string
  value_type: MasterType
  name: string
  active: boolean
  sort_order: number
  product_category_id: string | null
  product_category_name: string
  is_variety_rice: boolean
}
type PurchaseInventoryMaster = {
  id: string
  name: string
  inventory_product_id: string
  inventory_product_name: string
  scrap_type_product_id: string | null
  scrap_type_product_name: string
  statement_keywords: string[]
  sort_order: number
}
type PurchaseInventoryEdit = {
  name: string
  inventoryProductId: string
  scrapTypeProductId: string
  keywords: string
}
type DuplicateStatement = { id: string; document_number: string; statement_date: string; issuer: string }
type GeminiStatement = {
  statement_date: string
  document_number: string
  recipient: string
  issuer: string
  payment_method: string
  tax_treatment: string
  tax_rate: number
  tax_amount: number
  total_amount: number
  invoice_number: string
  lines: Array<{ crop_year: string; origin: string; product_name: string; package_type: string; quantity: number; unit: string; unit_price: number; amount: number }>
  warnings: string[]
}
const masterLabels: Record<MasterType, string> = { recipient: '担当者', origin: '産地', product: '在庫商品管理', category: '種別', storage_location: '保管場所', customer: '販売先管理' }
const masterFieldLabels: Record<MasterType, string> = { recipient: '担当者', origin: '産地', product: '品名', category: '種別', storage_location: '保管場所名', customer: '販売先名' }

function parseStatementKeywords(value: string) {
  return [...new Set(value.split(/[\n,、]+/).map((keyword) => keyword.trim()).filter(Boolean))]
}

function today() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}

function emptyHeader(): HeaderForm {
  return { statementDate: today(), documentNumber: '', recipient: '', issuer: '', paymentMethod: '', taxTreatment: '', taxRate: '', taxAmount: '', totalAmount: '', invoiceNumber: '' }
}

function emptyItem(): ItemForm {
  return { cropYear: '', origin: '', productName: '', packageType: '', quantity: '', unit: '', unitPrice: '', amount: '' }
}

function inputNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? String(number) : ''
}

function groupedNumber(value: string | number) {
  const raw = String(value)
  if (!raw) return ''
  const negative = raw.startsWith('-')
  const unsigned = negative ? raw.slice(1) : raw
  const [integer, decimal] = unsigned.split('.', 2)
  const groupedInteger = (integer || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${groupedInteger}${raw.includes('.') ? `.${decimal ?? ''}` : ''}`
}

function MoneyInput({ value, onChange, readOnly = false, required = false }: { value: string | number; onChange: (value: string) => void; readOnly?: boolean; required?: boolean }) {
  const [focused, setFocused] = useState(false)
  const raw = String(value)
  return <input
    type="text"
    inputMode="decimal"
    value={focused && !readOnly ? raw : groupedNumber(raw)}
    onFocus={() => setFocused(true)}
    onBlur={() => setFocused(false)}
    onChange={(event) => {
      const next = event.target.value.replaceAll(',', '').trim()
      if (/^-?\d*(?:\.\d*)?$/.test(next)) onChange(next)
    }}
    readOnly={readOnly}
    required={required}
  />
}

function taxExemptAmount(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number !== 0 ? String(-Math.abs(number)) : ''
}

function nullableNumber(value: string) {
  return value.trim() === '' ? null : Number(value)
}

function formatMoney(value: number | null) {
  return value == null ? '' : `${Number(value).toLocaleString('ja-JP')}円`
}

function paymentMethodLabel(value: StoredStatement['payment_method']) {
  return value === 'cash' ? '現金' : value === 'transfer' ? '振込' : '―'
}

function taxTreatmentLabel(value: TaxTreatment) {
  return value === 'exclusive' ? '税抜' : value === 'inclusive' ? '税込' : '―'
}

function calculatedTotal(items: ItemForm[], taxAmount: string, taxTreatment: TaxTreatment) {
  const detailTotal = items.reduce((sum, item) => sum + (nullableNumber(item.amount) ?? 0), 0)
  return detailTotal + (taxTreatment === 'inclusive' ? 0 : (nullableNumber(taxAmount) ?? 0))
}

function itemAmountMismatch(item: ItemForm) {
  const quantity = nullableNumber(item.quantity)
  const unitPrice = nullableNumber(item.unitPrice)
  const amount = nullableNumber(item.amount)
  return quantity != null && unitPrice != null && amount != null && Math.abs(quantity * unitPrice - amount) >= 0.5
}

function importedTotalMismatch(editor: Editor) {
  if (editor.sourceType !== 'camera') return false
  const total = nullableNumber(editor.header.totalAmount)
  const tax = editor.header.taxTreatment === 'inclusive' ? 0 : (nullableNumber(editor.header.taxAmount) ?? 0)
  if (total == null || editor.items.some((item) => nullableNumber(item.amount) == null)) return false
  const expected = editor.items.reduce((sum, item) => sum + Number(item.amount), 0) + tax
  return Math.abs(total - expected) >= 0.5
}

async function canvasJpegBase64(canvas: HTMLCanvasElement, quality: number) {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('撮影画像を変換できませんでした。')), 'image/jpeg', quality))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

async function resizePhoto(file: File) {
  const objectUrl = URL.createObjectURL(file)
  try {
    const source = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('撮影画像を読み込めませんでした。'))
      image.src = objectUrl
    })
    const maxDimension = 1800
    const scale = Math.min(1, maxDimension / Math.max(source.naturalWidth, source.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('撮影画像を処理できませんでした。')
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const imageBase64 = await canvasJpegBase64(canvas, 0.9)

    const cropRegion = async (x: number, y: number, width: number, height: number, targetWidth: number, filter = 'none') => {
      const cropX = Math.round(canvas.width * x)
      const cropY = Math.round(canvas.height * y)
      const cropWidth = Math.max(1, Math.min(canvas.width - cropX, Math.round(canvas.width * width)))
      const cropHeight = Math.max(1, Math.min(canvas.height - cropY, Math.round(canvas.height * height)))
      const cropScale = Math.min(2.5, targetWidth / cropWidth)
      const regionCanvas = document.createElement('canvas')
      regionCanvas.width = Math.max(1, Math.round(cropWidth * cropScale))
      regionCanvas.height = Math.max(1, Math.round(cropHeight * cropScale))
      const regionContext = regionCanvas.getContext('2d')
      if (!regionContext) throw new Error('仕切書の拡大画像を処理できませんでした。')
      regionContext.imageSmoothingEnabled = true
      regionContext.imageSmoothingQuality = 'high'
      regionContext.filter = filter
      regionContext.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, regionCanvas.width, regionCanvas.height)
      return canvasJpegBase64(regionCanvas, 0.94)
    }

    const [headerRegionBase64, taxRegionBase64, paymentRegionBase64, detailRegionBase64] = await Promise.all([
      cropRegion(0.45, 0.02, 0.53, 0.27, 1400),
      cropRegion(0.6, 0.27, 0.38, 0.16, 1200, 'grayscale(1) contrast(1.5)'),
      cropRegion(0.02, 0.7, 0.58, 0.22, 1000),
      cropRegion(0.05, 0.3, 0.9, 0.43, 1500),
    ])
    return { imageBase64, headerRegionBase64, taxRegionBase64, paymentRegionBase64, detailRegionBase64, mimeType: 'image/jpeg', previewUrl: `data:image/jpeg;base64,${imageBase64}` }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function PurchaseStatementManager({ mode, workerId, canOperate, isAdmin }: Props) {
  const { formatDate: formatJapaneseDate, formatCropYear: formatJapaneseCropYear } = useCalendarMode()
  const cameraRef = useRef<HTMLInputElement>(null)
  const [statements, setStatements] = useState<StoredStatement[]>([])
  const [masters, setMasters] = useState<MasterValue[]>([])
  const [masterDrafts, setMasterDrafts] = useState<Record<MasterType, string>>({ recipient: '', origin: '', product: '', category: '', storage_location: '', customer: '' })
  const [productCategoryId, setProductCategoryId] = useState('')
  const [productIsVarietyRice, setProductIsVarietyRice] = useState(false)
  const [productEdits, setProductEdits] = useState<Record<string, { categoryId: string; isVarietyRice: boolean }>>({})
  const [masterNameEdits, setMasterNameEdits] = useState<Record<string, string>>({})
  const [purchaseInventoryMasters, setPurchaseInventoryMasters] = useState<PurchaseInventoryMaster[]>([])
  const [purchaseInventoryDraft, setPurchaseInventoryDraft] = useState<PurchaseInventoryEdit>({ name: '', inventoryProductId: '', scrapTypeProductId: '', keywords: '' })
  const [purchaseInventoryEdits, setPurchaseInventoryEdits] = useState<Record<string, PurchaseInventoryEdit>>({})
  const [editor, setEditor] = useState<Editor | null>(null)
  const [selectedStatement, setSelectedStatement] = useState<StoredStatement | null>(null)
  const [duplicateStatement, setDuplicateStatement] = useState<DuplicateStatement | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingStatements, setLoadingStatements] = useState(mode === 'list')
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [viewingImageUrl, setViewingImageUrl] = useState('')

  const loadStatements = useCallback(async () => {
    setLoadingStatements(true)
    const { data, error } = await supabase.rpc('flexcon_list_purchase_statements', { p_worker_id: workerId })
    setLoadingStatements(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setStatements((data ?? []) as StoredStatement[])
  }, [workerId])

  const loadMasters = useCallback(async () => {
    const [masterResult, purchaseInventoryResult] = await Promise.all([
      supabase.rpc('flexcon_list_purchase_statement_master', { p_worker_id: workerId }),
      supabase.rpc('flexcon_list_purchase_inventory_master', { p_worker_id: workerId }),
    ])
    if (masterResult.error) return setNotice({ type: 'error', text: masterResult.error.message })
    if (purchaseInventoryResult.error) return setNotice({ type: 'error', text: purchaseInventoryResult.error.message })
    const loaded = (masterResult.data ?? []) as MasterValue[]
    const loadedPurchaseInventory = (purchaseInventoryResult.data ?? []) as PurchaseInventoryMaster[]
    setMasters(loaded)
    setMasterNameEdits(Object.fromEntries(loaded.map((item) => [item.id, item.name])))
    setProductEdits(Object.fromEntries(loaded.filter((item) => item.value_type === 'product').map((item) => [item.id, {
      categoryId: item.product_category_id ?? '',
      isVarietyRice: Boolean(item.is_variety_rice),
    }])))
    setPurchaseInventoryMasters(loadedPurchaseInventory)
    setPurchaseInventoryEdits(Object.fromEntries(loadedPurchaseInventory.map((item) => [item.id, {
      name: item.name,
      inventoryProductId: item.inventory_product_id,
      scrapTypeProductId: item.scrap_type_product_id ?? '',
      keywords: item.statement_keywords.join('、'),
    }])))
  }, [workerId])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- RPC results synchronize this view with Supabase.
    if (mode === 'list') void loadStatements()
    void loadMasters()
  }, [loadMasters, loadStatements, mode])

  const suggestions = (type: MasterType) => masters.filter((item) => item.value_type === type && item.active).map((item) => item.name)
  const displayedStatements = useMemo(() => {
    const term = search.trim().toLowerCase()
    const filtered = term
      ? statements.filter((statement) => [statement.statement_date, statement.document_number, statement.recipient, statement.issuer, statement.invoice_number, ...statement.items.flatMap((item) => [item.origin, item.product_name, item.package_type])].some((value) => String(value ?? '').toLowerCase().includes(term)))
      : statements
    return [...filtered].sort((left, right) =>
      right.statement_date.localeCompare(left.statement_date)
      || (right.created_at ?? '').localeCompare(left.created_at ?? '')
      || right.document_number.localeCompare(left.document_number, 'ja', { numeric: true }),
    )
  }, [search, statements])

  const startManual = () => {
    setNotice(null)
    setEditor({ id: null, sourceType: 'manual', header: emptyHeader(), items: [emptyItem()], previewUrl: '', imageBase64: '', warnings: [] })
  }

  const preparePhoto = async (file: File) => {
    setBusy(true)
    setNotice(null)
    try {
      const image = await resizePhoto(file)
      const productMasterNames = masters.filter((item) => item.value_type === 'product' && item.active).map((item) => item.name)
      const originMasterNames = masters.filter((item) => item.value_type === 'origin' && item.active).map((item) => item.name)
      const { data, error } = await supabase.functions.invoke('analyze-purchase-statement', { body: {
        imageBase64: image.imageBase64,
        headerRegionBase64: image.headerRegionBase64,
        taxRegionBase64: image.taxRegionBase64,
        paymentRegionBase64: image.paymentRegionBase64,
        detailRegionBase64: image.detailRegionBase64,
        productMasterNames,
        originMasterNames,
        mimeType: image.mimeType,
      } })
      if (error) {
        let message = error.message
        const context = (error as { context?: Response }).context
        if (context) try { message = ((await context.clone().json()) as { error?: string }).error ?? message } catch {}
        throw new Error(message)
      }
      const statement = (data as { statement?: GeminiStatement } | null)?.statement
      if (!statement || !Array.isArray(statement.lines) || statement.lines.length === 0) throw new Error('仕切書の明細を読み取れませんでした。')

      let latestCropYear = ''
      const warnings = [...(statement.warnings ?? [])]
      const items = statement.lines.map((line, index) => {
        const explicitYear = Number(line.crop_year)
        if (Number.isInteger(explicitYear) && explicitYear >= 1900 && explicitYear <= 2100) latestCropYear = String(explicitYear)
        else if (!latestCropYear) warnings.push(`${index + 1}行目の産年を読み取れず、直前の産年もありません。`)
        return {
          cropYear: latestCropYear,
          origin: line.origin?.trim() ?? '',
          productName: line.product_name?.trim() ?? '',
          packageType: line.package_type?.trim() ?? '',
          quantity: inputNumber(line.quantity),
          unit: line.unit?.trim() ?? '',
          unitPrice: inputNumber(line.unit_price),
          amount: line.product_name?.trim() === '免税' ? taxExemptAmount(line.amount) : inputNumber(line.amount),
        }
      })
      setEditor({
        id: null,
        sourceType: 'camera',
        previewUrl: image.previewUrl,
        imageBase64: image.imageBase64,
        warnings: [...new Set(warnings.filter(Boolean))],
        header: {
          statementDate: statement.statement_date?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] ?? '',
          documentNumber: statement.document_number?.trim() ?? '',
          recipient: statement.recipient?.trim() ?? '',
          issuer: statement.issuer?.trim() ?? '',
          paymentMethod: statement.payment_method === 'cash' || statement.payment_method === 'transfer' ? statement.payment_method : '',
          taxTreatment: statement.tax_treatment === 'exclusive' || statement.tax_treatment === 'inclusive' ? statement.tax_treatment : '',
          taxRate: inputNumber(statement.tax_rate),
          taxAmount: inputNumber(statement.tax_amount),
          totalAmount: inputNumber(statement.total_amount),
          invoiceNumber: statement.invoice_number?.trim() ?? '',
        },
        items,
      })
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '仕切書画像を解析できませんでした。' })
    } finally {
      setBusy(false)
      if (cameraRef.current) cameraRef.current.value = ''
    }
  }

  const editStatement = (statement: StoredStatement) => {
    setNotice(null)
    setEditor({
      id: statement.id,
      sourceType: statement.source_type,
      previewUrl: '',
      imageBase64: '',
      warnings: [],
      header: {
        statementDate: statement.statement_date,
        documentNumber: statement.document_number,
        recipient: statement.recipient,
        issuer: statement.issuer,
        paymentMethod: statement.payment_method ?? '',
        taxTreatment: statement.tax_treatment ?? '',
        taxRate: statement.tax_rate == null ? '' : String(statement.tax_rate),
        taxAmount: statement.tax_amount == null ? '' : String(statement.tax_amount),
        totalAmount: statement.total_amount == null ? '' : String(statement.total_amount),
        invoiceNumber: statement.invoice_number,
      },
      items: statement.items.map((item) => ({
        cropYear: item.crop_year == null ? '' : String(item.crop_year),
        origin: item.origin ?? '',
        productName: item.product_name,
        packageType: item.package_type,
        quantity: item.quantity == null ? '' : String(item.quantity),
        unit: item.unit,
        unitPrice: item.unit_price == null ? '' : String(item.unit_price),
        amount: item.amount == null ? '' : String(item.amount),
      })),
    })
  }

  const updateHeader = (key: keyof HeaderForm, value: string) => setEditor((current) => current ? { ...current, header: { ...current.header, [key]: value } } : current)
  const updateItem = (index: number, key: keyof ItemForm, value: string) => setEditor((current) => current ? { ...current, items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item) } : current)
  const addItem = () => setEditor((current) => current ? { ...current, items: [...current.items, { ...emptyItem(), cropYear: current.items.at(-1)?.cropYear ?? '' }] } : current)
  const removeItem = (index: number) => setEditor((current) => current && current.items.length > 1 ? { ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) } : current)

  const persistStatement = async (statementId: string | null) => {
    if (!editor || busy) return
    setDuplicateStatement(null)
    setBusy(true)
    const { data: savedStatementId, error } = await supabase.rpc('flexcon_save_purchase_statement', {
      p_worker_id: workerId,
      p_statement_id: statementId,
      p_source_type: editor.sourceType,
      p_header: {
        statement_date: editor.header.statementDate,
        document_number: editor.header.documentNumber.trim(),
        recipient: editor.header.recipient.trim(),
        issuer: editor.header.issuer.trim(),
        payment_method: editor.header.paymentMethod,
        tax_treatment: editor.header.taxTreatment,
        tax_rate: nullableNumber(editor.header.taxRate),
        tax_amount: nullableNumber(editor.header.taxAmount),
        total_amount: editor.sourceType === 'manual' ? calculatedTotal(editor.items, editor.header.taxAmount, editor.header.taxTreatment) : nullableNumber(editor.header.totalAmount),
        invoice_number: editor.header.invoiceNumber.trim(),
      },
      p_items: editor.items.map((item) => ({
        crop_year: item.cropYear.trim() || null,
        origin: item.origin.trim(),
        product_name: item.productName.trim(),
        package_type: item.packageType.trim(),
        quantity: item.productName.trim() === '免税' ? nullableNumber(item.quantity) : Number(item.quantity),
        unit: item.unit.trim(),
        unit_price: nullableNumber(item.unitPrice),
        amount: nullableNumber(item.amount),
      })),
    })
    if (error) {
      setBusy(false)
      return setNotice({ type: 'error', text: error.message })
    }
    if (editor.imageBase64) {
      const { data: imageData, error: imageError } = await supabase.functions.invoke('purchase-statement-image', {
        body: { action: 'upload', statementId: savedStatementId, imageBase64: editor.imageBase64, mimeType: 'image/jpeg' },
      })
      if (imageError || !(imageData as { imagePath?: string } | null)?.imagePath) {
        let message = imageError?.message ?? '画像を保存できませんでした。'
        const context = (imageError as { context?: Response } | null)?.context
        if (context) try { message = ((await context.clone().json()) as { error?: string }).error ?? message } catch {}
        setEditor((current) => current ? { ...current, id: String(savedStatementId) } : current)
        setBusy(false)
        return setNotice({ type: 'error', text: `仕切書は保存しましたが、画像を保存できませんでした。もう一度保存してください。${message}` })
      }
    }
    setBusy(false)
    setEditor(null)
    setSelectedStatement(null)
    setNotice({ type: 'success', text: statementId && statementId !== editor.id ? '同じ仕切書№の登録を上書きしました。' : '仕切書を保存しました。' })
    if (mode === 'list') await loadStatements()
  }

  const saveStatement = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editor || busy) return
    if (!editor.header.statementDate) return setNotice({ type: 'error', text: '日付を入力してください。' })
    if (!editor.header.documentNumber.trim()) return setNotice({ type: 'error', text: '仕切書№を入力してください。' })
    if (!editor.header.taxTreatment) return setNotice({ type: 'error', text: '右上の「金額（税抜・税込）」の丸印を確認し、消費税区分を選択してください。' })
    if (editor.items.some((item) => {
      if (!item.productName.trim()) return true
      if (item.productName.trim() === '免税') {
        const invalidQuantity = item.quantity.trim() !== '' && (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0)
        return invalidQuantity || nullableNumber(item.amount) == null || Number(item.amount) >= 0
      }
      return !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0 || (nullableNumber(item.amount) != null && Number(item.amount) < 0)
    })) return setNotice({ type: 'error', text: '各明細の数量と金額を確認してください。免税行は金額をマイナスで入力し、数量を空欄にできます。' })
    setBusy(true)
    const { data, error } = await supabase.rpc('flexcon_find_purchase_statement_by_number', {
      p_worker_id: workerId,
      p_document_number: editor.header.documentNumber.trim(),
      p_exclude_statement_id: editor.id,
    })
    setBusy(false)
    if (error) {
      return setNotice({ type: 'error', text: error.message })
    }
    if (data) {
      setDuplicateStatement(data as DuplicateStatement)
      return
    }
    await persistStatement(editor.id)
  }

  const openStatementImage = async (statement: StoredStatement) => {
    if (!statement.image_path || busy) return
    setBusy(true)
    setNotice(null)
    const { data, error } = await supabase.functions.invoke('purchase-statement-image', { body: { action: 'signed-url', statementId: statement.id } })
    setBusy(false)
    if (error) {
      let message = error.message
      const context = (error as { context?: Response }).context
      if (context) try { message = ((await context.clone().json()) as { error?: string }).error ?? message } catch {}
      return setNotice({ type: 'error', text: message })
    }
    const signedUrl = (data as { signedUrl?: string } | null)?.signedUrl
    if (!signedUrl) return setNotice({ type: 'error', text: '仕切書画像を開けませんでした。' })
    setViewingImageUrl(signedUrl)
  }

  const deleteStatement = async (statement: StoredStatement) => {
    if (!isAdmin || busy || !window.confirm(`仕切書№「${statement.document_number}」を削除しますか？\n\nこの操作は元に戻せません。`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_purchase_statement', { p_worker_id: workerId, p_statement_id: statement.id })
    if (error) {
      setBusy(false)
      return setNotice({ type: 'error', text: error.message })
    }
    let imageWarning = ''
    if (statement.image_path) {
      const { error: imageError } = await supabase.functions.invoke('purchase-statement-image', { body: { action: 'delete', imagePath: statement.image_path } })
      if (imageError) imageWarning = ' 画像ファイルだけ削除できなかったため、管理者へ確認してください。'
    }
    setBusy(false)
    setSelectedStatement(null)
    setNotice({ type: imageWarning ? 'error' : 'success', text: `仕切書を削除しました。${imageWarning}` })
    await loadStatements()
  }

  const saveMaster = async (type: MasterType) => {
    const name = masterDrafts[type].trim()
    if (!name || busy) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_save_purchase_statement_master', {
      p_worker_id: workerId,
      p_value_id: null,
      p_value_type: type,
      p_name: name,
      p_product_category_id: type === 'product' ? productCategoryId || null : null,
      p_is_variety_rice: type === 'product' ? productIsVarietyRice : false,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setMasterDrafts((current) => ({ ...current, [type]: '' }))
    if (type === 'product') {
      setProductCategoryId('')
      setProductIsVarietyRice(false)
    }
    setNotice({ type: 'success', text: `${masterLabels[type]}を追加しました。` })
    await loadMasters()
  }

  const saveMasterGroup = async (type: MasterType) => {
    if (busy) return
    const items = masters.filter((item) => item.value_type === type)
    if (items.some((item) => !(masterNameEdits[item.id] ?? item.name).trim())) {
      return setNotice({ type: 'error', text: `${masterLabels[type]}の名称をすべて入力してください。` })
    }
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_save_purchase_statement_master_group', {
      p_worker_id: workerId,
      p_value_type: type,
      p_items: items.map((item, index) => {
        const settings = productEdits[item.id] ?? { categoryId: item.product_category_id ?? '', isVarietyRice: item.is_variety_rice }
        return {
          id: item.id,
          name: (masterNameEdits[item.id] ?? item.name).trim(),
          sort_order: index + 1,
          product_category_id: type === 'product' ? settings.categoryId || null : null,
          is_variety_rice: type === 'product' ? settings.isVarietyRice : false,
        }
      }),
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: `${masterLabels[type]}の変更をまとめて保存しました。` })
    await loadMasters()
  }

  const moveMaster = (item: MasterValue, direction: -1 | 1) => {
    if (busy) return
    setMasters((current) => {
      const items = current.filter((candidate) => candidate.value_type === item.value_type)
      const index = items.findIndex((candidate) => candidate.id === item.id)
      const targetIndex = index + direction
      if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return current
      const reordered = [...items]
      ;[reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]]
      let nextIndex = 0
      return current.map((candidate) => candidate.value_type === item.value_type ? reordered[nextIndex++] : candidate)
    })
  }

  const deleteMaster = async (item: MasterValue) => {
    if (!isAdmin || busy || !window.confirm(`「${item.name}」を削除しますか？`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_purchase_statement_master', { p_worker_id: workerId, p_value_id: item.id })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    await loadMasters()
  }

  const addPurchaseInventoryMaster = async () => {
    const keywords = parseStatementKeywords(purchaseInventoryDraft.keywords)
    if (busy || !purchaseInventoryDraft.name.trim() || !purchaseInventoryDraft.inventoryProductId || keywords.length === 0) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_save_purchase_inventory_master', {
      p_worker_id: workerId,
      p_item_id: null,
      p_name: purchaseInventoryDraft.name.trim(),
      p_inventory_product_id: purchaseInventoryDraft.inventoryProductId,
      p_scrap_type_product_id: purchaseInventoryDraft.scrapTypeProductId || null,
      p_statement_keywords: keywords,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setPurchaseInventoryDraft({ name: '', inventoryProductId: '', scrapTypeProductId: '', keywords: '' })
    setNotice({ type: 'success', text: '仕入在庫項目を追加しました。' })
    await loadMasters()
  }

  const savePurchaseInventoryMasterGroup = async () => {
    if (busy || purchaseInventoryMasters.length === 0) return
    const items = purchaseInventoryMasters.map((item, index) => {
      const edit = purchaseInventoryEdits[item.id] ?? {
        name: item.name,
        inventoryProductId: item.inventory_product_id,
        scrapTypeProductId: item.scrap_type_product_id ?? '',
        keywords: item.statement_keywords.join('、'),
      }
      return {
        id: item.id,
        name: edit.name.trim(),
        inventory_product_id: edit.inventoryProductId,
        scrap_type_product_id: edit.scrapTypeProductId || null,
        statement_keywords: parseStatementKeywords(edit.keywords),
        sort_order: index + 1,
      }
    })
    if (items.some((item) => !item.name || !item.inventory_product_id || item.statement_keywords.length === 0)) {
      return setNotice({ type: 'error', text: '品名、在庫計上先、仕切書キーワードをすべて入力してください。' })
    }
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_save_purchase_inventory_master_group', { p_worker_id: workerId, p_items: items })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: '仕入在庫管理の変更をまとめて保存しました。' })
    await loadMasters()
  }

  const movePurchaseInventoryMaster = (item: PurchaseInventoryMaster, direction: -1 | 1) => {
    if (busy) return
    setPurchaseInventoryMasters((current) => {
      const index = current.findIndex((candidate) => candidate.id === item.id)
      const targetIndex = index + direction
      if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return current
      const next = [...current]
      ;[next[index], next[targetIndex]] = [next[targetIndex], next[index]]
      return next
    })
  }

  const deletePurchaseInventoryMaster = async (item: PurchaseInventoryMaster) => {
    if (!isAdmin || busy || !window.confirm(`「${item.name}」を削除しますか？`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_purchase_inventory_master', { p_worker_id: workerId, p_item_id: item.id })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: '仕入在庫項目を削除しました。' })
    await loadMasters()
  }

  const categoryOptions = masters.filter((item) => item.value_type === 'category' && item.active)
  const productOptions = masters.filter((item) => item.value_type === 'product' && item.active)
  const scrapTypeOptions = productOptions.filter((item) => item.is_variety_rice)
  const standardMasterTypes: MasterType[] = ['recipient', 'origin', 'category', 'storage_location', 'customer']

  const editorForm = editor && <form className="purchase-statement-editor" noValidate onSubmit={(event) => void saveStatement(event)}>
    <div className="purchase-statement-editor-heading"><div><h2>{editor.id ? '仕切書を編集' : editor.sourceType === 'camera' ? '読取結果を確認' : '仕切書を手入力'}</h2><p>画像からの読取結果も、保存前に必ず確認・修正してください。</p></div><button className="icon-button" type="button" title="入力を閉じる" aria-label="入力を閉じる" onClick={() => setEditor(null)} disabled={busy}><X size={20} /></button></div>
    {editor.previewUrl && <img className="purchase-statement-preview" src={editor.previewUrl} alt="撮影した仕切書" />}
    {editor.warnings.length > 0 && <div className="notice warning"><strong>確認が必要な項目</strong>{editor.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
    <section className="purchase-statement-common"><h3>共通項目</h3><div className="purchase-statement-common-grid">
      <label>日付<JapaneseDateInput value={editor.header.statementDate} onChange={(value) => updateHeader('statementDate', value)} required /></label>
      <label>仕切書№<input value={editor.header.documentNumber} onChange={(event) => updateHeader('documentNumber', event.target.value)} required /></label>
      <label>担当者<input list="statement-recipient-list" value={editor.header.recipient} onChange={(event) => updateHeader('recipient', event.target.value)} /></label>
      <label>仕入先<input value={editor.header.issuer} onChange={(event) => updateHeader('issuer', event.target.value)} /></label>
      <label>支払方法<select value={editor.header.paymentMethod} onChange={(event) => updateHeader('paymentMethod', event.target.value)}><option value=""></option><option value="cash">現金</option><option value="transfer">振込</option></select></label>
      <label>消費税区分<select value={editor.header.taxTreatment} onChange={(event) => updateHeader('taxTreatment', event.target.value)} required><option value=""></option><option value="exclusive">税抜</option><option value="inclusive">税込</option></select></label>
      <label>税率（%）<input type="number" min="0" step="0.001" inputMode="decimal" value={editor.header.taxRate} onChange={(event) => updateHeader('taxRate', event.target.value)} /></label>
      <label>消費税額<MoneyInput value={editor.header.taxAmount} onChange={(value) => updateHeader('taxAmount', value)} /></label>
      <label className={importedTotalMismatch(editor) ? 'calculation-mismatch' : ''}>税込合計金額<MoneyInput value={editor.sourceType === 'manual' ? calculatedTotal(editor.items, editor.header.taxAmount, editor.header.taxTreatment) : editor.header.totalAmount} onChange={(value) => updateHeader('totalAmount', value)} readOnly={editor.sourceType === 'manual'} />{editor.sourceType === 'manual' && <small>{editor.header.taxTreatment === 'inclusive' ? '税込明細金額を合計' : '税抜明細金額＋消費税額を自動計算'}</small>}{importedTotalMismatch(editor) && <small>税区分に基づく明細金額の合計と一致しません</small>}</label>
      <label>登録番号（インボイス番号）<input value={editor.header.invoiceNumber} onChange={(event) => updateHeader('invoiceNumber', event.target.value)} /></label>
    </div></section>
    <section className="purchase-statement-details"><div className="purchase-statement-section-heading"><h3>明細情報</h3><button className="secondary-button" type="button" onClick={addItem} disabled={busy}><Plus size={17} />明細を追加</button></div>
      <div className="purchase-statement-table-wrap"><table><thead><tr><th>行</th><th>産年</th><th>産地</th><th>品名</th><th>荷姿</th><th>数量</th><th>単位</th><th>単価</th><th>金額</th><th></th></tr></thead><tbody>{editor.items.map((item, index) => <tr key={index}>
        <td data-label="行">{index + 1}</td>
        <td data-label="産年"><JapaneseCropYearInput value={item.cropYear} onChange={(value) => updateItem(index, 'cropYear', value)} /></td>
        <td data-label="産地"><input list="statement-origin-list" value={item.origin} onChange={(event) => updateItem(index, 'origin', event.target.value)} /></td>
        <td data-label="品名"><input list="statement-product-list" value={item.productName} onChange={(event) => updateItem(index, 'productName', event.target.value)} required /></td>
        <td data-label="荷姿"><input value={item.packageType} onChange={(event) => updateItem(index, 'packageType', event.target.value)} /></td>
        <td data-label="数量"><input type="number" min="0.001" step="0.001" inputMode="decimal" value={item.quantity} onChange={(event) => updateItem(index, 'quantity', event.target.value)} required={item.productName.trim() !== '免税'} /></td>
        <td data-label="単位"><input value={item.unit} onChange={(event) => updateItem(index, 'unit', event.target.value)} /></td>
        <td data-label="単価"><MoneyInput value={item.unitPrice} onChange={(value) => updateItem(index, 'unitPrice', value)} /></td>
        <td data-label="金額" className={editor.sourceType === 'camera' && itemAmountMismatch(item) ? 'calculation-mismatch' : ''}><MoneyInput value={item.amount} onChange={(value) => updateItem(index, 'amount', value)} required={item.productName.trim() === '免税'} />{item.productName.trim() === '免税' && <small>マイナス金額で入力</small>}{editor.sourceType === 'camera' && itemAmountMismatch(item) && <small>数量×単価と不一致</small>}</td>
        <td><button className="icon-button delete-icon" type="button" title="明細を削除" aria-label={`${index + 1}行目を削除`} onClick={() => removeItem(index)} disabled={busy || editor.items.length === 1}><Trash2 size={17} /></button></td>
      </tr>)}</tbody></table></div>
    </section>
    <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setEditor(null)} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : '仕切書を保存'}</button></div>
    <datalist id="statement-recipient-list">{suggestions('recipient').map((value) => <option value={value} key={value} />)}</datalist>
    <datalist id="statement-origin-list">{suggestions('origin').map((value) => <option value={value} key={value} />)}</datalist>
    <datalist id="statement-product-list">{suggestions('product').map((value) => <option value={value} key={value} />)}</datalist>
  </form>

  const statementDetail = selectedStatement && <section className="purchase-statement-detail-screen">
    <div className="purchase-statement-detail-heading"><button className="secondary-button" type="button" onClick={() => setSelectedStatement(null)}><ArrowLeft size={18} />一覧に戻る</button><div><h2>仕切書№ {selectedStatement.document_number}</h2><p>{formatJapaneseDate(selectedStatement.statement_date)}　{selectedStatement.issuer || '仕入先未入力'}</p></div></div>
    <dl className="purchase-statement-detail-summary"><div><dt>日付</dt><dd>{formatJapaneseDate(selectedStatement.statement_date)}</dd></div><div><dt>担当者</dt><dd>{selectedStatement.recipient || '―'}</dd></div><div><dt>仕入先</dt><dd>{selectedStatement.issuer || '―'}</dd></div><div><dt>支払方法</dt><dd>{paymentMethodLabel(selectedStatement.payment_method)}</dd></div><div><dt>消費税区分</dt><dd>{taxTreatmentLabel(selectedStatement.tax_treatment)}</dd></div><div><dt>税率</dt><dd>{selectedStatement.tax_rate == null ? '―' : `${selectedStatement.tax_rate}%`}</dd></div><div><dt>消費税額</dt><dd>{formatMoney(selectedStatement.tax_amount) || '―'}</dd></div><div><dt>金額（税込）</dt><dd>{formatMoney(selectedStatement.total_amount) || '―'}</dd></div><div><dt>登録番号</dt><dd>{selectedStatement.invoice_number || '―'}</dd></div></dl>
    <div className="purchase-statement-table-wrap"><table><thead><tr><th>産年</th><th>産地</th><th>品名</th><th>荷姿</th><th>数量</th><th>単価</th><th>金額</th></tr></thead><tbody>{selectedStatement.items.map((item) => <tr key={item.id}><td>{formatJapaneseCropYear(item.crop_year)}</td><td>{item.origin}</td><td>{item.product_name}</td><td>{item.package_type}</td><td>{item.quantity == null ? '' : Number(item.quantity).toLocaleString('ja-JP')}{item.unit}</td><td>{formatMoney(item.unit_price)}</td><td>{formatMoney(item.amount)}</td></tr>)}</tbody></table></div>
    <div className="purchase-statement-detail-actions">{selectedStatement.image_path && <button className="secondary-button" type="button" onClick={() => void openStatementImage(selectedStatement)} disabled={busy}><FileImage size={17} />元画像を表示</button>}{canOperate && <button className="secondary-button" type="button" onClick={() => editStatement(selectedStatement)} disabled={busy}><Pencil size={17} />編集</button>}{isAdmin && <button className="danger-button" type="button" onClick={() => void deleteStatement(selectedStatement)} disabled={busy}><Trash2 size={17} />削除</button>}</div>
  </section>

  return <div className="purchase-statement-page">
    <div className="page-heading"><p>{mode === 'reader' ? '仕切書を撮影して読み取るか、すべての項目を手入力します。' : mode === 'list' ? '登録済みの仕切書と明細を確認します。' : '仕切書の入力候補と在庫管理に使用する項目を管理します。'}</p></div>
    {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    {mode === 'reader' && canOperate && <>
      <input ref={cameraRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={(event) => { const file = event.target.files?.[0]; if (file) void preparePhoto(file) }} />
      <section className="section-band purchase-statement-actions"><div><h2>仕切書を登録</h2><p>撮影画像の読取り後も、全項目を手動で修正できます。</p></div><div><button className="primary-button" type="button" onClick={() => cameraRef.current?.click()} disabled={busy}><Camera size={20} />{busy ? '読取中...' : '撮影・画像を選択'}</button><button className="secondary-button" type="button" onClick={startManual} disabled={busy}><Keyboard size={20} />手入力</button></div></section>
      {editorForm}
    </>}
    {mode === 'list' && <>
      {selectedStatement ? statementDetail : <>
        <div className="search-row"><div className="search-input-wrap"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="日付・仕切書№・担当者・仕入先・産地・品名を検索" /></div><button className="secondary-button" type="button" onClick={() => void loadStatements()} disabled={loadingStatements}><RefreshCw size={17} />{loadingStatements ? '読込中' : '再読込'}</button></div>
        <div className="purchase-statement-list-count">{loadingStatements ? '一覧を読み込んでいます' : `${displayedStatements.length}仕切書・${displayedStatements.reduce((sum, statement) => sum + statement.items.length, 0)}明細`}</div>
        <div className="purchase-statement-overview-wrap"><table className="purchase-statement-overview"><thead><tr><th>仕切書№</th><th>内容</th><th>数量</th><th>単価</th><th>日付</th><th>担当者</th><th>金額（税込）</th><th>仕入先</th></tr></thead>
          {displayedStatements.map((statement, statementIndex) => {
            const rows: Array<StoredItem | null> = statement.items.length > 0 ? statement.items : [null]
            return <tbody className={statementIndex % 2 === 0 ? 'statement-even' : 'statement-odd'} key={statement.id}>{rows.map((item, itemIndex) => <tr key={item?.id ?? statement.id}>
              {itemIndex === 0 && <td rowSpan={rows.length}><button className="purchase-statement-number-link" type="button" onClick={() => setSelectedStatement(statement)}>{statement.document_number}</button></td>}
              <td>{item ? [formatJapaneseCropYear(item.crop_year), item.origin, item.product_name].filter(Boolean).join(' ') : ''}</td><td className="number-cell">{item?.quantity == null ? '' : `${Number(item.quantity).toLocaleString('ja-JP')}${item.unit ? ` ${item.unit}` : ''}`}</td><td className="number-cell">{item?.unit_price == null ? '' : Number(item.unit_price).toLocaleString('ja-JP')}</td>
              {itemIndex === 0 && <><td rowSpan={rows.length}>{formatJapaneseDate(statement.statement_date)}</td><td rowSpan={rows.length}>{statement.recipient || '―'}</td><td className="number-cell" rowSpan={rows.length}>{statement.total_amount == null ? '―' : Number(statement.total_amount).toLocaleString('ja-JP')}</td><td rowSpan={rows.length}>{statement.issuer || '―'}</td></>}
            </tr>)}</tbody>
          })}
        </table></div>
        {!loadingStatements && displayedStatements.length === 0 && <div className="empty-state">登録された仕切書はありません</div>}
      </>}
      {editor && <div className="modal-backdrop purchase-statement-edit-backdrop" role="presentation"><section className="registration-modal purchase-statement-edit-modal" role="dialog" aria-modal="true" aria-label="仕切書を編集">{editorForm}</section></div>}
    </>}
    {mode === 'master' && isAdmin && <div className="purchase-statement-master-grid">
      {standardMasterTypes.map((type) => {
        const items = masters.filter((item) => item.value_type === type)
        return <section className="section-band" key={type}>
          <div className="purchase-statement-master-heading"><h2>{masterLabels[type]}</h2></div>
          <div className="purchase-statement-master-table-wrap">
            <table className="purchase-statement-master-table standard"><thead><tr><th>{masterFieldLabels[type]}</th><th>並び順</th><th>削除</th></tr></thead><tbody>
              {items.map((item, index) => <tr key={item.id}><td><input value={masterNameEdits[item.id] ?? item.name} onChange={(event) => setMasterNameEdits((current) => ({ ...current, [item.id]: event.target.value }))} aria-label={`${item.name}の名称`} /></td><td><span className="master-order-buttons"><button className="icon-button" type="button" title="上へ移動" aria-label={`${item.name}を上へ移動`} onClick={() => moveMaster(item, -1)} disabled={busy || index === 0}><ChevronUp size={17} /></button><button className="icon-button" type="button" title="下へ移動" aria-label={`${item.name}を下へ移動`} onClick={() => moveMaster(item, 1)} disabled={busy || index === items.length - 1}><ChevronDown size={17} /></button></span></td><td><button className="icon-button delete-icon" type="button" title="削除" aria-label={`${item.name}を削除`} onClick={() => void deleteMaster(item)} disabled={busy}><Trash2 size={17} /></button></td></tr>)}
              {items.length === 0 && <tr><td colSpan={3} className="empty-state">登録されていません</td></tr>}
            </tbody></table>
          </div>
          <div className="purchase-statement-master-footer"><form className="purchase-statement-master-add-form" onSubmit={(event) => { event.preventDefault(); void saveMaster(type) }}><input value={masterDrafts[type]} onChange={(event) => setMasterDrafts((current) => ({ ...current, [type]: event.target.value }))} placeholder={`${masterFieldLabels[type]}を入力`} aria-label={masterFieldLabels[type]} required /><button className="secondary-button" disabled={busy}><Plus size={17} />追加</button></form><button className="primary-button" type="button" onClick={() => void saveMasterGroup(type)} disabled={busy || items.length === 0}><Save size={17} />変更を保存</button></div>
        </section>
      })}
      <section className="section-band purchase-statement-product-master"><div className="purchase-statement-master-heading"><h2>在庫商品管理</h2></div><div className="purchase-statement-master-table-wrap product"><table className="purchase-statement-master-table product"><thead><tr><th>種別</th><th>品名</th><th>くず米</th><th>並び順</th><th>削除</th></tr></thead><tbody>{masters.filter((item) => item.value_type === 'product').map((item, index, items) => {
        const settings = productEdits[item.id] ?? { categoryId: item.product_category_id ?? '', isVarietyRice: item.is_variety_rice }
        return <tr key={item.id}><td><select value={settings.categoryId} onChange={(event) => setProductEdits((current) => ({ ...current, [item.id]: { ...settings, categoryId: event.target.value } }))} aria-label={`${item.name}の種別`}><option value="">種別未設定</option>{categoryOptions.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></td><td><input value={masterNameEdits[item.id] ?? item.name} onChange={(event) => setMasterNameEdits((current) => ({ ...current, [item.id]: event.target.value }))} aria-label={`${item.name}の名称`} /></td><td><label className="checkbox-field compact"><input type="checkbox" checked={settings.isVarietyRice} onChange={(event) => setProductEdits((current) => ({ ...current, [item.id]: { ...settings, isVarietyRice: event.target.checked } }))} /><span className="visually-hidden">{item.name}をくず米に設定</span></label></td><td><span className="master-order-buttons"><button className="icon-button" type="button" title="上へ移動" aria-label={`${item.name}を上へ移動`} onClick={() => moveMaster(item, -1)} disabled={busy || index === 0}><ChevronUp size={17} /></button><button className="icon-button" type="button" title="下へ移動" aria-label={`${item.name}を下へ移動`} onClick={() => moveMaster(item, 1)} disabled={busy || index === items.length - 1}><ChevronDown size={17} /></button></span></td><td><button className="icon-button delete-icon" type="button" title="削除" aria-label={`${item.name}を削除`} onClick={() => void deleteMaster(item)} disabled={busy}><Trash2 size={17} /></button></td></tr>
      })}{masters.every((item) => item.value_type !== 'product') && <tr><td colSpan={5} className="empty-state">登録されていません</td></tr>}</tbody></table></div><div className="purchase-statement-master-footer"><form className="purchase-statement-master-add-form" onSubmit={(event) => { event.preventDefault(); void saveMaster('product') }}><select value={productCategoryId} onChange={(event) => setProductCategoryId(event.target.value)} aria-label="品名の種別"><option value="">種別未設定</option>{categoryOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><input value={masterDrafts.product} onChange={(event) => setMasterDrafts((current) => ({ ...current, product: event.target.value }))} placeholder="品名を入力" required /><label className="checkbox-field"><input type="checkbox" checked={productIsVarietyRice} onChange={(event) => setProductIsVarietyRice(event.target.checked)} />くず米</label><button className="secondary-button" disabled={busy}><Plus size={17} />追加</button></form><button className="primary-button" type="button" onClick={() => void saveMasterGroup('product')} disabled={busy || masters.every((item) => item.value_type !== 'product')}><Save size={17} />変更を保存</button></div></section>
      <section className="section-band purchase-inventory-master"><div className="purchase-statement-master-heading"><h2>仕入在庫管理</h2></div>
        <div className="purchase-statement-master-table-wrap purchase-inventory"><table className="purchase-statement-master-table purchase-inventory"><thead><tr><th>品名</th><th>在庫計上先</th><th>くず米種別</th><th>仕切書キーワード</th><th>並び順</th><th>削除</th></tr></thead><tbody>{purchaseInventoryMasters.map((item, index, items) => {
          const edit = purchaseInventoryEdits[item.id] ?? { name: item.name, inventoryProductId: item.inventory_product_id, scrapTypeProductId: item.scrap_type_product_id ?? '', keywords: item.statement_keywords.join('、') }
          return <tr key={item.id}><td><input value={edit.name} onChange={(event) => setPurchaseInventoryEdits((current) => ({ ...current, [item.id]: { ...edit, name: event.target.value } }))} aria-label={`${item.name}の品名`} /></td><td><select value={edit.inventoryProductId} onChange={(event) => setPurchaseInventoryEdits((current) => ({ ...current, [item.id]: { ...edit, inventoryProductId: event.target.value } }))} aria-label={`${item.name}の在庫計上先`}><option value="">選択してください</option>{productOptions.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select></td><td><select value={edit.scrapTypeProductId} onChange={(event) => setPurchaseInventoryEdits((current) => ({ ...current, [item.id]: { ...edit, scrapTypeProductId: event.target.value } }))} aria-label={`${item.name}のくず米種別`}><option value="">なし</option>{scrapTypeOptions.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select></td><td><input value={edit.keywords} onChange={(event) => setPurchaseInventoryEdits((current) => ({ ...current, [item.id]: { ...edit, keywords: event.target.value } }))} aria-label={`${item.name}の仕切書キーワード`} placeholder="、区切りで複数入力" /></td><td><span className="master-order-buttons"><button className="icon-button" type="button" title="上へ移動" aria-label={`${item.name}を上へ移動`} onClick={() => movePurchaseInventoryMaster(item, -1)} disabled={busy || index === 0}><ChevronUp size={17} /></button><button className="icon-button" type="button" title="下へ移動" aria-label={`${item.name}を下へ移動`} onClick={() => movePurchaseInventoryMaster(item, 1)} disabled={busy || index === items.length - 1}><ChevronDown size={17} /></button></span></td><td><button className="icon-button delete-icon" type="button" title="削除" aria-label={`${item.name}を削除`} onClick={() => void deletePurchaseInventoryMaster(item)} disabled={busy}><Trash2 size={17} /></button></td></tr>
        })}{purchaseInventoryMasters.length === 0 && <tr><td colSpan={6} className="empty-state">登録されていません</td></tr>}</tbody></table></div>
        <div className="purchase-statement-master-footer"><form className="purchase-statement-master-add-form" onSubmit={(event) => { event.preventDefault(); void addPurchaseInventoryMaster() }}>
          <input value={purchaseInventoryDraft.name} onChange={(event) => setPurchaseInventoryDraft((current) => ({ ...current, name: event.target.value }))} placeholder="品名を入力" aria-label="仕入在庫の品名" required />
          <select value={purchaseInventoryDraft.inventoryProductId} onChange={(event) => setPurchaseInventoryDraft((current) => ({ ...current, inventoryProductId: event.target.value }))} aria-label="在庫計上先" required><option value="">在庫計上先を選択</option>{productOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
          <select value={purchaseInventoryDraft.scrapTypeProductId} onChange={(event) => setPurchaseInventoryDraft((current) => ({ ...current, scrapTypeProductId: event.target.value }))} aria-label="くず米種別"><option value="">くず米種別なし</option>{scrapTypeOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
          <input value={purchaseInventoryDraft.keywords} onChange={(event) => setPurchaseInventoryDraft((current) => ({ ...current, keywords: event.target.value }))} placeholder="仕切書キーワード（、区切りで複数入力）" aria-label="仕切書キーワード" required />
          <button className="secondary-button" disabled={busy}><Plus size={17} />追加</button>
        </form><button className="primary-button" type="button" onClick={() => void savePurchaseInventoryMasterGroup()} disabled={busy || purchaseInventoryMasters.length === 0}><Save size={17} />変更を保存</button></div>
      </section>
    </div>}
    {duplicateStatement && editor && <div className="modal-backdrop" role="presentation"><section className="registration-modal purchase-statement-duplicate-modal" role="dialog" aria-modal="true" aria-labelledby="purchase-statement-duplicate-title"><div className="modal-header"><div><h2 id="purchase-statement-duplicate-title">同じ仕切書№が登録されています</h2><p>仕切書№「{duplicateStatement.document_number}」は{formatJapaneseDate(duplicateStatement.statement_date)}に登録済みです。</p></div></div><p>現在の内容で既存の仕切書を上書きしますか？</p><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setDuplicateStatement(null)} disabled={busy}>キャンセル</button><button className="primary-button" type="button" onClick={() => void persistStatement(duplicateStatement.id)} disabled={busy}><Save size={18} />{busy ? '上書き中...' : '上書き'}</button></div></section></div>}
    {viewingImageUrl && <div className="modal-backdrop purchase-statement-image-backdrop" role="presentation" onClick={() => setViewingImageUrl('')}><section className="registration-modal purchase-statement-image-modal" role="dialog" aria-modal="true" aria-label="保存した仕切書画像" onClick={(event) => event.stopPropagation()}><div className="modal-header"><h2>保存した仕切書画像</h2><button className="icon-button" type="button" title="閉じる" aria-label="画像を閉じる" onClick={() => setViewingImageUrl('')}><X size={20} /></button></div><img src={viewingImageUrl} alt="保存した仕切書" /></section></div>}
  </div>
}

