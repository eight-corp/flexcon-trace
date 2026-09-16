import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowRightLeft, ArrowUp, ArrowUpFromLine, Boxes, FileUp, Filter, List, Pencil, Plus, Save, Search, Trash2, Warehouse, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { InspectionOption } from '../types'

type Props = { workerId: string; workerName: string; canOperate: boolean }
type MovementMode = 'inbound' | 'outbound' | 'transfer'
type InventoryMovementType = MovementMode | 'settlement'
type ViewMode = 'history' | 'balance'
type SortDirection = 'asc' | 'desc'
type InventoryColumn = 'movementDate' | 'movementType' | 'settlementNo' | 'workerName' | 'producerName' | 'origin' | 'productName' | 'grade' | 'quantity' | 'unit' | 'movementFrom' | 'movementTo'
type InventoryMovement = {
  id: string
  source_type: 'manual' | 'settlement'
  movement_type: InventoryMovementType
  movement_date: string
  worker_name: string
  producer_name: string
  settlement_no: string
  origin: string
  product_name: string
  grade: string
  quantity: number
  unit: string
  from_warehouse_id: string | null
  to_warehouse_id: string | null
  movement_from: string
  movement_to: string
}
type InventoryBalance = { warehouse_id: string; warehouse_name: string; origin: string; product_name: string; grade: string; quantity: number; unit: string }
type InventoryBalanceRow = { warehouseId: string; warehouseName: string; origin: string; productName: string; unit: string; quantities: Record<string, number> }
type MovementForm = { movementDate: string; producerName: string; origin: string; productName: string; grade: string; quantity: string; unit: string; fromWarehouseId: string; toWarehouseId: string }
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
}

const INVENTORY_COLUMNS: Array<{ key: InventoryColumn; label: string }> = [
  { key: 'movementDate', label: '日付' },
  { key: 'movementType', label: '区分' },
  { key: 'settlementNo', label: '仕切り書№' },
  { key: 'workerName', label: '作業者名' },
  { key: 'producerName', label: '生産者名' },
  { key: 'origin', label: '産地' },
  { key: 'productName', label: '名称' },
  { key: 'grade', label: '等級' },
  { key: 'quantity', label: '量' },
  { key: 'unit', label: '単位' },
  { key: 'movementFrom', label: '移動元' },
  { key: 'movementTo', label: '移動先' },
]

function today() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}

function emptyForm(): MovementForm {
  return { movementDate: today(), producerName: '', origin: '', productName: '', grade: '', quantity: '', unit: 'kg', fromWarehouseId: '', toWarehouseId: '' }
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
  const mode = modeForMovement(movement)
  return mode === 'inbound' ? '入庫' : mode === 'outbound' ? '出庫' : '倉庫間移動'
}

function movementBadgeClass(movement: InventoryMovement) {
  if (movement.movement_type === 'settlement') return 'settlement'
  return modeForMovement(movement)
}

