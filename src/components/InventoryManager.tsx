import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowRightLeft, ArrowUp, ArrowUpFromLine, Boxes, Filter, List, Pencil, Plus, Save, Search, Warehouse, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { InspectionOption } from '../types'

type Props = { workerId: string; workerName: string; canOperate: boolean }
type MovementMode = 'inbound' | 'outbound' | 'transfer'
type ViewMode = 'history' | 'balance'
type SortDirection = 'asc' | 'desc'
type InventoryColumn = 'movementDate' | 'workerName' | 'origin' | 'productName' | 'grade' | 'quantity' | 'unit' | 'movementFrom' | 'movementTo'
type InventoryMovement = {
  id: string
  movement_date: string
  worker_name: string
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
type MovementForm = { movementDate: string; origin: string; productName: string; grade: string; quantity: string; unit: string; fromWarehouseId: string; toWarehouseId: string }

const INVENTORY_COLUMNS: Array<{ key: InventoryColumn; label: string }> = [
  { key: 'movementDate', label: '日付' },
  { key: 'workerName', label: '作業者名' },
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
  return { movementDate: today(), origin: '', productName: '', grade: '', quantity: '', unit: 'kg', fromWarehouseId: '', toWarehouseId: '' }
}

function formatQuantity(value: number) {
  return Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 3 })
}

function modeForMovement(movement: InventoryMovement): MovementMode {
  if (!movement.from_warehouse_id) return 'inbound'
  if (!movement.to_warehouse_id) return 'outbound'
  return 'transfer'
}

function movementValue(movement: InventoryMovement, key: InventoryColumn) {
  if (key === 'movementDate') return movement.movement_date.replaceAll('-', '/')
  if (key === 'workerName') return movement.worker_name
  if (key === 'productName') return movement.product_name
  if (key === 'quantity') return formatQuantity(movement.quantity)
  if (key === 'movementFrom') return movement.movement_from
  if (key === 'movementTo') return movement.movement_to
  if (key === 'grade') return movement.grade || '対象外'
  return movement[key]
}

