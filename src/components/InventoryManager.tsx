import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowDownToLine, ArrowRightLeft, ArrowUp, ArrowUpFromLine, Camera, FileUp, Filter, Pencil, Plus, Save, Search, Trash2, Warehouse, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { InspectionOption } from '../types'

type Props = { view: ViewMode; workerId: string; workerName: string; canOperate: boolean; isAdmin: boolean }
type MovementMode = 'inbound' | 'outbound' | 'transfer'
type InventoryMovementType = MovementMode | 'settlement'
type ViewMode = 'history' | 'balance' | 'statement-reader' | 'statement-list'
type SortDirection = 'asc' | 'desc'
type InventoryColumn = 'movementDate' | 'cropYear' | 'movementType' | 'settlementNo' | 'workerName' | 'producerName' | 'origin' | 'productName' | 'grade' | 'quantity' | 'unit' | 'purchasePrice' | 'movementFrom' | 'movementTo'
type InventoryMovement = {
  id: string
  registration_order?: number
  source_type: 'manual' | 'settlement' | 'inspection_flexcon' | 'inspection_paper_bag' | 'shipment_flexcon' | 'shipment_manual' | 'shipment_record'
  movement_type: InventoryMovementType
  movement_date: string
  crop_year: number | null
  worker_name: string
  producer_name: string
  settlement_no: string
  origin: string
  product_name: string
  grade: string
  quantity: number
  unit: string
  purchase_price: number | null
  from_warehouse_id: string | null
  to_warehouse_id: string | null
  movement_from: string
  movement_to: string
}
type InventoryBalance = { warehouse_id: string | null; warehouse_name: string; origin: string; product_name: string; grade: string; quantity: number; unit: string }
type InventoryBalanceRow = { warehouseId: string | null; warehouseName: string; origin: string; productName: string; unit: string; quantities: Record<string, number> }
type MovementForm = { movementDate: string; cropYear: string; origin: string; productName: string; grade: string; quantity: string; unit: string; fromWarehouseId: string; toWarehouseId: string }
type PurchaseImportRecord = {
  settlement_no: string
  detail_no: number
  part_no: number
  source_import_id: string
  crop_year: number | null
  purchased_at: string
  origin: string
  raw_product_name: string
  product_name: string
  producer_name: string
  raw_quantity: number
  raw_unit: string
  grade: string
  quantity: number
  unit: string
  purchase_price: number | null
}
type GeminiStatement = {
  settlement_no: string
  crop_year: string
  purchased_at: string
  origin: string
  producer_name: string
  purchase_price: number
  lines: Array<{ product_name: string; package_type: 'FL' | '紙袋' | 'その他'; quantity: number; unit: string }>
  warnings: string[]
}
type StatementEditRow = {
  id: string
  origin: string
  productName: string
  quantity: string
  unit: string
}
type StatementEditForm = {
  originalSettlementNo: string
  movementDate: string
  settlementNo: string
  producerName: string
  toWarehouseId: string
  rows: StatementEditRow[]
}

const INVENTORY_COLUMNS: Array<{ key: InventoryColumn; label: string }> = [
  { key: 'movementDate', label: '日付' },
  { key: 'cropYear', label: '産年' },
  { key: 'movementType', label: '区分' },
  { key: 'settlementNo', label: '仕切り書№' },
  { key: 'workerName', label: '作業者名' },
  { key: 'producerName', label: '生産者名' },
  { key: 'origin', label: '産地' },
  { key: 'productName', label: '名称' },
  { key: 'grade', label: '等級' },
  { key: 'quantity', label: '量' },
  { key: 'unit', label: '単位' },
  { key: 'purchasePrice', label: '仕入価格' },
  { key: 'movementFrom', label: '移動元' },
  { key: 'movementTo', label: '移動先' },
]

function today() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}

function emptyForm(): MovementForm {
  return { movementDate: today(), cropYear: '', origin: '', productName: '', grade: '', quantity: '', unit: 'kg', fromWarehouseId: '', toWarehouseId: '' }
}

function formatQuantity(value: number) {
  return Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 3 })
}

function weekdayLabel(value: string) {
  const parts = value.split('-').map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return ''
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][new Date(parts[0], parts[1] - 1, parts[2]).getDay()]
  return `（${weekday}）`
}

function excelCellText(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizedExcelHeader(value: unknown) {
  return excelCellText(value).normalize('NFKC').replace(/[\s　_№#]/g, '').toLowerCase()
}

function normalizeOrigin(value: unknown) {
  const origin = excelCellText(value).normalize('NFKC')
  if (!origin) return ''
  return /[都道府県]$/.test(origin) ? origin : `${origin}県`
}

function normalizePurchaseDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    const hour = String(value.getHours()).padStart(2, '0')
    const minute = String(value.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day}T${hour}:${minute}:00+09:00`
  }
  const match = excelCellText(value).replaceAll('/', '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/)
  if (!match) return ''
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}T${(match[4] ?? '0').padStart(2, '0')}:${match[5] ?? '00'}:00+09:00`
}

function normalizeSourceUnit(value: unknown) {
  const unit = excelCellText(value).normalize('NFKC').toLowerCase()
  if (unit === 'kg' || unit === 'キロ') return 'kg'
  if (unit === '俵' || unit === '本' || unit === '袋') return unit
  return excelCellText(value)
}

function normalizeSourceProduct(value: unknown) {
  return excelCellText(value).normalize('NFKC').replace(/色選ばじき/g, '色選はじき')
}

function productReadingKey(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0x60))
    .replace(/[\s　]/g, '')
}

async function resizeStatementPhoto(file: File) {
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
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('撮影画像を変換できませんでした。')), 'image/jpeg', 0.86))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
    const imageBase64 = btoa(binary)
    return { imageBase64, mimeType: 'image/jpeg', previewUrl: `data:image/jpeg;base64,${imageBase64}` }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function splitSourceProduct(value: unknown) {
  const raw = normalizeSourceProduct(value)
  const packageMatch = raw.match(/\((FL|紙袋)\)\s*$/i)
  const sourceProductName = packageMatch ? raw.slice(0, packageMatch.index).trim() : raw
  const aliases: Record<string, string> = { ひめのもち: 'ヒメノモチ', もちくず米: 'くず米' }
  return {
    raw,
    productName: aliases[sourceProductName] ?? sourceProductName,
    packageType: packageMatch?.[1].toUpperCase() === 'FL' ? 'FL' : packageMatch?.[1] === '紙袋' ? '紙袋' : '',
  }
}

function modeForMovement(movement: InventoryMovement): MovementMode {
  if (movement.movement_type === 'transfer') return 'transfer'
  if (movement.movement_type === 'outbound') return 'outbound'
  if (movement.movement_type) return 'inbound'
  if (!movement.from_warehouse_id) return 'inbound'
  if (!movement.to_warehouse_id) return 'outbound'
  return 'transfer'
}

function movementTypeLabel(movement: InventoryMovement) {
  if (movement.movement_type === 'settlement') return '仕切り書'
  if (movement.source_type === 'inspection_flexcon' || movement.source_type === 'inspection_paper_bag') return '検査記録'
  if (movement.source_type === 'shipment_flexcon' || movement.source_type === 'shipment_manual' || movement.source_type === 'shipment_record') return '出荷'
  const mode = modeForMovement(movement)
  return mode === 'inbound' ? '入庫' : mode === 'outbound' ? '出庫' : '倉庫間移動'
}

function movementBadgeClass(movement: InventoryMovement) {
  if (movement.movement_type === 'settlement') return 'settlement'
  return modeForMovement(movement)
}

function movementValue(movement: InventoryMovement, key: InventoryColumn) {
  if (key === 'movementDate') return movement.movement_date.replaceAll('-', '/')
  if (key === 'cropYear') return movement.crop_year == null ? '' : String(movement.crop_year)
  if (key === 'movementType') return movementTypeLabel(movement)
  if (key === 'settlementNo') return movement.settlement_no
  if (key === 'workerName') return movement.worker_name
  if (key === 'producerName') return movement.producer_name
  if (key === 'productName') return movement.product_name
  if (key === 'quantity') return formatQuantity(movement.quantity)
  if (key === 'purchasePrice') return movement.purchase_price == null ? '' : `${Number(movement.purchase_price).toLocaleString('ja-JP')}円`
  if (key === 'movementFrom') return movement.movement_from
  if (key === 'movementTo') return movement.source_type === 'settlement' && !movement.to_warehouse_id ? '移動先未指定' : movement.movement_to
  if (key === 'grade') return movement.grade || '対象外'
  return movement[key]
}

function movementSelectionKey(movement: InventoryMovement) {
  return `${movement.source_type}:${movement.id}`
}

function balanceValue(row: InventoryBalanceRow, key: string) {
  if (key === 'warehouseName') return row.warehouseName
  if (key === 'origin') return row.origin
  if (key === 'productName') return row.productName
  if (key === 'unit') return row.unit
  const quantity = row.quantities[key.slice('grade:'.length)] ?? 0
  return quantity === 0 ? '' : formatQuantity(quantity)
}