function movementValue(movement: InventoryMovement, key: InventoryColumn) {
  if (key === 'movementDate') return movement.movement_date.replaceAll('-', '/')
  if (key === 'movementType') return movementTypeLabel(movement)
  if (key === 'settlementNo') return movement.settlement_no
  if (key === 'workerName') return movement.worker_name
  if (key === 'producerName') return movement.producer_name
  if (key === 'productName') return movement.product_name
  if (key === 'quantity') return formatQuantity(movement.quantity)
  if (key === 'movementFrom') return movement.movement_from
  if (key === 'movementTo') return movement.movement_to
  if (key === 'grade') return movement.grade || '対象外'
  return movement[key]
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

export function InventoryManager({ workerId, workerName, canOperate }: Props) {
  const [movementMode, setMovementMode] = useState<MovementMode>('inbound')
  const [viewMode, setViewMode] = useState<ViewMode>('history')
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
  const [importOpen, setImportOpen] = useState(false)
  const [importFileName, setImportFileName] = useState('')
  const [importWarehouseId, setImportWarehouseId] = useState('')
  const [importRecords, setImportRecords] = useState<PurchaseImportRecord[]>([])
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [importError, setImportError] = useState('')
  const [importProductMappings, setImportProductMappings] = useState<Record<string, string>>({})

  useEffect(() => {
    void Promise.all([
      supabase.from('flexcon_inspection_options').select('*').eq('option_type', 'warehouse').order('sort_order').order('name'),
      supabase.from('flexcon_inspection_options').select('*').in('option_type', ['origin', 'brand', 'brand_aomori', 'brand_iwate', 'shipment_product', 'grade']).eq('active', true).order('sort_order').order('name'),
      supabase.from('flexcon_inventory_ledger').select('*').order('movement_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000),
      supabase.from('flexcon_inventory_balances').select('*').order('warehouse_name').order('origin').order('product_name').order('grade').order('unit'),
    ]).then(([warehouseResult, productResult, movementResult, balanceResult]) => {
      if (warehouseResult.error || movementResult.error || balanceResult.error) return setNotice({ type: 'error', text: '在庫情報を取得できません。在庫管理用SQLを実行してください。' })
      setWarehouses((warehouseResult.data ?? []) as InspectionOption[])
      if (!productResult.error) setProductOptions((productResult.data ?? []) as InspectionOption[])
      setMovements((movementResult.data ?? []) as InventoryMovement[])
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
    : [{ id: 'inventory-uninspected', option_type: 'grade', name: '未検査', description: null, active: true, sort_order: -1, created_at: '', updated_at: '' } satisfies InspectionOption,
      ...productOptions.filter((item) => item.option_type === 'grade' && (productName === '飼料用玄米' ? item.name === '合格' : item.name !== '合格'))]
  const addProductNames = productNamesFor(form.origin)
  const addGrades = gradesFor(form.productName)
  const editProductNames = productNamesFor(editForm.origin)
  const editGrades = gradesFor(editForm.productName)
  const knownProductNames = useMemo(() => new Set(productOptions.filter((item) => ['brand', 'brand_aomori', 'brand_iwate', 'shipment_product'].includes(item.option_type)).map((item) => item.name)), [productOptions])
  const unmappedImportProducts = useMemo(() => [...new Set(importRecords.map((record) => record.product_name).filter((name) => !knownProductNames.has(name)))], [importRecords, knownProductNames])
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
    return [...grouped.values()].sort((left, right) => left.warehouseName.localeCompare(right.warehouseName, 'ja', { numeric: true })
      || left.origin.localeCompare(right.origin, 'ja', { numeric: true })
      || left.productName.localeCompare(right.productName, 'ja', { numeric: true })
      || left.unit.localeCompare(right.unit, 'ja', { numeric: true }))
  }, [balances])
  const balanceColumns = useMemo(() => [
    { key: 'warehouseName', label: '倉庫' },
    { key: 'origin', label: '産地' },
    { key: 'productName', label: '名称' },
    { key: 'unit', label: '単位' },
    ...balanceGradeColumns.map((grade) => ({ key: `grade:${grade}`, label: grade })),
  ], [balanceGradeColumns])
  const balanceFilterValues = useMemo(() => Object.fromEntries(balanceColumns.map((column) => [
    column.key,
    [...new Set(balanceRows.map((row) => balanceValue(row, column.key)))].sort((left, right) => left.localeCompare(right, 'ja', { numeric: true })),
  ])) as Record<string, string[]>, [balanceColumns, balanceRows])
  const displayedBalanceRows = useMemo(() => {
    const term = balanceSearch.trim().toLowerCase()
    return balanceRows.filter((row) => {
      if (term && !balanceColumns.some((column) => balanceValue(row, column.key).toLowerCase().includes(term))) return false
      return balanceColumns.every((column) => balanceColumnFilters[column.key] === undefined || balanceColumnFilters[column.key].includes(balanceValue(row, column.key)))
    })
  }, [balanceColumnFilters, balanceColumns, balanceRows, balanceSearch])
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
    setBusy(true)
    setNotice(null)
    setImportError('')
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
      const detailCounts = new Map<string, number>()
      rows.slice(1).forEach((row, rowIndex) => {
        const sourceRow = rowIndex + 2
        const product = splitSourceProduct(row[3])
        const riceCandidate = Boolean(product.packageType) || knownProductNames.has(product.productName) || /米|はじき/.test(product.productName)
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
          return
        }

        const detailNo = (detailCounts.get(settlementNo) ?? 0) + 1
        detailCounts.set(settlementNo, detailNo)
        const grade = otherProductNames.has(product.productName) ? '対象外' : '未検査'
        const parts: Array<{ quantity: number; unit: string }> = []
        if (product.packageType === 'FL' && sourceUnit === '俵' && (cropYear ?? 0) >= 2026) {
          const fullFlexcons = Math.floor(rawQuantity / 17)
          const remainderBales = rawQuantity % 17
          if (fullFlexcons > 0) parts.push({ quantity: fullFlexcons, unit: '本' })
          if (remainderBales > 0) parts.push({ quantity: remainderBales, unit: '俵' })
        } else if (!product.packageType && sourceUnit === 'kg' && ['くず米', '飼料用玄米', '中米', '中米はじき', '色選はじき'].includes(product.productName)) {
          const fullWeight = ['くず米', '飼料用玄米'].includes(product.productName) ? 1000 : 1020
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
          product_name: product.productName,
          producer_name: producerName,
          raw_quantity: rawQuantity,
          raw_unit: sourceUnit,
          grade,
          quantity: part.quantity,
          unit: part.unit,
        }))
      })

      if (records.length === 0 && errors.length === 0) throw new Error('米穀の取込対象がありません。')
      setImportFileName(file.name)
      setImportRecords(records)
      setImportErrors(errors)
      setImportProductMappings({})
      setImportWarehouseId(activeWarehouses.length === 1 ? activeWarehouses[0].id : '')
      setImportOpen(true)
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Excelファイルを読み込めませんでした。' })
    } finally {
      setBusy(false)
      if (importFileRef.current) importFileRef.current.value = ''
    }
  }

  const executePurchaseImport = async () => {
    if (busy) return
    if (!importWarehouseId) return setImportError('入庫先倉庫を選択してください。')
    if (importErrors.length > 0) return setImportError('エラーのある明細を修正したExcelで、もう一度取り込んでください。')
    if (unmappedImportProducts.some((name) => !importProductMappings[name])) return setImportError('名称の対応先をすべて選択してください。')
    setBusy(true)
    setImportError('')
    const { data, error } = await supabase.rpc('flexcon_import_purchase_statements', {
      p_worker_id: workerId,
      p_file_name: importFileName,
      p_to_warehouse_id: importWarehouseId,
      p_records: importRecords.map((record) => {
        const productName = importProductMappings[record.product_name] ?? record.product_name
        return { ...record, product_name: productName, grade: otherProductNames.has(productName) ? '対象外' : '未検査' }
      }),
    })
    setBusy(false)
    if (error) return setImportError(error.message)
    const result = data as { settlement_count?: number; line_count?: number } | null
    setImportOpen(false)
    setNotice({ type: 'success', text: `仕切り書${result?.settlement_count ?? 0}件、在庫明細${result?.line_count ?? importRecords.length}行を取り込みました。` })
    setVersion((value) => value + 1)
  }

  const validateForm = (target: MovementForm, mode: MovementMode, productNames: string[], grades: InspectionOption[]) => {
    if (!target.movementDate) return '日付を入力してください。'
    if (mode === 'inbound' && !target.producerName.trim()) return '手動入庫では生産者名を入力してください。'
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
      p_worker_id: workerId, p_movement_date: form.movementDate, p_producer_name: movementMode === 'inbound' ? form.producerName.trim() : '', p_origin: form.origin, p_product_name: form.productName,
      p_grade: otherProductNames.has(form.productName) ? '' : form.grade, p_quantity: Number(form.quantity), p_unit: form.unit,
      p_from_warehouse_id: movementMode === 'inbound' ? null : form.fromWarehouseId,
      p_to_warehouse_id: movementMode === 'outbound' ? null : form.toWarehouseId,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: `${movementMode === 'inbound' ? '入庫' : movementMode === 'outbound' ? '出庫' : '倉庫間移動'}を記録しました。` })
    setForm((current) => ({ ...emptyForm(), movementDate: current.movementDate, producerName: movementMode === 'inbound' ? current.producerName : '', origin: current.origin, productName: current.productName, grade: current.grade, unit: current.unit }))
    setVersion((value) => value + 1)
  }

  const beginEdit = (movement: InventoryMovement) => {
    setEditing(movement)
    setEditMode(modeForMovement(movement))
    setEditForm({ movementDate: movement.movement_date, producerName: movement.producer_name, origin: movement.origin, productName: movement.product_name, grade: movement.grade, quantity: String(movement.quantity), unit: movement.unit, fromWarehouseId: movement.from_warehouse_id ?? '', toWarehouseId: movement.to_warehouse_id ?? '' })
    setNotice(null)
  }

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing || busy || !canOperate) return
    const errorText = validateForm(editForm, editMode, editProductNames, editGrades)
    if (errorText) return setNotice({ type: 'error', text: errorText })
    setBusy(true); setNotice(null)
    const { error } = await supabase.rpc('flexcon_update_inventory_movement', {
      p_worker_id: workerId, p_movement_id: editing.id, p_movement_date: editForm.movementDate, p_origin: editForm.origin,
      p_producer_name: editMode === 'inbound' ? editForm.producerName.trim() : '',
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

  const filterValues = useMemo(() => Object.fromEntries(INVENTORY_COLUMNS.map((column) => [column.key, [...new Set(movements.map((movement) => movementValue(movement, column.key)))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }))])) as Record<InventoryColumn, string[]>, [movements])
  const displayedMovements = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = movements.filter((movement) => {
      if (term && !INVENTORY_COLUMNS.some((column) => movementValue(movement, column.key).toLowerCase().includes(term))) return false
      return INVENTORY_COLUMNS.every((column) => columnFilters[column.key] === undefined || columnFilters[column.key]!.includes(movementValue(movement, column.key)))
    })
    if (!sort) return rows
    return [...rows].sort((left, right) => {
      const leftValue = sort.key === 'quantity' ? Number(left.quantity) : sort.key === 'movementDate' ? new Date(left.movement_date).getTime() : movementValue(left, sort.key)
      const rightValue = sort.key === 'quantity' ? Number(right.quantity) : sort.key === 'movementDate' ? new Date(right.movement_date).getTime() : movementValue(right, sort.key)
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number' ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue), 'ja', { numeric: true })
      return sort.direction === 'asc' ? comparison : -comparison
    })
  }, [columnFilters, movements, search, sort])

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
      <label className="inventory-field-worker">作業者<input value={editing?.worker_name ?? workerName} readOnly /></label>
      {mode === 'inbound' && <label className="inventory-field-producer">生産者名<input value={target.producerName} maxLength={120} onChange={(e) => setTarget((current) => ({ ...current, producerName: e.target.value }))} required /></label>}
      <label className="inventory-field-origin">産地<select value={target.origin} onChange={(e) => setTarget((current) => ({ ...current, origin: e.target.value, productName: '', grade: '' }))} required><option value="">選択</option>{originOptions.map((origin) => <option key={origin.id} value={origin.name}>{origin.name}</option>)}</select></label>
      <label className="inventory-field-product">名称<select value={target.productName} onChange={(e) => setTarget((current) => ({ ...current, productName: e.target.value, grade: '' }))} disabled={!target.origin} required><option value="">{target.origin ? '選択' : '先に産地を選択'}</option>{productNames.map((product) => <option key={product} value={product}>{product}</option>)}</select></label>
      <label className="inventory-field-grade">等級<select value={otherProduct ? '' : target.grade} onChange={(e) => setTarget((current) => ({ ...current, grade: e.target.value }))} disabled={!target.productName || otherProduct} required={!otherProduct}><option value="">{otherProduct ? '対象外' : target.productName ? '選択' : '先に名称を選択'}</option>{grades.map((grade) => <option key={grade.id} value={grade.name}>{grade.name}</option>)}</select></label>
      <label className="inventory-field-quantity">数量<input type="number" min="0.001" step="0.001" inputMode="decimal" value={target.quantity} onChange={(e) => setTarget((current) => ({ ...current, quantity: e.target.value }))} required /></label>
      <label className="inventory-field-unit">単位<select value={target.unit} onChange={(e) => setTarget((current) => ({ ...current, unit: e.target.value }))} required><option value="本">本</option><option value="袋">袋</option><option value="kg">kg</option></select></label>
      <label className="inventory-field-from">移動元{mode === 'inbound' ? <input value="外部" readOnly /> : <select value={target.fromWarehouseId} onChange={(e) => setTarget((current) => ({ ...current, fromWarehouseId: e.target.value }))} required><option value="">未選択</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}{warehouse.active ? '' : '（無効）'}</option>)}</select>}</label>
      <label className="inventory-field-to">移動先{mode === 'outbound' ? <input value="外部" readOnly /> : <select value={target.toWarehouseId} onChange={(e) => setTarget((current) => ({ ...current, toWarehouseId: e.target.value }))} required><option value="">未選択</option>{selectableToWarehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}{warehouse.active ? '' : '（無効）'}</option>)}</select>}</label>
    </>
  }

  return <div className="inventory-page">
    <div className="page-heading"><h1>在庫</h1><p>手動の入出庫と仕切り書Excelから米穀在庫を管理します。</p></div>
    {canOperate && <section className="section-band inventory-entry-section">
      <div className="inventory-entry-toolbar">
        <div className="inventory-mode-switch" role="group" aria-label="移動区分">
          <button type="button" className={movementMode === 'inbound' ? 'active' : ''} onClick={() => changeMode('inbound')}><ArrowDownToLine size={18} />入庫</button>
          <button type="button" className={movementMode === 'outbound' ? 'active' : ''} onClick={() => changeMode('outbound')}><ArrowUpFromLine size={18} />出庫</button>
          <button type="button" className={movementMode === 'transfer' ? 'active' : ''} onClick={() => changeMode('transfer')}><ArrowRightLeft size={18} />倉庫間移動</button>
        </div>
        <input ref={importFileRef} className="visually-hidden" type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12" onChange={(event) => { const file = event.target.files?.[0]; if (file) void preparePurchaseImport(file) }} />
        <button className="secondary-button" type="button" onClick={() => importFileRef.current?.click()} disabled={busy}><FileUp size={18} />仕切り書Excel取込</button>
      </div>
      <form className={`inventory-entry-form ${movementMode === 'inbound' ? 'with-producer' : ''}`} onSubmit={(event) => void submit(event)}>{renderMovementFields(form, setForm, movementMode, addProductNames, addGrades)}<button className="primary-button" type="submit" disabled={busy || !warehouseRouteAvailable}><Plus size={18} />{busy ? '登録中...' : '記録を追加'}</button></form>
    </section>}
    {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    <div className="inventory-view-tabs" role="tablist" aria-label="在庫表示">
      <button type="button" role="tab" aria-selected={viewMode === 'history'} className={viewMode === 'history' ? 'active' : ''} onClick={() => setViewMode('history')}><List size={18} />入出庫記録</button>
      <button type="button" role="tab" aria-selected={viewMode === 'balance'} className={viewMode === 'balance' ? 'active' : ''} onClick={() => setViewMode('balance')}><Boxes size={18} />倉庫別在庫</button>
    </div>
    {viewMode === 'history' ? <>
      <div className="search-row inventory-search-row"><div className="search-input-wrap"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="入出庫記録を検索" /></div></div>
      <div className="inventory-table-wrap"><table className="inventory-table inventory-history-table">
        <thead><tr>{INVENTORY_COLUMNS.map((column) => <FilterableColumnHeader key={column.key} column={column} sort={sort} values={filterValues[column.key]} selectedValues={columnFilters[column.key]} onSort={changeSort} onFilterChange={changeColumnFilter} openRight={column.key === 'movementDate'} />)}{canOperate && <th className="inventory-actions-heading">操作</th>}</tr></thead>
        <tbody>{displayedMovements.map((movement) => { const mode = modeForMovement(movement); const manual = movement.source_type === 'manual'; return <tr className={`inventory-movement-${mode}`} key={movement.id}><td>{movementValue(movement, 'movementDate')}</td><td><span className={`inventory-movement-badge ${movementBadgeClass(movement)}`}>{mode === 'inbound' ? <ArrowDownToLine size={14} /> : mode === 'outbound' ? <ArrowUpFromLine size={14} /> : <ArrowRightLeft size={14} />}{movementTypeLabel(movement)}</span></td><td>{movement.settlement_no}</td><td>{movement.worker_name}</td><td>{movement.producer_name}</td><td>{movement.origin}</td><td>{movement.product_name}</td><td>{movementValue(movement, 'grade')}</td><td className="numeric-cell">{formatQuantity(movement.quantity)}</td><td>{movement.unit}</td><td>{movement.movement_from}</td><td>{movement.movement_to}</td>{canOperate && <td className="inventory-actions-cell">{manual ? <div className="inventory-row-actions"><button className="icon-button" type="button" title="入出庫記録を編集" aria-label="入出庫記録を編集" disabled={busy} onClick={() => beginEdit(movement)}><Pencil size={17} /></button><button className="icon-button delete-icon" type="button" title="入出庫記録を削除" aria-label="入出庫記録を削除" disabled={busy} onClick={() => void deleteMovement(movement)}><Trash2 size={17} /></button></div> : <span className="inventory-auto-label" title="仕切り書Excelから取り込まれた記録">取込</span>}</td>}</tr> })}{displayedMovements.length === 0 && <tr><td className="empty-state" colSpan={INVENTORY_COLUMNS.length + (canOperate ? 1 : 0)}>該当する入出庫記録はありません</td></tr>}</tbody>
      </table></div>
    </> : <><div className="search-row inventory-search-row"><div className="search-input-wrap"><Search size={18} /><input value={balanceSearch} onChange={(event) => setBalanceSearch(event.target.value)} placeholder="倉庫別在庫を検索" /></div></div><div className="inventory-table-wrap"><table className="inventory-table inventory-balance-table" style={{ '--inventory-balance-mobile-width': `${358 + balanceGradeColumns.length * 62}px` } as React.CSSProperties}><colgroup><col className="inventory-balance-warehouse-col" /><col className="inventory-balance-origin-col" /><col className="inventory-balance-product-col" /><col className="inventory-balance-unit-col" />{balanceGradeColumns.map((grade) => <col className="inventory-balance-grade-col" key={grade} />)}</colgroup><thead><tr>{balanceColumns.map((column, index) => <FilterableColumnHeader key={column.key} column={column} values={balanceFilterValues[column.key]} selectedValues={balanceColumnFilters[column.key]} onFilterChange={changeBalanceColumnFilter} openRight={index === 0} />)}</tr></thead><tbody>{displayedBalanceRows.length > 0 && <tr className="inventory-balance-total"><td><span className="warehouse-name"><Warehouse size={17} />{balanceIsFiltered ? '絞り込み合計' : '全倉庫合計'}</span></td><td>{balanceIsFiltered ? '表示中' : '全産地'}</td><td>{balanceIsFiltered ? '表示中' : '全名称'}</td><td>単位別</td>{balanceGradeColumns.map((grade) => { const totals = balanceTotals[grade] ?? {}; const values = ['本', '袋', 'kg', '俵'].filter((unit) => totals[unit]).map((unit) => `${formatQuantity(totals[unit])}${unit}`); const negative = Object.values(totals).some((quantity) => quantity < 0); return <td className={`numeric-cell inventory-balance-grade ${negative ? 'inventory-negative' : ''}`} key={grade}>{values.join(' / ')}</td> })}</tr>}{displayedBalanceRows.map((row) => <tr key={`${row.warehouseId}-${row.origin}-${row.productName}-${row.unit}`}><td><span className="warehouse-name"><Warehouse size={17} />{row.warehouseName}</span></td><td>{row.origin}</td><td>{row.productName}</td><td>{row.unit}</td>{balanceGradeColumns.map((grade) => { const quantity = row.quantities[grade] ?? 0; return <td className={`numeric-cell inventory-balance-grade ${quantity < 0 ? 'inventory-negative' : ''}`} key={grade}>{quantity === 0 ? '' : formatQuantity(quantity)}</td> })}</tr>)}{displayedBalanceRows.length === 0 && <tr><td className="empty-state" colSpan={balanceColumns.length}>該当する倉庫在庫はありません</td></tr>}</tbody></table></div></>}
    {editing && <div className="modal-backdrop" role="presentation"><section className="registration-modal inventory-edit-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-edit-title">
      <div className="modal-header"><div><h2 id="inventory-edit-title">入出庫記録を編集</h2><p>登録時の作業者：{editing.worker_name}</p></div><button className="icon-button" type="button" title="閉じる" aria-label="編集画面を閉じる" onClick={() => setEditing(null)} disabled={busy}><X size={20} /></button></div>
      {notice?.type === 'error' && <div className="notice error" role="alert">{notice.text}</div>}
      <div className="inventory-mode-switch" role="group" aria-label="移動区分">{(['inbound', 'outbound', 'transfer'] as MovementMode[]).map((mode) => <button key={mode} type="button" className={editMode === mode ? 'active' : ''} onClick={() => { setEditMode(mode); setEditForm((current) => ({ ...current, fromWarehouseId: mode === 'inbound' ? '' : current.fromWarehouseId, toWarehouseId: mode === 'outbound' ? '' : current.toWarehouseId })) }}>{mode === 'inbound' ? '入庫' : mode === 'outbound' ? '出庫' : '倉庫間移動'}</button>)}</div>
      <form className="form-grid inventory-edit-form" onSubmit={(event) => void saveEdit(event)}>{renderMovementFields(editForm, setEditForm, editMode, editProductNames, editGrades)}<div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setEditing(null)} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : '変更を保存'}</button></div></form>
    </section></div>}
    {importOpen && <div className="modal-backdrop" role="presentation"><section className="registration-modal inventory-import-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-import-title">
      <div className="modal-header"><div><h2 id="inventory-import-title">仕切り書Excel取込</h2><p>{importFileName}</p></div><button className="icon-button" type="button" title="閉じる" aria-label="取込画面を閉じる" onClick={() => setImportOpen(false)} disabled={busy}><X size={20} /></button></div>
      {importError && <div className="notice error" role="alert">{importError}</div>}
      <label>入庫先倉庫<select value={importWarehouseId} onChange={(event) => setImportWarehouseId(event.target.value)} required><option value="">選択</option>{activeWarehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></label>
      <div className="import-summary"><strong>{new Set(importRecords.map((record) => record.settlement_no)).size}件</strong><span>仕切り書／在庫明細 {importRecords.length}行</span></div>
      <p className="import-note">同じ仕切り書№は、今回のExcel内容で差し替えます。銘柄米はkgへ換算しません。</p>
      {unmappedImportProducts.length > 0 && <div className="inventory-import-mappings"><strong>名称の対応を選択</strong>{unmappedImportProducts.map((sourceName) => <label key={sourceName}><span>{sourceName}</span><select value={importProductMappings[sourceName] ?? ''} onChange={(event) => setImportProductMappings((current) => ({ ...current, [sourceName]: event.target.value }))}><option value="">対応先を選択</option>{productOptions.filter((item) => ['brand', 'brand_aomori', 'brand_iwate', 'shipment_product'].includes(item.option_type)).map((item) => <option key={`${item.option_type}-${item.id}`} value={item.name}>{item.name}</option>)}</select></label>)}</div>}
      {importErrors.length > 0 && <div className="inventory-import-errors" role="alert"><strong>取込できない行が{importErrors.length}件あります</strong>{importErrors.slice(0, 20).map((error) => <span key={error}>{error}</span>)}{importErrors.length > 20 && <span>ほか {importErrors.length - 20}件</span>}</div>}
      <div className="import-preview inventory-import-preview"><table><thead><tr><th>仕切り書№</th><th>日付</th><th>生産者名</th><th>産地</th><th>名称</th><th>元数量</th><th>在庫数量</th></tr></thead><tbody>{importRecords.slice(0, 30).map((record) => <tr key={`${record.settlement_no}-${record.detail_no}-${record.part_no}`}><td>{record.settlement_no}</td><td>{record.purchased_at.slice(0, 10).replaceAll('-', '/')}</td><td>{record.producer_name}</td><td>{record.origin}</td><td>{importProductMappings[record.product_name] ?? record.product_name}</td><td className="numeric-cell">{formatQuantity(record.raw_quantity)}{record.raw_unit}</td><td className="numeric-cell">{formatQuantity(record.quantity)}{record.unit}</td></tr>)}</tbody></table></div>
      {importRecords.length > 30 && <p className="import-preview-more">ほか {importRecords.length - 30}行</p>}
      <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setImportOpen(false)} disabled={busy}>取消</button><button className="primary-button" type="button" onClick={() => void executePurchaseImport()} disabled={busy || importErrors.length > 0 || importRecords.length === 0 || unmappedImportProducts.some((name) => !importProductMappings[name])}><FileUp size={18} />{busy ? '取込中...' : '取込を実行'}</button></div>
    </section></div>}
  </div>
}
