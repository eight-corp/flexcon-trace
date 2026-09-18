import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Camera, FileImage, Keyboard, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'

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
  items: StoredItem[]
}
type MasterType = 'recipient' | 'issuer' | 'product' | 'package'
type MasterValue = { id: string; value_type: MasterType; name: string; active: boolean; sort_order: number }
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
  lines: Array<{ crop_year: string; product_name: string; package_type: string; quantity: number; unit: string; unit_price: number; amount: number }>
  warnings: string[]
}

const masterLabels: Record<MasterType, string> = { recipient: '担当者', issuer: '仕入元', product: '品名', package: '荷姿' }

function today() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}

function emptyHeader(): HeaderForm {
  return { statementDate: today(), documentNumber: '', recipient: '', issuer: '', paymentMethod: '', taxTreatment: '', taxRate: '', taxAmount: '', totalAmount: '', invoiceNumber: '' }
}

function emptyItem(): ItemForm {
  return { cropYear: '', productName: '', packageType: '', quantity: '', unit: '', unitPrice: '', amount: '' }
}

function inputNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? String(number) : ''
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
  return value === 'exclusive' ? '外税（税抜）' : value === 'inclusive' ? '内税（税込）' : '―'
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
    const imageBase64 = await canvasJpegBase64(canvas, 0.86)

    const cropX = Math.round(canvas.width * 0.45)
    const cropY = Math.round(canvas.height * 0.12)
    const cropWidth = Math.max(1, Math.round(canvas.width * 0.53))
    const cropHeight = Math.max(1, Math.round(canvas.height * 0.32))
    const cropScale = Math.min(2, 1400 / cropWidth)
    const taxRegionCanvas = document.createElement('canvas')
    taxRegionCanvas.width = Math.max(1, Math.round(cropWidth * cropScale))
    taxRegionCanvas.height = Math.max(1, Math.round(cropHeight * cropScale))
    const taxRegionContext = taxRegionCanvas.getContext('2d')
    if (!taxRegionContext) throw new Error('税区分の画像を処理できませんでした。')
    taxRegionContext.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, taxRegionCanvas.width, taxRegionCanvas.height)
    const taxRegionBase64 = await canvasJpegBase64(taxRegionCanvas, 0.9)
    return { imageBase64, taxRegionBase64, mimeType: 'image/jpeg', previewUrl: `data:image/jpeg;base64,${imageBase64}` }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function PurchaseStatementManager({ mode, workerId, canOperate, isAdmin }: Props) {
  const cameraRef = useRef<HTMLInputElement>(null)
  const [statements, setStatements] = useState<StoredStatement[]>([])
  const [masters, setMasters] = useState<MasterValue[]>([])
  const [masterDrafts, setMasterDrafts] = useState<Record<MasterType, string>>({ recipient: '', issuer: '', product: '', package: '' })
  const [editor, setEditor] = useState<Editor | null>(null)
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
    const { data, error } = await supabase.rpc('flexcon_list_purchase_statement_master', { p_worker_id: workerId })
    if (error) return setNotice({ type: 'error', text: error.message })
    setMasters((data ?? []) as MasterValue[])
  }, [workerId])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- RPC results synchronize this view with Supabase.
    if (mode === 'list') void loadStatements()
    void loadMasters()
  }, [loadMasters, loadStatements, mode])

  const suggestions = (type: MasterType) => masters.filter((item) => item.value_type === type && item.active).map((item) => item.name)
  const displayedStatements = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return statements
    return statements.filter((statement) => [statement.statement_date, statement.document_number, statement.recipient, statement.issuer, statement.invoice_number, ...statement.items.flatMap((item) => [item.product_name, item.package_type])].some((value) => String(value ?? '').toLowerCase().includes(term)))
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
      const { data, error } = await supabase.functions.invoke('analyze-purchase-statement', { body: { imageBase64: image.imageBase64, taxRegionBase64: image.taxRegionBase64, mimeType: image.mimeType } })
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
    const { data: statementId, error } = await supabase.rpc('flexcon_save_purchase_statement', {
      p_worker_id: workerId,
      p_statement_id: editor.id,
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
        body: { action: 'upload', statementId, imageBase64: editor.imageBase64, mimeType: 'image/jpeg' },
      })
      if (imageError || !(imageData as { imagePath?: string } | null)?.imagePath) {
        let message = imageError?.message ?? '画像を保存できませんでした。'
        const context = (imageError as { context?: Response } | null)?.context
        if (context) try { message = ((await context.clone().json()) as { error?: string }).error ?? message } catch {}
        setEditor((current) => current ? { ...current, id: String(statementId) } : current)
        setBusy(false)
        return setNotice({ type: 'error', text: `仕切書は保存しましたが、画像を保存できませんでした。もう一度保存してください。${message}` })
      }
    }
    setBusy(false)
    setEditor(null)
    setNotice({ type: 'success', text: '仕切書を保存しました。' })
    if (mode === 'list') await loadStatements()
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
    setNotice({ type: imageWarning ? 'error' : 'success', text: `仕切書を削除しました。${imageWarning}` })
    await loadStatements()
  }

  const saveMaster = async (type: MasterType) => {
    const name = masterDrafts[type].trim()
    if (!name || busy) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_save_purchase_statement_master', { p_worker_id: workerId, p_value_id: null, p_value_type: type, p_name: name })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setMasterDrafts((current) => ({ ...current, [type]: '' }))
    setNotice({ type: 'success', text: `${masterLabels[type]}を追加しました。` })
    await loadMasters()
  }

  const deleteMaster = async (item: MasterValue) => {
    if (!isAdmin || busy || !window.confirm(`「${item.name}」を削除しますか？`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_purchase_statement_master', { p_worker_id: workerId, p_value_id: item.id })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    await loadMasters()
  }

  const editorForm = editor && <form className="purchase-statement-editor" noValidate onSubmit={(event) => void saveStatement(event)}>
    <div className="purchase-statement-editor-heading"><div><h2>{editor.id ? '仕切書を編集' : editor.sourceType === 'camera' ? '読取結果を確認' : '仕切書を手入力'}</h2><p>画像からの読取結果も、保存前に必ず確認・修正してください。</p></div><button className="icon-button" type="button" title="入力を閉じる" aria-label="入力を閉じる" onClick={() => setEditor(null)} disabled={busy}><X size={20} /></button></div>
    {editor.previewUrl && <img className="purchase-statement-preview" src={editor.previewUrl} alt="撮影した仕切書" />}
    {editor.warnings.length > 0 && <div className="notice warning"><strong>確認が必要な項目</strong>{editor.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
    <section className="purchase-statement-common"><h3>共通項目</h3><div className="purchase-statement-common-grid">
      <label>日付<input type="date" value={editor.header.statementDate} onChange={(event) => updateHeader('statementDate', event.target.value)} required /></label>
      <label>仕切書№<input value={editor.header.documentNumber} onChange={(event) => updateHeader('documentNumber', event.target.value)} required /></label>
      <label>担当者<input list="statement-recipient-list" value={editor.header.recipient} onChange={(event) => updateHeader('recipient', event.target.value)} /></label>
      <label>仕入元<input list="statement-issuer-list" value={editor.header.issuer} onChange={(event) => updateHeader('issuer', event.target.value)} /></label>
      <label>支払方法<select value={editor.header.paymentMethod} onChange={(event) => updateHeader('paymentMethod', event.target.value)}><option value=""></option><option value="cash">現金</option><option value="transfer">振込</option></select></label>
      <label>消費税区分<select value={editor.header.taxTreatment} onChange={(event) => updateHeader('taxTreatment', event.target.value)} required><option value=""></option><option value="exclusive">外税（税抜に丸）</option><option value="inclusive">内税（税込に丸）</option></select></label>
      <label>税率（%）<input type="number" min="0" step="0.001" inputMode="decimal" value={editor.header.taxRate} onChange={(event) => updateHeader('taxRate', event.target.value)} /></label>
      <label>消費税額<input type="number" min="0" step="1" inputMode="decimal" value={editor.header.taxAmount} onChange={(event) => updateHeader('taxAmount', event.target.value)} /></label>
      <label className={importedTotalMismatch(editor) ? 'calculation-mismatch' : ''}>税込合計金額<input type="number" min="0" step="1" inputMode="decimal" value={editor.sourceType === 'manual' ? calculatedTotal(editor.items, editor.header.taxAmount, editor.header.taxTreatment) : editor.header.totalAmount} onChange={(event) => updateHeader('totalAmount', event.target.value)} readOnly={editor.sourceType === 'manual'} />{editor.sourceType === 'manual' && <small>{editor.header.taxTreatment === 'inclusive' ? '税込明細金額を合計' : '税抜明細金額＋消費税額を自動計算'}</small>}{importedTotalMismatch(editor) && <small>税区分に基づく明細金額の合計と一致しません</small>}</label>
      <label>登録番号（インボイス番号）<input value={editor.header.invoiceNumber} onChange={(event) => updateHeader('invoiceNumber', event.target.value)} /></label>
    </div></section>
    <section className="purchase-statement-details"><div className="purchase-statement-section-heading"><h3>明細情報</h3><button className="secondary-button" type="button" onClick={addItem} disabled={busy}><Plus size={17} />明細を追加</button></div>
      <div className="purchase-statement-table-wrap"><table><thead><tr><th>行</th><th>産年</th><th>品名</th><th>荷姿</th><th>数量</th><th>単位</th><th>単価</th><th>金額</th><th></th></tr></thead><tbody>{editor.items.map((item, index) => <tr key={index}>
        <td data-label="行">{index + 1}</td>
        <td data-label="産年"><input type="number" min="1900" max="2100" step="1" value={item.cropYear} onChange={(event) => updateItem(index, 'cropYear', event.target.value)} /></td>
        <td data-label="品名"><input list="statement-product-list" value={item.productName} onChange={(event) => updateItem(index, 'productName', event.target.value)} required /></td>
        <td data-label="荷姿"><input list="statement-package-list" value={item.packageType} onChange={(event) => updateItem(index, 'packageType', event.target.value)} /></td>
        <td data-label="数量"><input type="number" min="0.001" step="0.001" inputMode="decimal" value={item.quantity} onChange={(event) => updateItem(index, 'quantity', event.target.value)} required={item.productName.trim() !== '免税'} /></td>
        <td data-label="単位"><input value={item.unit} onChange={(event) => updateItem(index, 'unit', event.target.value)} /></td>
        <td data-label="単価"><input type="number" min="0" step="0.01" inputMode="decimal" value={item.unitPrice} onChange={(event) => updateItem(index, 'unitPrice', event.target.value)} /></td>
        <td data-label="金額" className={editor.sourceType === 'camera' && itemAmountMismatch(item) ? 'calculation-mismatch' : ''}><input type="number" min={item.productName.trim() === '免税' ? undefined : 0} max={item.productName.trim() === '免税' ? -0.01 : undefined} step="0.01" inputMode="decimal" value={item.amount} onChange={(event) => updateItem(index, 'amount', event.target.value)} required={item.productName.trim() === '免税'} />{item.productName.trim() === '免税' && <small>マイナス金額で入力</small>}{editor.sourceType === 'camera' && itemAmountMismatch(item) && <small>数量×単価と不一致</small>}</td>
        <td><button className="icon-button delete-icon" type="button" title="明細を削除" aria-label={`${index + 1}行目を削除`} onClick={() => removeItem(index)} disabled={busy || editor.items.length === 1}><Trash2 size={17} /></button></td>
      </tr>)}</tbody></table></div>
    </section>
    <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setEditor(null)} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : '仕切書を保存'}</button></div>
    <datalist id="statement-recipient-list">{suggestions('recipient').map((value) => <option value={value} key={value} />)}</datalist>
    <datalist id="statement-issuer-list">{suggestions('issuer').map((value) => <option value={value} key={value} />)}</datalist>
    <datalist id="statement-product-list">{suggestions('product').map((value) => <option value={value} key={value} />)}</datalist>
    <datalist id="statement-package-list">{suggestions('package').map((value) => <option value={value} key={value} />)}</datalist>
  </form>

  return <div className="purchase-statement-page">
    <div className="page-heading"><h1>{mode === 'reader' ? '仕切書読込' : mode === 'list' ? '仕切書一覧' : 'マスタ'}</h1><p>{mode === 'reader' ? '仕切書を撮影して読み取るか、すべての項目を手入力します。' : mode === 'list' ? '登録済みの仕切書と明細を確認します。' : '手入力時に候補として表示する項目を管理します。'}</p></div>
    {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    {mode === 'reader' && canOperate && <>
      <input ref={cameraRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={(event) => { const file = event.target.files?.[0]; if (file) void preparePhoto(file) }} />
      <section className="section-band purchase-statement-actions"><div><h2>仕切書を登録</h2><p>撮影画像の読取り後も、全項目を手動で修正できます。</p></div><div><button className="primary-button" type="button" onClick={() => cameraRef.current?.click()} disabled={busy}><Camera size={20} />{busy ? '読取中...' : '撮影・画像を選択'}</button><button className="secondary-button" type="button" onClick={startManual} disabled={busy}><Keyboard size={20} />手入力</button></div></section>
      {editorForm}
    </>}
    {mode === 'list' && <>
      <div className="search-row"><div className="search-input-wrap"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="日付・仕切書№・担当者・仕入元・品名を検索" /></div><button className="secondary-button" type="button" onClick={() => void loadStatements()} disabled={loadingStatements}><RefreshCw size={17} />{loadingStatements ? '読込中' : '再読込'}</button></div>
      <div className="purchase-statement-list-count">{loadingStatements ? '一覧を読み込んでいます' : `${displayedStatements.length}仕切書・${displayedStatements.reduce((sum, statement) => sum + statement.items.length, 0)}明細`}</div>
      <div className="purchase-statement-list">{displayedStatements.map((statement) => <details className="purchase-statement-card" key={statement.id}><summary><span><strong>{statement.statement_date.replaceAll('-', '/')}</strong><b>{statement.document_number}</b><span>{statement.issuer || '仕入元未入力'}</span></span><span>{formatMoney(statement.total_amount)}　{statement.items.length}明細</span></summary><div className="purchase-statement-card-body">
        <dl><div><dt>担当者</dt><dd>{statement.recipient || '―'}</dd></div><div><dt>仕入元</dt><dd>{statement.issuer || '―'}</dd></div><div><dt>支払方法</dt><dd>{paymentMethodLabel(statement.payment_method)}</dd></div><div><dt>消費税区分</dt><dd>{taxTreatmentLabel(statement.tax_treatment)}</dd></div><div><dt>税率</dt><dd>{statement.tax_rate == null ? '―' : `${statement.tax_rate}%`}</dd></div><div><dt>消費税額</dt><dd>{formatMoney(statement.tax_amount) || '―'}</dd></div><div><dt>税込合計</dt><dd>{formatMoney(statement.total_amount) || '―'}</dd></div><div><dt>登録番号</dt><dd>{statement.invoice_number || '―'}</dd></div></dl>
        <div className="purchase-statement-table-wrap"><table><thead><tr><th>産年</th><th>品名</th><th>荷姿</th><th>数量</th><th>単価</th><th>金額</th></tr></thead><tbody>{statement.items.map((item) => <tr key={item.id}><td>{item.crop_year ?? ''}</td><td>{item.product_name}</td><td>{item.package_type}</td><td>{item.quantity == null ? '' : Number(item.quantity).toLocaleString('ja-JP')}{item.unit}</td><td>{formatMoney(item.unit_price)}</td><td>{formatMoney(item.amount)}</td></tr>)}</tbody></table></div>
        <div className="purchase-statement-card-actions">{statement.image_path && <button className="secondary-button" type="button" onClick={() => void openStatementImage(statement)} disabled={busy}><FileImage size={17} />画像を表示</button>}{canOperate && <button className="secondary-button" type="button" onClick={() => editStatement(statement)} disabled={busy}><Pencil size={17} />編集</button>}{isAdmin && <button className="danger-button" type="button" onClick={() => void deleteStatement(statement)} disabled={busy}><Trash2 size={17} />削除</button>}</div>
      </div></details>)}{!loadingStatements && displayedStatements.length === 0 && <div className="empty-state">登録された仕切書はありません</div>}</div>
      {editor && <div className="modal-backdrop purchase-statement-edit-backdrop" role="presentation"><section className="registration-modal purchase-statement-edit-modal" role="dialog" aria-modal="true" aria-label="仕切書を編集">{editorForm}</section></div>}
    </>}
    {mode === 'master' && isAdmin && <div className="purchase-statement-master-grid">{(Object.keys(masterLabels) as MasterType[]).map((type) => <section className="section-band" key={type}><h2>{masterLabels[type]}</h2><form onSubmit={(event) => { event.preventDefault(); void saveMaster(type) }}><input value={masterDrafts[type]} onChange={(event) => setMasterDrafts((current) => ({ ...current, [type]: event.target.value }))} placeholder={`${masterLabels[type]}を入力`} required /><button className="primary-button" disabled={busy}><Plus size={17} />追加</button></form><div className="purchase-statement-master-list">{masters.filter((item) => item.value_type === type).map((item) => <div key={item.id}><span>{item.name}</span><button className="icon-button delete-icon" type="button" title="削除" aria-label={`${item.name}を削除`} onClick={() => void deleteMaster(item)} disabled={busy}><Trash2 size={17} /></button></div>)}{masters.every((item) => item.value_type !== type) && <p className="empty-state">登録されていません</p>}</div></section>)}</div>}
    {viewingImageUrl && <div className="modal-backdrop purchase-statement-image-backdrop" role="presentation" onClick={() => setViewingImageUrl('')}><section className="registration-modal purchase-statement-image-modal" role="dialog" aria-modal="true" aria-label="保存した仕切書画像" onClick={(event) => event.stopPropagation()}><div className="modal-header"><h2>保存した仕切書画像</h2><button className="icon-button" type="button" title="閉じる" aria-label="画像を閉じる" onClick={() => setViewingImageUrl('')}><X size={20} /></button></div><img src={viewingImageUrl} alt="保存した仕切書" /></section></div>}
  </div>
}