function FilterableColumnHeader<Key extends string>({
  column,
  sort,
  values,
  selectedValues,
  onSort,
  onFilterChange,
  openRight = false,
}: {
  column: { key: Key; label: string }
  sort?: { key: Key; direction: SortDirection } | null
  values: string[]
  selectedValues: string[] | undefined
  onSort?: (key: Key) => void
  onFilterChange: (key: Key, values: string[] | undefined) => void
  openRight?: boolean
}) {
  const filterRef = useRef<HTMLDetailsElement>(null)
  const allSelected = selectedValues === undefined || selectedValues.length === values.length

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      const filter = filterRef.current
      if (filter?.open && event.target instanceof Node && !filter.contains(event.target)) filter.open = false
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [])

  return <th className="inventory-filter-heading">
    <div className="shipment-column-heading">
      {onSort ? <button type="button" className="shipment-column-sort" onClick={() => onSort(column.key)}>
        <span>{column.label}</span>
        {sort?.key === column.key && (sort.direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
      </button> : <div className="shipment-column-sort"><span>{column.label}</span></div>}
      <details ref={filterRef} className={`shipment-column-filter ${openRight ? 'open-right' : ''} ${selectedValues === undefined ? '' : 'active'}`}>
        <summary title={`${column.label}を絞り込む`} aria-label={`${column.label}を絞り込む`}><Filter size={14} /></summary>
        <div className="shipment-filter-menu">
          <strong>{column.label}</strong>
          <label><input type="checkbox" checked={allSelected} onChange={() => onFilterChange(column.key, allSelected ? [] : undefined)} />すべて</label>
          <div className="shipment-filter-values">
            {values.map((value) => {
              const checked = selectedValues === undefined || selectedValues.includes(value)
              return <label key={value}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const current = selectedValues ?? values
                    const next = checked ? current.filter((item) => item !== value) : [...current, value]
                    onFilterChange(column.key, next.length === values.length ? undefined : next)
                  }}
                />
                {value || '（空白）'}
              </label>
            })}
          </div>
        </div>
      </details>
    </div>
  </th>
}