function InventoryColumnHeader({
  column,
  sort,
  values,
  selectedValues,
  onSort,
  onFilterChange,
}: {
  column: { key: InventoryColumn; label: string }
  sort: { key: InventoryColumn; direction: SortDirection } | null
  values: string[]
  selectedValues: string[] | undefined
  onSort: (key: InventoryColumn) => void
  onFilterChange: (key: InventoryColumn, values: string[] | undefined) => void
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
      <button type="button" className="shipment-column-sort" onClick={() => onSort(column.key)}>
        <span>{column.label}</span>
        {sort?.key === column.key && (sort.direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
      </button>
      <details ref={filterRef} className={`shipment-column-filter ${column.key === 'movementDate' ? 'open-right' : ''} ${selectedValues === undefined ? '' : 'active'}`}>
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
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    void Promise.all([
      supabase.from('flexcon_inspection_options').select('*').eq('option_type', 'warehouse').order('sort_order').order('name'),
      supabase.from('flexcon_inspection_options').select('*').in('option_type', ['origin', 'brand', 'brand_aomori', 'brand_iwate', 'shipment_product', 'grade']).eq('active', true).order('sort_order').order('name'),
      supabase.from('flexcon_inventory_movements').select('*').order('movement_date', { ascending: false }).order('created_at', { ascending: false }).limit(500),
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
    : productOptions.filter((item) => item.option_type === 'grade' && (productName === '飼料用玄米' ? item.name === '合格' : item.name !== '合格'))
  const addProductNames = productNamesFor(form.origin)
  const addGrades = gradesFor(form.productName)
  const editProductNames = productNamesFor(editForm.origin)
  const editGrades = gradesFor(editForm.productName)
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
  const balanceTotals = useMemo(() => {
    const totals: Record<string, Record<string, number>> = {}
    balances.forEach((balance) => {
      const grade = balance.grade || '対象外'
      totals[grade] ??= {}
      totals[grade][balance.unit] = (totals[grade][balance.unit] ?? 0) + Number(balance.quantity)
    })
    return totals
  }, [balances])
  const warehouseRouteAvailable = movementMode === 'inbound'
    ? activeWarehouses.length > 0
    : movementMode === 'outbound'
      ? warehouses.length > 0
      : activeWarehouses.length > 0 && warehouses.length > 1

  const validateForm = (target: MovementForm, mode: MovementMode, productNames: string[], grades: InspectionOption[]) => {
    if (!target.movementDate) return '日付を入力してください。'
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
      p_worker_id: workerId, p_movement_date: form.movementDate, p_origin: form.origin, p_product_name: form.productName,
      p_grade: otherProductNames.has(form.productName) ? '' : form.grade, p_quantity: Number(form.quantity), p_unit: form.unit,
      p_from_warehouse_id: movementMode === 'inbound' ? null : form.fromWarehouseId,
      p_to_warehouse_id: movementMode === 'outbound' ? null : form.toWarehouseId,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: `${movementMode === 'inbound' ? '入庫' : movementMode === 'outbound' ? '出庫' : '倉庫間移動'}を記録しました。` })
    setForm((current) => ({ ...emptyForm(), movementDate: current.movementDate, origin: current.origin, productName: current.productName, grade: current.grade, unit: current.unit }))
    setVersion((value) => value + 1)
  }

  const beginEdit = (movement: InventoryMovement) => {
    setEditing(movement)
    setEditMode(modeForMovement(movement))
    setEditForm({ movementDate: movement.movement_date, origin: movement.origin, productName: movement.product_name, grade: movement.grade, quantity: String(movement.quantity), unit: movement.unit, fromWarehouseId: movement.from_warehouse_id ?? '', toWarehouseId: movement.to_warehouse_id ?? '' })
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

  const renderMovementFields = (target: MovementForm, setTarget: React.Dispatch<React.SetStateAction<MovementForm>>, mode: MovementMode, productNames: string[], grades: InspectionOption[]) => {
    const otherProduct = otherProductNames.has(target.productName)
    const selectableToWarehouses = editing ? warehouses.filter((warehouse) => warehouse.active || warehouse.id === target.toWarehouseId) : activeWarehouses
    return <>
      <label>日付<input type="date" value={target.movementDate} onChange={(e) => setTarget((current) => ({ ...current, movementDate: e.target.value }))} required /></label>
      <label>作業者<input value={editing?.worker_name ?? workerName} readOnly /></label>
      <label>産地<select value={target.origin} onChange={(e) => setTarget((current) => ({ ...current, origin: e.target.value, productName: '', grade: '' }))} required><option value="">選択</option>{originOptions.map((origin) => <option key={origin.id} value={origin.name}>{origin.name}</option>)}</select></label>
      <label>名称<select value={target.productName} onChange={(e) => setTarget((current) => ({ ...current, productName: e.target.value, grade: '' }))} disabled={!target.origin} required><option value="">{target.origin ? '選択' : '先に産地を選択'}</option>{productNames.map((product) => <option key={product} value={product}>{product}</option>)}</select></label>
      <label>等級<select value={otherProduct ? '' : target.grade} onChange={(e) => setTarget((current) => ({ ...current, grade: e.target.value }))} disabled={!target.productName || otherProduct} required={!otherProduct}><option value="">{otherProduct ? '対象外' : target.productName ? '選択' : '先に名称を選択'}</option>{grades.map((grade) => <option key={grade.id} value={grade.name}>{grade.name}</option>)}</select></label>
      <label>量<input type="number" min="0.001" step="0.001" inputMode="decimal" value={target.quantity} onChange={(e) => setTarget((current) => ({ ...current, quantity: e.target.value }))} required /></label>
      <label>単位<select value={target.unit} onChange={(e) => setTarget((current) => ({ ...current, unit: e.target.value }))} required><option value="本">本</option><option value="袋">袋</option><option value="kg">kg</option></select></label>
      <label>移動元{mode === 'inbound' ? <input value="外部" readOnly /> : <select value={target.fromWarehouseId} onChange={(e) => setTarget((current) => ({ ...current, fromWarehouseId: e.target.value }))} required><option value="">未選択</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}{warehouse.active ? '' : '（無効）'}</option>)}</select>}</label>
      <label>移動先{mode === 'outbound' ? <input value="外部" readOnly /> : <select value={target.toWarehouseId} onChange={(e) => setTarget((current) => ({ ...current, toWarehouseId: e.target.value }))} required><option value="">未選択</option>{selectableToWarehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}{warehouse.active ? '' : '（無効）'}</option>)}</select>}</label>
    </>
  }

  return <div className="inventory-page">
    <div className="page-heading"><h1>在庫</h1><p>米穀の入庫・出庫・倉庫間移動を記録します。</p></div>
    {canOperate && <section className="section-band inventory-entry-section">
      <div className="inventory-mode-switch" role="group" aria-label="移動区分">
        <button type="button" className={movementMode === 'inbound' ? 'active' : ''} onClick={() => changeMode('inbound')}><ArrowDownToLine size={18} />入庫</button>
        <button type="button" className={movementMode === 'outbound' ? 'active' : ''} onClick={() => changeMode('outbound')}><ArrowUpFromLine size={18} />出庫</button>
        <button type="button" className={movementMode === 'transfer' ? 'active' : ''} onClick={() => changeMode('transfer')}><ArrowRightLeft size={18} />倉庫間移動</button>
      </div>
      <form className="inventory-entry-form" onSubmit={(event) => void submit(event)}>{renderMovementFields(form, setForm, movementMode, addProductNames, addGrades)}<button className="primary-button" type="submit" disabled={busy || !warehouseRouteAvailable}><Plus size={18} />{busy ? '登録中...' : '記録を追加'}</button></form>
    </section>}
    {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    <div className="inventory-view-tabs" role="tablist" aria-label="在庫表示">
      <button type="button" role="tab" aria-selected={viewMode === 'history'} className={viewMode === 'history' ? 'active' : ''} onClick={() => setViewMode('history')}><List size={18} />入出庫記録</button>
      <button type="button" role="tab" aria-selected={viewMode === 'balance'} className={viewMode === 'balance' ? 'active' : ''} onClick={() => setViewMode('balance')}><Boxes size={18} />倉庫別在庫</button>
    </div>
    {viewMode === 'history' ? <>
      <div className="search-row inventory-search-row"><div className="search-input-wrap"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="入出庫記録を検索" /></div></div>
      <div className="inventory-table-wrap"><table className="inventory-table inventory-history-table">
        <thead><tr>{INVENTORY_COLUMNS.map((column) => <InventoryColumnHeader key={column.key} column={column} sort={sort} values={filterValues[column.key]} selectedValues={columnFilters[column.key]} onSort={changeSort} onFilterChange={changeColumnFilter} />)}{canOperate && <th className="inventory-actions-heading">編集</th>}</tr></thead>
        <tbody>{displayedMovements.map((movement) => <tr key={movement.id}><td>{movementValue(movement, 'movementDate')}</td><td>{movement.worker_name}</td><td>{movement.origin}</td><td>{movement.product_name}</td><td>{movementValue(movement, 'grade')}</td><td className="numeric-cell">{formatQuantity(movement.quantity)}</td><td>{movement.unit}</td><td>{movement.movement_from}</td><td>{movement.movement_to}</td>{canOperate && <td className="inventory-actions-cell"><button className="icon-button" type="button" title="入出庫記録を編集" aria-label="入出庫記録を編集" onClick={() => beginEdit(movement)}><Pencil size={17} /></button></td>}</tr>)}{displayedMovements.length === 0 && <tr><td className="empty-state" colSpan={canOperate ? 10 : 9}>該当する入出庫記録はありません</td></tr>}</tbody>
      </table></div>
    </> : <div className="inventory-table-wrap"><table className="inventory-table inventory-balance-table"><thead><tr><th>倉庫</th><th>産地</th><th>名称</th><th>単位</th>{balanceGradeColumns.map((grade) => <th className="inventory-balance-grade" key={grade}>{grade}</th>)}</tr></thead><tbody>{balanceRows.length > 0 && <tr className="inventory-balance-total"><td><span className="warehouse-name"><Warehouse size={17} />全倉庫合計</span></td><td>全産地</td><td>全名称</td><td>単位別</td>{balanceGradeColumns.map((grade) => { const totals = balanceTotals[grade] ?? {}; const values = ['本', '袋', 'kg'].filter((unit) => totals[unit]).map((unit) => `${formatQuantity(totals[unit])}${unit}`); const negative = Object.values(totals).some((quantity) => quantity < 0); return <td className={`numeric-cell inventory-balance-grade ${negative ? 'inventory-negative' : ''}`} key={grade}>{values.join(' / ')}</td> })}</tr>}{balanceRows.map((row) => <tr key={`${row.warehouseId}-${row.origin}-${row.productName}-${row.unit}`}><td><span className="warehouse-name"><Warehouse size={17} />{row.warehouseName}</span></td><td>{row.origin}</td><td>{row.productName}</td><td>{row.unit}</td>{balanceGradeColumns.map((grade) => { const quantity = row.quantities[grade] ?? 0; return <td className={`numeric-cell inventory-balance-grade ${quantity < 0 ? 'inventory-negative' : ''}`} key={grade}>{quantity === 0 ? '' : formatQuantity(quantity)}</td> })}</tr>)}{balanceRows.length === 0 && <tr><td className="empty-state" colSpan={4 + balanceGradeColumns.length}>倉庫在庫はありません</td></tr>}</tbody></table></div>}
    {editing && <div className="modal-backdrop" role="presentation"><section className="registration-modal inventory-edit-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-edit-title">
      <div className="modal-header"><div><h2 id="inventory-edit-title">入出庫記録を編集</h2><p>登録時の作業者：{editing.worker_name}</p></div><button className="icon-button" type="button" title="閉じる" aria-label="編集画面を閉じる" onClick={() => setEditing(null)} disabled={busy}><X size={20} /></button></div>
      {notice?.type === 'error' && <div className="notice error" role="alert">{notice.text}</div>}
      <div className="inventory-mode-switch" role="group" aria-label="移動区分">{(['inbound', 'outbound', 'transfer'] as MovementMode[]).map((mode) => <button key={mode} type="button" className={editMode === mode ? 'active' : ''} onClick={() => { setEditMode(mode); setEditForm((current) => ({ ...current, fromWarehouseId: mode === 'inbound' ? '' : current.fromWarehouseId, toWarehouseId: mode === 'outbound' ? '' : current.toWarehouseId })) }}>{mode === 'inbound' ? '入庫' : mode === 'outbound' ? '出庫' : '倉庫間移動'}</button>)}</div>
      <form className="form-grid inventory-edit-form" onSubmit={(event) => void saveEdit(event)}>{renderMovementFields(editForm, setEditForm, editMode, editProductNames, editGrades)}<div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setEditing(null)} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : '変更を保存'}</button></div></form>
    </section></div>}
  </div>
}