export function InventoryManager({ view, workerId, workerName, canOperate, isAdmin }: Props) {
  const [movementMode, setMovementMode] = useState<MovementMode>('inbound')
  const [warehouses, setWarehouses] = useState<InspectionOption[]>([])
  const [productOptions, setProductOptions] = useState<InspectionOption[]>([])
  const [movements, setMovements] = useState<InventoryMovement[]>([])
  const [balances, setBalances] = useState<InventoryBalance[]>([])
  const [form, setForm] = useState<MovementForm>(emptyForm)
  const [editing, setEditing] = useState<InventoryMovement | null>(null)
  const [editMode, setEditMode] = useState<MovementMode>('inbound')
  const [editForm, setEditForm] = useState<MovementForm>(emptyForm)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: InventoryColumn; direction: SortDirection } | null>(null)
  const [columnFilters, setColumnFilters] = useState<Partial<Record<InventoryColumn, string[]>>>({})
  const [balanceSearch, setBalanceSearch] = useState('')
  const [balanceColumnFilters, setBalanceColumnFilters] = useState<Record<string, string[]>>({})
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const importFileRef = useRef<HTMLInputElement>(null)
  const cameraFileRef = useRef<HTMLInputElement>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importSource, setImportSource] = useState<'excel' | 'camera'>('excel')
  const [importFileName, setImportFileName] = useState('')
  const [importPreviewUrl, setImportPreviewUrl] = useState('')
  const [importWarehouseIds, setImportWarehouseIds] = useState<Record<string, string>>({})
  const [importRecords, setImportRecords] = useState<PurchaseImportRecord[]>([])
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [importBlockedSettlementNos, setImportBlockedSettlementNos] = useState<string[]>([])
  const [importError, setImportError] = useState('')
  const [importProductMappings, setImportProductMappings] = useState<Record<string, string>>({})
  const [statementEditForm, setStatementEditForm] = useState<StatementEditForm | null>(null)
  const [selectedMovementKeys, setSelectedMovementKeys] = useState<Set<string>>(new Set())

  useEffect(() => {
    void Promise.all([
      supabase.from('flexcon_inspection_options').select('*').eq('option_type', 'warehouse').order('sort_order').order('name'),
      supabase.from('flexcon_inspection_options').select('*').in('option_type', ['origin', 'brand', 'brand_aomori', 'brand_iwate', 'shipment_product', 'grade']).eq('active', true).order('sort_order').order('name'),
      supabase.from('flexcon_inventory_ledger').select('*')
        .not('source_type', 'in', '(inspection_flexcon,inspection_paper_bag,shipment_record)')
        .order('movement_date', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: true }).limit(1000),
      supabase.from('flexcon_inventory_balances').select('*').order('warehouse_name').order('origin').order('product_name').order('grade').order('unit'),
    ]).then(([warehouseResult, productResult, movementResult, balanceResult]) => {
      if (warehouseResult.error || movementResult.error || balanceResult.error) return setNotice({ type: 'error', text: '在庫情報を取得できません。在庫管理用SQLを実行してください。' })
      setWarehouses((warehouseResult.data ?? []) as InspectionOption[])
      if (!productResult.error) setProductOptions((productResult.data ?? []) as InspectionOption[])
      const movementRows = (movementResult.data ?? []) as InventoryMovement[]
      if (movementRows.every((movement) => Number.isFinite(Number(movement.registration_order)))) {
        movementRows.sort((left, right) => Number(left.registration_order) - Number(right.registration_order))
      }
      setMovements(movementRows)
      setBalances((balanceResult.data ?? []) as InventoryBalance[])
    })
  }, [version])

  const activeWarehouses = warehouses.filter((warehouse) => warehouse.active)
  const originOptions = productOptions.filter((item) => item.option_type === 'origin')
  const otherProductNames = useMemo(() => new Set(productOptions.filter((item) => item.option_type === 'shipment_product').map((item) => item.name)), [productOptions])
  const productNamesFor = (origin: string) => {
    const regionalType = origin === '青森県' ? 'brand_aomori' : origin === '岩手県' ? 'brand_iwate' : ''
    const allowedTypes = [regionalType, ...(origin === '青森県' ? ['brand'] : []), 'shipment_product']
    return [...new Set(productOptions.filter((item) => allowedTypes.includes(item.option_type)).map((item) => item.name))]
  }
  const gradesFor = (productName: string) => otherProductNames.has(productName)
    ? []
    : [{ id: 'inventory-before-inspection', option_type: 'grade', name: '検査前', description: null, active: true, sort_order: -2, created_at: '', updated_at: '' } satisfies InspectionOption,
      { id: 'inventory-uninspected', option_type: 'grade', name: '未検査', description: null, active: true, sort_order: -1, created_at: '', updated_at: '' } satisfies InspectionOption,
      ...productOptions.filter((item) => item.option_type === 'grade' && (productName === '飼料用玄米' ? item.name === '合格' : item.name !== '合格'))]
  const addProductNames = productNamesFor(form.origin)
  const addGrades = gradesFor(form.productName)
  const editProductNames = productNamesFor(editForm.origin)
  const editGrades = gradesFor(editForm.productName)
  const knownProductNames = useMemo(() => new Set(productOptions.filter((item) => ['brand', 'brand_aomori', 'brand_iwate', 'shipment_product'].includes(item.option_type)).map((item) => item.name)), [productOptions])
  const masterProductByReading = useMemo(() => new Map(productOptions
    .filter((item) => ['brand', 'brand_aomori', 'brand_iwate', 'shipment_product'].includes(item.option_type))
    .map((item) => [productReadingKey(item.name), item.name])), [productOptions])
  const unmappedImportProducts = useMemo(() => [...new Set(importRecords.map((record) => record.product_name).filter((name) => !knownProductNames.has(name)))], [importRecords, knownProductNames])
  const mappedImportRecords = useMemo(() => {
    const blocked = new Set(importBlockedSettlementNos)
    importRecords.forEach((record) => {
      const productName = importProductMappings[record.product_name] ?? record.product_name
      if (!knownProductNames.has(productName)) blocked.add(record.settlement_no)
    })
    return importRecords.flatMap((record) => {
    const productName = importProductMappings[record.product_name] ?? record.product_name
    if (blocked.has(record.settlement_no) || !knownProductNames.has(productName)) return []
    return [{ ...record, product_name: productName, grade: otherProductNames.has(productName) ? '対象外' : '未検査' }]
    })
  }, [importBlockedSettlementNos, importProductMappings, importRecords, knownProductNames, otherProductNames])
  const importSettlements = useMemo(() => {
    const grouped = new Map<string, { settlementNo: string; producerName: string; purchaseDate: string; lineCount: number }>()
    mappedImportRecords.forEach((record) => {
      const current = grouped.get(record.settlement_no)
      if (current) current.lineCount += 1
      else grouped.set(record.settlement_no, { settlementNo: record.settlement_no, producerName: record.producer_name, purchaseDate: record.purchased_at.slice(0, 10), lineCount: 1 })
    })
    return [...grouped.values()].sort((left, right) => left.settlementNo.localeCompare(right.settlementNo, 'ja', { numeric: true }))
  }, [mappedImportRecords])
  const balanceGradeColumns = useMemo(() => [...new Set([
    ...productOptions.filter((item) => item.option_type === 'grade').map((item) => item.name),
    ...balances.map((item) => item.grade || '対象外'),
    '対象外',
  ])], [balances, productOptions])
  const balanceRows = useMemo(() => {
    const grouped = new Map<string, InventoryBalanceRow>()
    balances.forEach((balance) => {
      const key = `${balance.warehouse_id}\u001f${balance.origin}\u001f${balance.product_name}\u001f${balance.unit}`
      const row = grouped.get(key) ?? {
        warehouseId: balance.warehouse_id,
        warehouseName: balance.warehouse_name,
        origin: balance.origin,
        productName: balance.product_name,
        unit: balance.unit,
        quantities: {},
      }
      const grade = balance.grade || '対象外'
      row.quantities[grade] = (row.quantities[grade] ?? 0) + Number(balance.quantity)
      grouped.set(key, row)
    })
    return [...grouped.values()].sort((left, right) => (left.warehouseId === null ? -1 : 0) - (right.warehouseId === null ? -1 : 0)
      || left.warehouseName.localeCompare(right.warehouseName, 'ja', { numeric: true })
      || left.origin.localeCompare(right.origin, 'ja', { numeric: true })
      || left.productName.localeCompare(right.productName, 'ja', { numeric: true })
      || left.unit.localeCompare(right.unit, 'ja', { numeric: true }))
  }, [balances])
  const assignedBalanceRows = useMemo(() => balanceRows.filter((row) => row.warehouseId !== null), [balanceRows])
  const unassignedBalanceRows = useMemo(() => balanceRows.filter((row) => row.warehouseId === null), [balanceRows])
  const balanceColumns = useMemo(() => [
    { key: 'warehouseName', label: '倉庫' },
    { key: 'origin', label: '産地' },
    { key: 'productName', label: '名称' },
    { key: 'unit', label: '単位' },
    ...balanceGradeColumns.map((grade) => ({ key: `grade:${grade}`, label: grade })),
  ], [balanceGradeColumns])
  const balanceFilterValues = useMemo(() => Object.fromEntries(balanceColumns.map((column) => [
    column.key,
    [...new Set(assignedBalanceRows.map((row) => balanceValue(row, column.key)))].sort((left, right) => left.localeCompare(right, 'ja', { numeric: true })),
  ])) as Record<string, string[]>, [assignedBalanceRows, balanceColumns])
  const displayedBalanceRows = useMemo(() => {
    const term = balanceSearch.trim().toLowerCase()
    return assignedBalanceRows.filter((row) => {
      if (term && !balanceColumns.some((column) => balanceValue(row, column.key).toLowerCase().includes(term))) return false
      return balanceColumns.every((column) => balanceColumnFilters[column.key] === undefined || balanceColumnFilters[column.key].includes(balanceValue(row, column.key)))
    })
  }, [assignedBalanceRows, balanceColumnFilters, balanceColumns, balanceSearch])
  const displayedUnassignedBalanceRows = useMemo(() => {
    const term = balanceSearch.trim().toLowerCase()
    if (!term) return unassignedBalanceRows
    return unassignedBalanceRows.filter((row) => balanceColumns.some((column) => balanceValue(row, column.key).toLowerCase().includes(term)))
  }, [balanceColumns, balanceSearch, unassignedBalanceRows])
  const balanceTotals = useMemo(() => {
    const totals: Record<string, Record<string, number>> = {}
    displayedBalanceRows.forEach((row) => {
      balanceGradeColumns.forEach((grade) => {
        const quantity = row.quantities[grade] ?? 0
        if (!quantity) return
        totals[grade] ??= {}
        totals[grade][row.unit] = (totals[grade][row.unit] ?? 0) + quantity
      })
    })
    return totals
  }, [balanceGradeColumns, displayedBalanceRows])
  const balanceIsFiltered = balanceSearch.trim() !== '' || Object.keys(balanceColumnFilters).length > 0
  const warehouseRouteAvailable = movementMode === 'inbound'
    ? activeWarehouses.length > 0
    : movementMode === 'outbound'
      ? warehouses.length > 0
      : activeWarehouses.length > 0 && warehouses.length > 1

  const preparePurchaseImport = async (file: File) => {
    if (!isAdmin) return
    setBusy(true)
    setNotice(null)
    setImportError('')
    setImportSource('excel')
    setImportPreviewUrl('')
    setImportWarnings([])
    try {
      const { readSheet } = await import('read-excel-file/browser')
      const rows = await readSheet(file)
      const headers = rows[0] ?? []
      const requiredHeaders: Array<[number, string[]]> = [
        [0, ['no']], [1, ['年']], [2, ['産地']], [3, ['品名']], [5, ['数量']], [6, ['単位']],
        [9, ['仕入日時']], [10, ['仕切書no', '仕切り書no']], [12, ['仕入元']],
      ]
      const missing = requiredHeaders.find(([index, accepted]) => !accepted.includes(normalizedExcelHeader(headers[index])))
      if (missing) throw new Error(`Excelの${String.fromCharCode(65 + missing[0])}列「${missing[1][0]}」を確認できません。`)

      const records: PurchaseImportRecord[] = []
      const errors: string[] = []
      const blockedSettlementNos = new Set<string>()
      const detailCounts = new Map<string, number>()
      rows.slice(1).forEach((row, rowIndex) => {
        const sourceRow = rowIndex + 2
        const product = splitSourceProduct(row[3])
        const masterProductName = masterProductByReading.get(productReadingKey(product.productName)) ?? product.productName
        const riceCandidate = Boolean(product.packageType) || knownProductNames.has(masterProductName) || /米|はじき/.test(masterProductName)
        if (!riceCandidate) return

        const settlementNo = excelCellText(row[10])
        const origin = normalizeOrigin(row[2])
        const producerName = excelCellText(row[12])
        const sourceUnit = normalizeSourceUnit(row[6])
        const rawQuantity = Number(row[5])
        const cropYearText = excelCellText(row[1])
        const cropYear = cropYearText ? Number(cropYearText) : null
        const purchasedAt = normalizePurchaseDate(row[9])
        const rowErrors: string[] = []
        if (!settlementNo) rowErrors.push('仕切り書№が空欄')
        if (!originOptions.some((item) => item.name === origin)) rowErrors.push(`産地「${origin || '空欄'}」がマスタにない`)
        if (!producerName) rowErrors.push('仕入元が空欄')
        if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) rowErrors.push('数量が不正')
        if (!['本', '袋', 'kg', '俵'].includes(sourceUnit)) rowErrors.push(`単位「${sourceUnit || '空欄'}」に未対応`)
        if (cropYear !== null && (!Number.isInteger(cropYear) || cropYear < 1900 || cropYear > 2100)) rowErrors.push(`年「${cropYearText}」が不正`)
        if (!purchasedAt) rowErrors.push('仕入日時が不正')
        if (rowErrors.length > 0) {
          errors.push(`${sourceRow}行目：${rowErrors.join('、')}`)
          if (settlementNo) blockedSettlementNos.add(settlementNo)
          return
        }

        const detailNo = (detailCounts.get(settlementNo) ?? 0) + 1
        detailCounts.set(settlementNo, detailNo)
        const grade = otherProductNames.has(masterProductName) ? '対象外' : '未検査'
        const parts: Array<{ quantity: number; unit: string }> = []
        if (product.packageType === 'FL' && sourceUnit === '俵' && (cropYear ?? 0) >= 2026) {
          const fullFlexcons = Math.floor(rawQuantity / 17)
          const remainderBales = rawQuantity % 17
          if (fullFlexcons > 0) parts.push({ quantity: fullFlexcons, unit: '本' })
          if (remainderBales > 0) parts.push({ quantity: remainderBales, unit: '俵' })
        } else if (!product.packageType && sourceUnit === 'kg' && ['くず米', '飼料用玄米', '中米', '中米はじき', '色選はじき'].includes(masterProductName)) {
          const fullWeight = ['くず米', '飼料用玄米'].includes(masterProductName) ? 1000 : 1020
          const fullFlexcons = Math.floor(rawQuantity / fullWeight)
          const remainderKg = rawQuantity % fullWeight
          if (fullFlexcons > 0) parts.push({ quantity: fullFlexcons, unit: '本' })
          if (remainderKg > 0) parts.push({ quantity: remainderKg, unit: 'kg' })
        } else {
          parts.push({ quantity: rawQuantity, unit: sourceUnit })
        }

        parts.forEach((part, partIndex) => records.push({
          settlement_no: settlementNo,
          detail_no: detailNo,
          part_no: partIndex + 1,
          source_import_id: excelCellText(row[0]),
          crop_year: cropYear,
          purchased_at: purchasedAt,
          origin,
          raw_product_name: product.raw,
          product_name: masterProductName,
          producer_name: producerName,
          raw_quantity: rawQuantity,
          raw_unit: sourceUnit,
          grade,
          quantity: part.quantity,
          unit: part.unit,
          purchase_price: null,
        }))
      })

      if (records.length === 0 && errors.length === 0) throw new Error('米穀の取込対象がありません。')
      setImportFileName(file.name)
      setImportRecords(records)
      setImportErrors(errors)
      setImportBlockedSettlementNos([...blockedSettlementNos])
      setImportProductMappings({})
      const defaultWarehouseId = activeWarehouses.length === 1 ? activeWarehouses[0].id : ''
      setImportWarehouseIds(Object.fromEntries([...new Set(records.map((record) => record.settlement_no))].map((settlementNo) => [settlementNo, defaultWarehouseId])))
      setImportOpen(true)
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Excelファイルを読み込めませんでした。' })
    } finally {
      setBusy(false)
      if (importFileRef.current) importFileRef.current.value = ''
    }
  }

  const preparePurchasePhoto = async (file: File) => {
    setBusy(true)
    setNotice(null)
    setImportError('')
    try {
      const image = await resizeStatementPhoto(file)
      const { data, error } = await supabase.functions.invoke('analyze-purchase-statement', {
        body: { imageBase64: image.imageBase64, mimeType: image.mimeType },
      })
      if (error) {
        let message = error.message
        const context = (error as { context?: Response }).context
        if (context) {
          try { message = ((await context.clone().json()) as { error?: string }).error ?? message } catch {}
        }
        throw new Error(message)
      }
      const statement = (data as { statement?: GeminiStatement } | null)?.statement
      if (!statement || !Array.isArray(statement.lines) || statement.lines.length === 0) throw new Error('仕切書の米穀明細を読み取れませんでした。')

      const cropYearNumber = Number(statement.crop_year)
      const cropYear = Number.isInteger(cropYearNumber) && cropYearNumber >= 1900 && cropYearNumber <= 2100 ? cropYearNumber : null
      const purchasedAt = normalizePurchaseDate(statement.purchased_at)
      const origin = normalizeOrigin(statement.origin)
      const purchasePrice = Number(statement.purchase_price)
      const records: PurchaseImportRecord[] = []
      const warnings = [...(statement.warnings ?? [])]
      if (!statement.settlement_no?.trim()) warnings.push('仕切り書№を読み取れませんでした。')
      if (!cropYear) warnings.push('産年を読み取れませんでした。')
      if (!purchasedAt) warnings.push('仕入日を読み取れませんでした。')
      if (!origin) warnings.push('産地を読み取れませんでした。')
      if (!statement.producer_name?.trim()) warnings.push('生産者名を読み取れませんでした。')
      if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) warnings.push('仕入価格を読み取れませんでした。')

      statement.lines.forEach((line, lineIndex) => {
        const packageSuffix = line.package_type === 'FL' ? '(FL)' : line.package_type === '紙袋' ? '(紙袋)' : ''
        const product = splitSourceProduct(`${line.product_name ?? ''}${packageSuffix}`)
        const masterProductName = masterProductByReading.get(productReadingKey(product.productName)) ?? product.productName
        const sourceUnit = normalizeSourceUnit(line.unit)
        const rawQuantity = Number(line.quantity)
        const parts: Array<{ quantity: number; unit: string }> = []
        if (product.packageType === 'FL' && sourceUnit === '俵' && (cropYear ?? 0) >= 2026 && rawQuantity > 0) {
          const fullFlexcons = Math.floor(rawQuantity / 17)
          const remainderBales = rawQuantity % 17
          if (fullFlexcons > 0) parts.push({ quantity: fullFlexcons, unit: '本' })
          if (remainderBales > 0) parts.push({ quantity: remainderBales, unit: '俵' })
        } else if (!product.packageType && sourceUnit === 'kg' && ['くず米', '飼料用玄米', '中米', '中米はじき', '色選はじき'].includes(masterProductName) && rawQuantity > 0) {
          const fullWeight = ['くず米', '飼料用玄米'].includes(masterProductName) ? 1000 : 1020
          const fullFlexcons = Math.floor(rawQuantity / fullWeight)
          const remainderKg = rawQuantity % fullWeight
          if (fullFlexcons > 0) parts.push({ quantity: fullFlexcons, unit: '本' })
          if (remainderKg > 0) parts.push({ quantity: remainderKg, unit: 'kg' })
        } else {
          parts.push({ quantity: Number.isFinite(rawQuantity) ? rawQuantity : 0, unit: sourceUnit || 'kg' })
        }
        parts.forEach((part, partIndex) => records.push({
          settlement_no: statement.settlement_no?.trim() ?? '', detail_no: lineIndex + 1, part_no: partIndex + 1,
          source_import_id: `camera-${lineIndex + 1}`, crop_year: cropYear, purchased_at: purchasedAt,
          origin, raw_product_name: product.raw, product_name: masterProductName, producer_name: statement.producer_name?.trim() ?? '',
          raw_quantity: Number.isFinite(rawQuantity) ? rawQuantity : 0, raw_unit: sourceUnit || 'kg',
          grade: otherProductNames.has(masterProductName) ? '対象外' : '未検査', quantity: part.quantity, unit: part.unit,
          purchase_price: Number.isFinite(purchasePrice) && purchasePrice > 0 ? purchasePrice : null,
        }))
      })

      setImportSource('camera')
      setImportFileName(`仕切書撮影_${new Date().toLocaleString('ja-JP')}.jpg`)
      setImportPreviewUrl(image.previewUrl)
      setImportRecords(records)
      setImportErrors([])
      setImportWarnings([...new Set(warnings.filter(Boolean))])
      setImportBlockedSettlementNos([])
      setImportProductMappings({})
      const defaultWarehouseId = activeWarehouses.length === 1 ? activeWarehouses[0].id : ''
      setImportWarehouseIds(statement.settlement_no ? { [statement.settlement_no]: defaultWarehouseId } : {})
      setImportOpen(true)
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '仕切書画像を解析できませんでした。' })
    } finally {
      setBusy(false)
      if (cameraFileRef.current) cameraFileRef.current.value = ''
    }
  }

  const updateImportCommon = (changes: Partial<Pick<PurchaseImportRecord, 'settlement_no' | 'crop_year' | 'purchased_at' | 'producer_name' | 'origin' | 'purchase_price'>>) => {
    setImportRecords((current) => current.map((record) => ({ ...record, ...changes })))
  }

  const updateImportRecord = (index: number, changes: Partial<PurchaseImportRecord>) => {
    setImportRecords((current) => current.map((record, recordIndex) => recordIndex === index ? { ...record, ...changes } : record))
  }

  const changeCameraSettlementNo = (settlementNo: string) => {
    const previous = importRecords[0]?.settlement_no ?? ''
    updateImportCommon({ settlement_no: settlementNo })
    setImportWarehouseIds((current) => {
      const next = { ...current, [settlementNo]: current[previous] ?? '' }
      if (previous && previous !== settlementNo) delete next[previous]
      return next
    })
  }

  const executePurchaseImport = async () => {
    if (busy || (importSource === 'excel' && !isAdmin)) return
    if (mappedImportRecords.length === 0) return setImportError('取込可能な明細がありません。')
    const invalidRecord = mappedImportRecords.find((record) => !record.settlement_no.trim() || !record.purchased_at || !record.producer_name.trim()
      || !originOptions.some((origin) => origin.name === record.origin) || !Number.isFinite(Number(record.quantity)) || Number(record.quantity) <= 0
      || !['本', '袋', 'kg', '俵'].includes(record.unit))
    if (invalidRecord) return setImportError('仕切書№・仕入日・生産者名・産地・数量・単位を確認してください。')
    if (importSource === 'camera' && (!Number.isFinite(Number(mappedImportRecords[0]?.purchase_price)) || Number(mappedImportRecords[0]?.purchase_price) <= 0)) return setImportError('仕入価格を入力してください。')
    setBusy(true)
    setImportError('')
    const { data, error } = await supabase.rpc('flexcon_import_purchase_statements', {
      p_worker_id: workerId,
      p_file_name: importFileName,
      p_records: mappedImportRecords.map((record) => ({ ...record, to_warehouse_id: importWarehouseIds[record.settlement_no] || null })),
    })
    setBusy(false)
    if (error) return setImportError(error.message)
    const result = data as { settlement_count?: number; line_count?: number } | null
    setImportOpen(false)
    const excludedCount = importErrors.length + (importRecords.length - mappedImportRecords.length)
    setNotice({ type: 'success', text: `仕切り書${result?.settlement_count ?? 0}件、在庫明細${result?.line_count ?? mappedImportRecords.length}行を取り込みました。${excludedCount > 0 ? ` エラー・未対応の${excludedCount}行は除外しました。` : ''}` })
    setVersion((value) => value + 1)
  }

  const validateForm = (target: MovementForm, mode: MovementMode, productNames: string[], grades: InspectionOption[]) => {
    if (!target.movementDate) return '日付を入力してください。'
    if (target.cropYear && (!/^\d{4}$/.test(target.cropYear) || Number(target.cropYear) < 1900 || Number(target.cropYear) > 2100)) return '産年は1900～2100の西暦4桁で入力してください。'
    if (!originOptions.some((item) => item.name === target.origin)) return '産地をマスタから選択してください。'
    if (!productNames.includes(target.productName)) return '名称をマスタから選択してください。'
    if (!otherProductNames.has(target.productName) && !grades.some((item) => item.name === target.grade)) return '等級をマスタから選択してください。'
    const quantity = Number(target.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) return '量は0より大きい数値で入力してください。'
    if (!['本', '袋', 'kg'].includes(target.unit)) return '単位を本・袋・kgから選択してください。'
    if (mode !== 'inbound' && !target.fromWarehouseId) return '移動元の倉庫を選択してください。'
    if (mode !== 'outbound' && !target.toWarehouseId) return '移動先の倉庫を選択してください。'
    if (mode === 'transfer' && target.fromWarehouseId === target.toWarehouseId) return '移動元と移動先には別の倉庫を選択してください。'
    return ''
  }

  const changeMode = (mode: MovementMode) => {
    setMovementMode(mode)
    setForm((current) => ({ ...current, fromWarehouseId: mode === 'inbound' ? '' : current.fromWarehouseId, toWarehouseId: mode === 'outbound' ? '' : current.toWarehouseId }))
    setNotice(null)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || !canOperate) return
    const errorText = validateForm(form, movementMode, addProductNames, addGrades)
    if (errorText) return setNotice({ type: 'error', text: errorText })
    setBusy(true); setNotice(null)
    const { error } = await supabase.rpc('flexcon_add_inventory_movement', {
      p_worker_id: workerId, p_movement_date: form.movementDate, p_crop_year: form.cropYear ? Number(form.cropYear) : null, p_producer_name: '', p_origin: form.origin, p_product_name: form.productName,
      p_grade: otherProductNames.has(form.productName) ? '' : form.grade, p_quantity: Number(form.quantity), p_unit: form.unit,
      p_from_warehouse_id: movementMode === 'inbound' ? null : form.fromWarehouseId,
      p_to_warehouse_id: movementMode === 'outbound' ? null : form.toWarehouseId,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: `${movementMode === 'inbound' ? '入庫' : movementMode === 'outbound' ? '出庫' : '倉庫間移動'}を記録しました。` })
    setForm((current) => ({ ...emptyForm(), movementDate: current.movementDate, cropYear: current.cropYear, origin: current.origin, productName: current.productName, grade: current.grade, unit: current.unit }))
    setVersion((value) => value + 1)
  }

  const beginEdit = (movement: InventoryMovement) => {
    setEditing(movement)
    setEditMode(modeForMovement(movement))
    setEditForm({ movementDate: movement.movement_date, cropYear: movement.crop_year == null ? '' : String(movement.crop_year), origin: movement.origin, productName: movement.product_name, grade: movement.grade, quantity: String(movement.quantity), unit: movement.unit, fromWarehouseId: movement.from_warehouse_id ?? '', toWarehouseId: movement.to_warehouse_id ?? '' })
    setNotice(null)
  }

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing || busy || !canOperate) return
    const errorText = validateForm(editForm, editMode, editProductNames, editGrades)
    if (errorText) return setNotice({ type: 'error', text: errorText })
    setBusy(true); setNotice(null)
    const { error } = await supabase.rpc('flexcon_update_inventory_movement', {
      p_worker_id: workerId, p_movement_id: editing.id, p_movement_date: editForm.movementDate, p_crop_year: editForm.cropYear ? Number(editForm.cropYear) : null, p_origin: editForm.origin,
      p_producer_name: editMode === 'inbound' ? editing.producer_name : '',
      p_product_name: editForm.productName, p_grade: otherProductNames.has(editForm.productName) ? '' : editForm.grade,
      p_quantity: Number(editForm.quantity), p_unit: editForm.unit,
      p_from_warehouse_id: editMode === 'inbound' ? null : editForm.fromWarehouseId,
      p_to_warehouse_id: editMode === 'outbound' ? null : editForm.toWarehouseId,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setEditing(null)
    setNotice({ type: 'success', text: '入出庫記録を更新しました。' })
    setVersion((value) => value + 1)
  }

  const deleteMovement = async (movement: InventoryMovement) => {
    if (busy || !canOperate) return
    const description = `${movement.movement_date.replaceAll('-', '/')} ${movementTypeLabel(movement)} ${movement.origin} ${movement.product_name} ${formatQuantity(movement.quantity)}${movement.unit}`
    if (!window.confirm(`${description}\n\nこの入出庫記録を削除しますか？`)) return
    setBusy(true); setNotice(null)
    const { error } = await supabase.rpc('flexcon_delete_inventory_movement', {
      p_worker_id: workerId,
      p_movement_id: movement.id,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: '入出庫記録を削除しました。' })
    setVersion((value) => value + 1)
  }

  const beginStatementEdit = async (movement: InventoryMovement) => {
    if (busy || !canOperate) return
    setBusy(true); setNotice(null)
    const { data, error } = await supabase.from('flexcon_inventory_ledger').select('*')
      .eq('source_type', 'settlement').eq('settlement_no', movement.settlement_no)
      .order('created_at', { ascending: true }).order('id', { ascending: true })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: '同じ仕切り書の明細を取得できませんでした。' })
    const rows = (data ?? []) as InventoryMovement[]
    if (rows.every((row) => Number.isFinite(Number(row.registration_order)))) {
      rows.sort((left, right) => Number(left.registration_order) - Number(right.registration_order))
    }
    if (rows.length === 0) return setNotice({ type: 'error', text: '同じ仕切り書の明細が見つかりません。' })
    const first = rows[0]
    setStatementEditForm({
      originalSettlementNo: movement.settlement_no,
      movementDate: first.movement_date,
      settlementNo: first.settlement_no,
      producerName: first.producer_name,
      toWarehouseId: first.to_warehouse_id ?? '',
      rows: rows.map((row) => ({ id: row.id, origin: row.origin, productName: row.product_name, quantity: String(row.quantity), unit: row.unit })),
    })
  }

  const updateStatementEditRow = (index: number, changes: Partial<StatementEditRow>) => setStatementEditForm((current) => current ? {
    ...current,
    rows: current.rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...changes } : row),
  } : current)

  const saveStatementEdit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!statementEditForm || busy || !canOperate) return
    if (!statementEditForm.movementDate) return setNotice({ type: 'error', text: '日付を入力してください。' })
    if (!statementEditForm.settlementNo.trim()) return setNotice({ type: 'error', text: '仕切り書№を入力してください。' })
    if (!statementEditForm.producerName.trim()) return setNotice({ type: 'error', text: '生産者名を入力してください。' })
    for (const [index, row] of statementEditForm.rows.entries()) {
      if (!originOptions.some((item) => item.name === row.origin)) return setNotice({ type: 'error', text: `${index + 1}行目の産地をマスタから選択してください。` })
      if (!productNamesFor(row.origin).includes(row.productName)) return setNotice({ type: 'error', text: `${index + 1}行目の名称をマスタから選択してください。` })
      const quantity = Number(row.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) return setNotice({ type: 'error', text: `${index + 1}行目の数量は0より大きい数値で入力してください。` })
      if (!['本', '袋', 'kg', '俵'].includes(row.unit)) return setNotice({ type: 'error', text: `${index + 1}行目の単位を選択してください。` })
    }
    setBusy(true); setNotice(null)
    const { data, error } = await supabase.rpc('flexcon_bulk_update_purchase_statement', {
      p_worker_id: workerId,
      p_original_settlement_no: statementEditForm.originalSettlementNo,
      p_movement_date: statementEditForm.movementDate,
      p_settlement_no: statementEditForm.settlementNo.trim(),
      p_producer_name: statementEditForm.producerName.trim(),
      p_to_warehouse_id: statementEditForm.toWarehouseId || null,
      p_lines: statementEditForm.rows.map((row) => ({ id: row.id, origin: row.origin, product_name: row.productName, quantity: Number(row.quantity), unit: row.unit })),
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    const result = data as { updated_count?: number } | null
    setStatementEditForm(null)
    setNotice({ type: 'success', text: `仕切り書の在庫明細を${result?.updated_count ?? statementEditForm.rows.length}行まとめて更新しました。` })
    setVersion((value) => value + 1)
  }

  const deleteStatementLine = async (movement: InventoryMovement) => {
    if (busy || !canOperate) return
    const description = `仕切り書№${movement.settlement_no} ${movement.producer_name} ${movement.product_name} ${formatQuantity(movement.quantity)}${movement.unit}`
    if (!window.confirm(`${description}\n\nこの取込明細を削除しますか？`)) return
    setBusy(true); setNotice(null)
    const { error } = await supabase.rpc('flexcon_delete_purchase_statement_line', { p_worker_id: workerId, p_line_id: movement.id })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: '仕切り書の在庫明細を削除しました。' })
    setVersion((value) => value + 1)
  }

  const listMovements = useMemo(() => view === 'statement-list' ? movements.filter((movement) => movement.source_type === 'settlement') : movements, [movements, view])
  const visibleInventoryColumns = useMemo(() => view === 'statement-list' ? INVENTORY_COLUMNS : INVENTORY_COLUMNS.filter((column) => column.key !== 'settlementNo' && column.key !== 'producerName'), [view])
  const filterValues = useMemo(() => Object.fromEntries(visibleInventoryColumns.map((column) => [column.key, [...new Set(listMovements.map((movement) => movementValue(movement, column.key)))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }))])) as Record<InventoryColumn, string[]>, [listMovements, visibleInventoryColumns])
  const displayedMovements = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = listMovements.filter((movement) => {
      if (term && !visibleInventoryColumns.some((column) => movementValue(movement, column.key).toLowerCase().includes(term))) return false
      return visibleInventoryColumns.every((column) => columnFilters[column.key] === undefined || columnFilters[column.key]!.includes(movementValue(movement, column.key)))
    })
    if (!sort) return rows
    return [...rows].sort((left, right) => {
      const leftValue = sort.key === 'quantity' ? Number(left.quantity) : sort.key === 'movementDate' ? new Date(left.movement_date).getTime() : movementValue(left, sort.key)
      const rightValue = sort.key === 'quantity' ? Number(right.quantity) : sort.key === 'movementDate' ? new Date(right.movement_date).getTime() : movementValue(right, sort.key)
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number' ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue), 'ja', { numeric: true })
      return sort.direction === 'asc' ? comparison : -comparison
    })
  }, [columnFilters, listMovements, search, sort, visibleInventoryColumns])

  const deletableMovements = listMovements.filter((movement) => movement.source_type === 'manual' || movement.source_type === 'settlement')
  const selectedMovements = deletableMovements.filter((movement) => selectedMovementKeys.has(movementSelectionKey(movement)))
  const displayedMovementKeys = displayedMovements.filter((movement) => movement.source_type === 'manual' || movement.source_type === 'settlement').map(movementSelectionKey)
  const allDisplayedMovementsSelected = displayedMovementKeys.length > 0 && displayedMovementKeys.every((key) => selectedMovementKeys.has(key))
  const toggleDisplayedMovements = () => setSelectedMovementKeys((current) => {
    const next = new Set(current)
    if (allDisplayedMovementsSelected) displayedMovementKeys.forEach((key) => next.delete(key))
    else displayedMovementKeys.forEach((key) => next.add(key))
    return next
  })
  const toggleMovement = (movement: InventoryMovement) => setSelectedMovementKeys((current) => {
    const next = new Set(current)
    const key = movementSelectionKey(movement)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const bulkDeleteMovements = async () => {
    if (!isAdmin || busy || selectedMovements.length === 0) return
    if (!window.confirm(`選択した在庫記録 ${selectedMovements.length}件を一括削除しますか？\n\nこの操作は元に戻せません。`)) return
    setBusy(true); setNotice(null)
    const { data, error } = await supabase.rpc('flexcon_bulk_delete_inventory_records', {
      p_worker_id: workerId,
      p_records: selectedMovements.map((movement) => ({ source_type: movement.source_type, id: movement.id })),
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    const result = data as { deleted_count?: number } | null
    setSelectedMovementKeys(new Set())
    setNotice({ type: 'success', text: `在庫記録を${result?.deleted_count ?? selectedMovements.length}件削除しました。` })
    setVersion((value) => value + 1)
  }

  const changeSort = (key: InventoryColumn) => setSort((current) => !current || current.key !== key ? { key, direction: 'asc' } : current.direction === 'asc' ? { key, direction: 'desc' } : null)
  const changeColumnFilter = (key: InventoryColumn, values: string[] | undefined) => setColumnFilters((current) => {
    const next = { ...current }
    if (values === undefined) delete next[key]
    else next[key] = values
    return next
  })
  const changeBalanceColumnFilter = (key: string, values: string[] | undefined) => setBalanceColumnFilters((current) => {
    const next = { ...current }
    if (values === undefined) delete next[key]
    else next[key] = values
    return next
  })
  const renderMovementFields = (target: MovementForm, setTarget: React.Dispatch<React.SetStateAction<MovementForm>>, mode: MovementMode, productNames: string[], grades: InspectionOption[]) => {
    const otherProduct = otherProductNames.has(target.productName)
    const selectableToWarehouses = editing ? warehouses.filter((warehouse) => warehouse.active || warehouse.id === target.toWarehouseId) : activeWarehouses
    return <>
      <label className="inventory-field-date">日付{weekdayLabel(target.movementDate)}<input type="date" value={target.movementDate} onChange={(e) => setTarget((current) => ({ ...current, movementDate: e.target.value }))} required /></label>
      <label className="inventory-field-year">産年<input type="number" min="1900" max="2100" step="1" inputMode="numeric" placeholder="西暦" value={target.cropYear} onChange={(e) => setTarget((current) => ({ ...current, cropYear: e.target.value }))} /></label>
      <label className="inventory-field-worker">作業者<input value={editing?.worker_name ?? workerName} readOnly /></label>
      <label className="inventory-field-origin">産地<select value={target.origin} onChange={(e) => setTarget((current) => ({ ...current, origin: e.target.value, productName: '', grade: '' }))} required><option value="">選択</option>{originOptions.map((origin) => <option key={origin.id} value={origin.name}>{origin.name}</option>)}</select></label>
      <label className="inventory-field-product">名称<select value={target.productName} onChange={(e) => setTarget((current) => ({ ...current, productName: e.target.value, grade: '' }))} disabled={!target.origin} required><option value="">{target.origin ? '選択' : '先に産地を選択'}</option>{productNames.map((product) => <option key={product} value={product}>{product}</option>)}</select></label>
      <label className="inventory-field-grade">等級<select value={otherProduct ? '' : target.grade} onChange={(e) => setTarget((current) => ({ ...current, grade: e.target.value }))} disabled={!target.productName || otherProduct} required={!otherProduct}><option value="">{otherProduct ? '対象外' : target.productName ? '選択' : '先に名称を選択'}</option>{grades.map((grade) => <option key={grade.id} value={grade.name}>{grade.name}</option>)}</select></label>
      <label className="inventory-field-quantity">数量<input type="number" min="0.001" step="1" inputMode="decimal" value={target.quantity} onChange={(e) => setTarget((current) => ({ ...current, quantity: e.target.value }))} required /></label>
      <label className="inventory-field-unit">単位<select value={target.unit} onChange={(e) => setTarget((current) => ({ ...current, unit: e.target.value }))} required><option value="本">本</option><option value="袋">袋</option><option value="kg">kg</option></select></label>
      <label className="inventory-field-from">移動元{mode === 'inbound' ? <input value="外部" readOnly /> : <select value={target.fromWarehouseId} onChange={(e) => setTarget((current) => ({ ...current, fromWarehouseId: e.target.value }))} required><option value="">未選択</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}{warehouse.active ? '' : '（無効）'}</option>)}</select>}</label>
      <label className="inventory-field-to">移動先{mode === 'outbound' ? <input value="外部" readOnly /> : <select value={target.toWarehouseId} onChange={(e) => setTarget((current) => ({ ...current, toWarehouseId: e.target.value }))} required><option value="">未選択</option>{selectableToWarehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}{warehouse.active ? '' : '（無効）'}</option>)}</select>}</label>
    </>
  }

  return <div className={`inventory-page ${view === 'balance' ? 'inventory-page-balance' : ''}`}>
    <div className="page-heading"><h1>{view === 'history' ? '入出庫記録' : view === 'statement-reader' ? '仕切書読込み' : view === 'statement-list' ? '仕切書一覧' : '在庫'}</h1><p>{view === 'history' ? '検査対象のお米は【検査記録】から登録して下さい。' : view === 'statement-reader' ? '仕切書を撮影し、米穀明細と仕入価格を読み取って登録します。' : view === 'statement-list' ? '撮影して登録した仕切書の明細を確認・編集します。' : '倉庫ごとの現在庫を産地、名称、等級別に表示します。'}</p></div>
    {view === 'history' && canOperate && <section className="section-band inventory-entry-section">
      <div className="inventory-entry-toolbar">
        <div className="inventory-mode-switch" role="group" aria-label="移動区分">
          <button type="button" className={movementMode === 'inbound' ? 'active' : ''} onClick={() => changeMode('inbound')}><ArrowDownToLine size={18} />入庫</button>
          <button type="button" className={movementMode === 'outbound' ? 'active' : ''} onClick={() => changeMode('outbound')}><ArrowUpFromLine size={18} />出庫</button>
          <button type="button" className={movementMode === 'transfer' ? 'active' : ''} onClick={() => changeMode('transfer')}><ArrowRightLeft size={18} />倉庫間移動</button>
        </div>
        {isAdmin && <div className="inventory-import-actions">
          <input ref={importFileRef} className="visually-hidden" type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12" onChange={(event) => { const file = event.target.files?.[0]; if (file) void preparePurchaseImport(file) }} />
          <button className="secondary-button" type="button" onClick={() => importFileRef.current?.click()} disabled={busy}><FileUp size={18} />仕切り書Excel取込</button>
        </div>}
      </div>
      <form className="inventory-entry-form" noValidate onSubmit={(event) => void submit(event)}>{renderMovementFields(form, setForm, movementMode, addProductNames, addGrades)}<button className="primary-button" type="submit" disabled={busy || !warehouseRouteAvailable}><Plus size={18} />{busy ? '登録中...' : '記録を追加'}</button></form>
    </section>}
    {view === 'statement-reader' && canOperate && <section className="section-band statement-reader-section">
      <input ref={cameraFileRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={(event) => { const file = event.target.files?.[0]; if (file) void preparePurchasePhoto(file) }} />
      <div className="statement-reader-callout"><span className="statement-reader-icon"><Camera size={36} /></span><div><h2>仕切書を撮影</h2><p>スマートフォンではカメラが開きます。パソコンでは保存済みの画像を選択できます。</p></div></div>
      <button className="primary-button statement-reader-button" type="button" onClick={() => cameraFileRef.current?.click()} disabled={busy}><Camera size={20} />{busy ? '読取中...' : '撮影・画像を選択'}</button>
    </section>}
    {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    {view === 'history' || view === 'statement-list' ? <>
      <div className="search-row inventory-search-row">
        <div className="search-input-wrap"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={view === 'statement-list' ? '仕切書を検索' : '入出庫記録を検索'} /></div>
        {isAdmin && <button className="danger-button inventory-bulk-delete-button" type="button" disabled={busy || selectedMovements.length === 0} onClick={() => void bulkDeleteMovements()}><Trash2 size={17} />選択した{selectedMovements.length}件を削除</button>}
      </div>
      <div className="inventory-table-wrap"><table className={`inventory-table inventory-history-table ${view === 'history' ? 'without-producer' : ''} ${isAdmin ? 'with-selection' : ''}`}>
        <thead><tr>{isAdmin && <th className="inventory-selection-heading"><input type="checkbox" checked={allDisplayedMovementsSelected} onChange={toggleDisplayedMovements} aria-label="表示中の在庫記録をすべて選択" title="表示中をすべて選択" /></th>}{visibleInventoryColumns.map((column) => <FilterableColumnHeader key={column.key} column={column} sort={sort} values={filterValues[column.key]} selectedValues={columnFilters[column.key]} onSort={changeSort} onFilterChange={changeColumnFilter} openRight={column.key === 'movementDate'} />)}{canOperate && <th className="inventory-actions-heading">操作</th>}</tr></thead>
        <tbody>{displayedMovements.map((movement) => {
          const mode = modeForMovement(movement)
          const manual = movement.source_type === 'manual'
          const statement = movement.source_type === 'settlement'
          const editable = manual || statement
          const routeError = statement && !movement.to_warehouse_id
          const selected = selectedMovementKeys.has(movementSelectionKey(movement))
          return <tr className={`inventory-movement-${mode} ${routeError ? 'inventory-movement-error' : ''} ${selected ? 'inventory-movement-selected' : ''}`} title={routeError ? 'エラー：移動先が未指定です' : undefined} key={movement.id}>
            {isAdmin && <td className="inventory-selection-cell">{editable && <input type="checkbox" checked={selected} onChange={() => toggleMovement(movement)} aria-label={`${movement.movement_date} ${movement.product_name}を選択`} />}</td>}
            <td>{movementValue(movement, 'movementDate')}</td><td className="numeric-cell">{movementValue(movement, 'cropYear')}</td><td><span className={`inventory-movement-badge ${movementBadgeClass(movement)}`}>{mode === 'inbound' ? <ArrowDownToLine size={14} /> : mode === 'outbound' ? <ArrowUpFromLine size={14} /> : <ArrowRightLeft size={14} />}{movementTypeLabel(movement)}</span></td>{view === 'statement-list' && <td>{movement.settlement_no}</td>}<td>{movement.worker_name}</td>{view === 'statement-list' && <td>{movement.producer_name}</td>}<td>{movement.origin}</td><td>{movement.product_name}</td><td>{movementValue(movement, 'grade')}</td><td className="numeric-cell">{formatQuantity(movement.quantity)}</td><td>{movement.unit}</td><td className="numeric-cell">{movementValue(movement, 'purchasePrice')}</td><td>{movement.movement_from}</td><td className={routeError ? 'inventory-route-error' : ''}>{routeError ? <span><AlertTriangle size={16} />移動先未指定</span> : movement.movement_to}</td>{canOperate && <td className="inventory-actions-cell">{editable && <div className="inventory-row-actions"><button className="icon-button" type="button" title={manual ? '入出庫記録を編集' : '仕切り書をまとめて編集'} aria-label={manual ? '入出庫記録を編集' : '仕切り書をまとめて編集'} disabled={busy} onClick={() => { if (manual) beginEdit(movement); else void beginStatementEdit(movement) }}><Pencil size={17} /></button><button className="icon-button delete-icon" type="button" title={manual ? '入出庫記録を削除' : '仕切り書明細を削除'} aria-label={manual ? '入出庫記録を削除' : '仕切り書明細を削除'} disabled={busy} onClick={() => manual ? void deleteMovement(movement) : void deleteStatementLine(movement)}><Trash2 size={17} /></button></div>}</td>}
          </tr>
        })}{displayedMovements.length === 0 && <tr><td className="empty-state" colSpan={visibleInventoryColumns.length + (canOperate ? 1 : 0) + (isAdmin ? 1 : 0)}>{view === 'statement-list' ? '登録された仕切書はありません' : '該当する入出庫記録はありません'}</td></tr>}</tbody>
      </table></div>
    </> : view === 'balance' ? <><div className="search-row inventory-search-row"><div className="search-input-wrap"><Search size={18} /><input value={balanceSearch} onChange={(event) => setBalanceSearch(event.target.value)} placeholder="在庫を検索" /></div></div><div className="inventory-subheading"><h2>倉庫別一覧</h2><span>{displayedBalanceRows.length}件</span></div><div className="inventory-table-wrap"><table className="inventory-table inventory-balance-table" style={{ '--inventory-balance-mobile-width': `${358 + balanceGradeColumns.length * 62}px` } as React.CSSProperties}><colgroup><col className="inventory-balance-warehouse-col" /><col className="inventory-balance-origin-col" /><col className="inventory-balance-product-col" /><col className="inventory-balance-unit-col" />{balanceGradeColumns.map((grade) => <col className="inventory-balance-grade-col" key={grade} />)}</colgroup><thead><tr>{balanceColumns.map((column, index) => <FilterableColumnHeader key={column.key} column={column} values={balanceFilterValues[column.key]} selectedValues={balanceColumnFilters[column.key]} onFilterChange={changeBalanceColumnFilter} openRight={index === 0} />)}</tr></thead><tbody>{displayedBalanceRows.length > 0 && <tr className="inventory-balance-total"><td><span className="warehouse-name"><Warehouse size={17} />{balanceIsFiltered ? '絞り込み合計' : '全倉庫合計'}</span></td><td>{balanceIsFiltered ? '表示中' : '全産地'}</td><td>{balanceIsFiltered ? '表示中' : '全名称'}</td><td>単位別</td>{balanceGradeColumns.map((grade) => { const totals = balanceTotals[grade] ?? {}; const values = ['本', '袋', 'kg', '俵'].filter((unit) => totals[unit]).map((unit) => `${formatQuantity(totals[unit])}${unit}`); const negative = Object.values(totals).some((quantity) => quantity < 0); return <td className={`numeric-cell inventory-balance-grade ${negative ? 'inventory-negative' : ''}`} key={grade}>{values.join(' / ')}</td> })}</tr>}{displayedBalanceRows.map((row) => <tr key={`${row.warehouseId}-${row.origin}-${row.productName}-${row.unit}`}><td><span className="warehouse-name"><Warehouse size={17} />{row.warehouseName}</span></td><td>{row.origin}</td><td>{row.productName}</td><td>{row.unit}</td>{balanceGradeColumns.map((grade) => { const quantity = row.quantities[grade] ?? 0; return <td className={`numeric-cell inventory-balance-grade ${quantity < 0 ? 'inventory-negative' : ''}`} key={grade}>{quantity === 0 ? '' : formatQuantity(quantity)}</td> })}</tr>)}{displayedBalanceRows.length === 0 && <tr><td className="empty-state" colSpan={balanceColumns.length}>該当する倉庫在庫はありません</td></tr>}</tbody></table></div><section className="inventory-unassigned-section"><div className="inventory-subheading"><h2>倉庫未設定</h2><span>{displayedUnassignedBalanceRows.length}件</span></div><div className="inventory-table-wrap"><table className="inventory-table inventory-balance-table inventory-unassigned-table" style={{ '--inventory-balance-mobile-width': `${246 + balanceGradeColumns.length * 62}px` } as React.CSSProperties}><colgroup><col className="inventory-balance-origin-col" /><col className="inventory-balance-product-col" /><col className="inventory-balance-unit-col" />{balanceGradeColumns.map((grade) => <col className="inventory-balance-grade-col" key={grade} />)}</colgroup><thead><tr><th>産地</th><th>名称</th><th>単位</th>{balanceGradeColumns.map((grade) => <th key={grade}>{grade}</th>)}</tr></thead><tbody>{displayedUnassignedBalanceRows.map((row) => <tr key={`${row.origin}-${row.productName}-${row.unit}`}><td>{row.origin}</td><td>{row.productName}</td><td>{row.unit}</td>{balanceGradeColumns.map((grade) => { const quantity = row.quantities[grade] ?? 0; return <td className={`numeric-cell inventory-balance-grade ${quantity < 0 ? 'inventory-negative' : ''}`} key={grade}>{quantity === 0 ? '' : formatQuantity(quantity)}</td> })}</tr>)}{displayedUnassignedBalanceRows.length === 0 && <tr><td className="empty-state" colSpan={3 + balanceGradeColumns.length}>倉庫未設定の在庫はありません</td></tr>}</tbody></table></div></section></> : null}
    {editing && <div className="modal-backdrop" role="presentation"><section className="registration-modal inventory-edit-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-edit-title">
      <div className="modal-header"><div><h2 id="inventory-edit-title">入出庫記録を編集</h2><p>登録時の作業者：{editing.worker_name}</p></div><button className="icon-button" type="button" title="閉じる" aria-label="編集画面を閉じる" onClick={() => setEditing(null)} disabled={busy}><X size={20} /></button></div>
      {notice?.type === 'error' && <div className="notice error" role="alert">{notice.text}</div>}
      <div className="inventory-mode-switch" role="group" aria-label="移動区分">{(['inbound', 'outbound', 'transfer'] as MovementMode[]).map((mode) => <button key={mode} type="button" className={editMode === mode ? 'active' : ''} onClick={() => { setEditMode(mode); setEditForm((current) => ({ ...current, fromWarehouseId: mode === 'inbound' ? '' : current.fromWarehouseId, toWarehouseId: mode === 'outbound' ? '' : current.toWarehouseId })) }}>{mode === 'inbound' ? '入庫' : mode === 'outbound' ? '出庫' : '倉庫間移動'}</button>)}</div>
      <form className="form-grid inventory-edit-form" noValidate onSubmit={(event) => void saveEdit(event)}>{renderMovementFields(editForm, setEditForm, editMode, editProductNames, editGrades)}<div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setEditing(null)} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : '変更を保存'}</button></div></form>
    </section></div>}
    {statementEditForm && <div className="modal-backdrop" role="presentation"><section className="registration-modal inventory-statement-edit-modal" role="dialog" aria-modal="true" aria-labelledby="statement-edit-title">
      <div className="modal-header"><div><h2 id="statement-edit-title">仕切り書をまとめて編集</h2><p>明細 {statementEditForm.rows.length}行</p></div><button className="icon-button" type="button" title="閉じる" aria-label="編集画面を閉じる" onClick={() => setStatementEditForm(null)} disabled={busy}><X size={20} /></button></div>
      {notice?.type === 'error' && <div className="notice error" role="alert">{notice.text}</div>}
      <form className="inventory-statement-edit-form" noValidate onSubmit={(event) => void saveStatementEdit(event)}>
        <div className="inventory-statement-common-fields">
          <label>日付<input type="date" value={statementEditForm.movementDate} onChange={(event) => setStatementEditForm((current) => current ? { ...current, movementDate: event.target.value } : current)} required /></label>
          <label>仕切り書№<input value={statementEditForm.settlementNo} maxLength={80} onChange={(event) => setStatementEditForm((current) => current ? { ...current, settlementNo: event.target.value } : current)} required /></label>
          <label>生産者名<input value={statementEditForm.producerName} maxLength={120} onChange={(event) => setStatementEditForm((current) => current ? { ...current, producerName: event.target.value } : current)} required /></label>
          <label>入庫先倉庫<select value={statementEditForm.toWarehouseId} onChange={(event) => setStatementEditForm((current) => current ? { ...current, toWarehouseId: event.target.value } : current)}><option value="">未指定</option>{warehouses.filter((warehouse) => warehouse.active || warehouse.id === statementEditForm.toWarehouseId).map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}{warehouse.active ? '' : '（無効）'}</option>)}</select></label>
        </div>
        <div className="inventory-statement-lines-wrap"><table className="inventory-statement-lines"><thead><tr><th>行</th><th>産地</th><th>名称</th><th>数量</th><th>単位</th></tr></thead><tbody>{statementEditForm.rows.map((row, index) => <tr key={row.id}>
          <td data-label="明細">{index + 1}</td>
          <td data-label="産地"><select value={row.origin} onChange={(event) => updateStatementEditRow(index, { origin: event.target.value, productName: '' })} required><option value="">選択</option>{originOptions.map((origin) => <option key={origin.id} value={origin.name}>{origin.name}</option>)}</select></td>
          <td data-label="名称"><select value={row.productName} onChange={(event) => updateStatementEditRow(index, { productName: event.target.value })} required><option value="">選択</option>{productNamesFor(row.origin).map((product) => <option key={product} value={product}>{product}</option>)}</select></td>
          <td data-label="数量"><input type="number" min="0.001" step="1" inputMode="decimal" value={row.quantity} onChange={(event) => updateStatementEditRow(index, { quantity: event.target.value })} required /></td>
          <td data-label="単位"><select value={row.unit} onChange={(event) => updateStatementEditRow(index, { unit: event.target.value })} required><option value="本">本</option><option value="袋">袋</option><option value="kg">kg</option><option value="俵">俵</option></select></td>
        </tr>)}</tbody></table></div>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setStatementEditForm(null)} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : `${statementEditForm.rows.length}行を保存`}</button></div>
      </form>
    </section></div>}
    {importOpen && <div className="modal-backdrop" role="presentation"><section className="registration-modal inventory-import-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-import-title">
      <div className="modal-header"><div><h2 id="inventory-import-title">{importSource === 'camera' ? '仕切書撮影取込' : '仕切り書Excel取込'}</h2><p>{importFileName}</p></div><button className="icon-button" type="button" title="閉じる" aria-label="取込画面を閉じる" onClick={() => setImportOpen(false)} disabled={busy}><X size={20} /></button></div>
      {importError && <div className="notice error" role="alert">{importError}</div>}
      <div className="import-summary"><strong>{importSettlements.length}件</strong><span>仕切り書／取込対象 {mappedImportRecords.length}行</span></div>
      <p className="import-note">入庫先は未指定のまま取込可能です。同じ仕切り書№は今回の内容で差し替えます。</p>
      {importSource === 'camera' && importRecords[0] && <div className="inventory-camera-result">
        {importPreviewUrl && <img src={importPreviewUrl} alt="撮影した仕切書" />}
        <div className="inventory-camera-common-fields">
          <label>仕切り書№<input value={importRecords[0].settlement_no} maxLength={80} onChange={(event) => changeCameraSettlementNo(event.target.value)} /></label>
          <label>産年<input type="number" min="1900" max="2100" step="1" value={importRecords[0].crop_year ?? ''} onChange={(event) => updateImportCommon({ crop_year: event.target.value ? Number(event.target.value) : null })} /></label>
          <label>仕入日<input type="date" value={importRecords[0].purchased_at.slice(0, 10)} onChange={(event) => updateImportCommon({ purchased_at: event.target.value ? `${event.target.value}T00:00:00+09:00` : '' })} /></label>
          <label>生産者名<input value={importRecords[0].producer_name} maxLength={120} onChange={(event) => updateImportCommon({ producer_name: event.target.value })} /></label>
          <label>産地<select value={importRecords[0].origin} onChange={(event) => updateImportCommon({ origin: event.target.value })}><option value="">選択</option>{originOptions.map((origin) => <option key={origin.id} value={origin.name}>{origin.name}</option>)}</select></label>
          <label>仕入価格（合計・円）<input type="number" min="0" step="1" inputMode="decimal" value={importRecords[0].purchase_price ?? ''} onChange={(event) => updateImportCommon({ purchase_price: event.target.value ? Number(event.target.value) : null })} /></label>
        </div>
      </div>}
      {importWarnings.length > 0 && <div className="inventory-import-warnings"><div><AlertTriangle size={20} /><strong>読取結果を確認してください</strong></div>{importWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
      {importErrors.length > 0 && <div className="inventory-import-errors" role="alert"><div className="inventory-import-error-heading"><AlertTriangle size={24} /><strong>取込できない行があります（{importErrors.length}行）</strong></div><b>該当する仕切り書№は除外し、正常な仕切り書だけ取り込みます。</b>{importErrors.slice(0, 20).map((error) => <span key={error}>{error}</span>)}{importErrors.length > 20 && <span>ほか {importErrors.length - 20}件</span>}</div>}
      {unmappedImportProducts.length > 0 && <div className="inventory-import-mappings"><strong>名称の対応を選択（選択しない名称は除外）</strong>{unmappedImportProducts.map((sourceName) => <label key={sourceName}><span>{sourceName}</span><select value={importProductMappings[sourceName] ?? ''} onChange={(event) => setImportProductMappings((current) => ({ ...current, [sourceName]: event.target.value }))}><option value="">取込から除外</option>{productOptions.filter((item) => ['brand', 'brand_aomori', 'brand_iwate', 'shipment_product'].includes(item.option_type)).map((item) => <option key={`${item.option_type}-${item.id}`} value={item.name}>{item.name}</option>)}</select></label>)}</div>}
      {importSettlements.length > 0 && <div className="inventory-import-warehouses"><strong>仕切り書№ごとの入庫先</strong><div className="inventory-import-warehouse-list">{importSettlements.map((settlement) => <label key={settlement.settlementNo}><span><b>{settlement.settlementNo}</b><small>{settlement.producerName}　{settlement.purchaseDate.replaceAll('-', '/')}　{settlement.lineCount}行</small></span><select value={importWarehouseIds[settlement.settlementNo] ?? ''} onChange={(event) => setImportWarehouseIds((current) => ({ ...current, [settlement.settlementNo]: event.target.value }))}><option value="">未指定で取込</option>{activeWarehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></label>)}</div></div>}
      {importSource === 'camera' ? <div className="import-preview inventory-import-preview inventory-camera-lines"><table><thead><tr><th>行</th><th>名称</th><th>数量</th><th>単位</th><th>仕入価格</th></tr></thead><tbody>{importRecords.map((record, index) => <tr key={`${record.detail_no}-${record.part_no}-${index}`}><td data-label="明細">{index + 1}</td><td data-label="名称"><select value={record.product_name} onChange={(event) => { const productName = event.target.value; updateImportRecord(index, { product_name: productName, grade: otherProductNames.has(productName) ? '対象外' : '未検査' }) }}><option value="">選択</option>{!knownProductNames.has(record.product_name) && record.product_name && <option value={record.product_name}>{record.product_name}（未登録）</option>}{productNamesFor(record.origin).map((product) => <option key={product} value={product}>{product}</option>)}</select></td><td data-label="数量"><input type="number" min="0.001" step="1" inputMode="decimal" value={record.quantity} onChange={(event) => updateImportRecord(index, { quantity: Number(event.target.value), raw_quantity: Number(event.target.value) })} /></td><td data-label="単位"><select value={record.unit} onChange={(event) => updateImportRecord(index, { unit: event.target.value, raw_unit: event.target.value })}><option value="本">本</option><option value="袋">袋</option><option value="kg">kg</option><option value="俵">俵</option></select></td><td data-label="仕入価格" className="numeric-cell">{record.purchase_price == null ? '' : `${record.purchase_price.toLocaleString('ja-JP')}円`}</td></tr>)}</tbody></table></div> : <div className="import-preview inventory-import-preview"><table><thead><tr><th>仕切り書№</th><th>日付</th><th>生産者名</th><th>産地</th><th>名称</th><th>元数量</th><th>在庫数量</th></tr></thead><tbody>{mappedImportRecords.slice(0, 30).map((record) => <tr key={`${record.settlement_no}-${record.detail_no}-${record.part_no}`}><td>{record.settlement_no}</td><td>{record.purchased_at.slice(0, 10).replaceAll('-', '/')}</td><td>{record.producer_name}</td><td>{record.origin}</td><td>{record.product_name}</td><td className="numeric-cell">{formatQuantity(record.raw_quantity)}{record.raw_unit}</td><td className="numeric-cell">{formatQuantity(record.quantity)}{record.unit}</td></tr>)}</tbody></table></div>}
      {mappedImportRecords.length > 30 && <p className="import-preview-more">ほか {mappedImportRecords.length - 30}行</p>}
      <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setImportOpen(false)} disabled={busy}>取消</button><button className="primary-button" type="button" onClick={() => void executePurchaseImport()} disabled={busy || mappedImportRecords.length === 0}><FileUp size={18} />{busy ? '取込中...' : '確認した明細を取り込む'}</button></div>
    </section></div>}
  </div>
}
