import { useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine, Boxes, List, Plus, Warehouse } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { InspectionOption } from '../types'

type Props = { workerId: string; workerName: string; canOperate: boolean }
type MovementMode = 'inbound' | 'outbound' | 'transfer'
type ViewMode = 'history' | 'balance'
type InventoryMovement = { id: string; movement_date: string; worker_name: string; origin: string; product_name: string; quantity: number; unit: string; movement_from: string; movement_to: string }
type InventoryBalance = { warehouse_id: string; warehouse_name: string; origin: string; product_name: string; quantity: number; unit: string }
type MovementForm = { movementDate: string; origin: string; productName: string; quantity: string; unit: string; fromWarehouseId: string; toWarehouseId: string }

function today() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}
function emptyForm(): MovementForm { return { movementDate: today(), origin: '', productName: '', quantity: '', unit: 'kg', fromWarehouseId: '', toWarehouseId: '' } }
function formatQuantity(value: number) { return Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 3 }) }

export function InventoryManager({ workerId, workerName, canOperate }: Props) {
  const [movementMode, setMovementMode] = useState<MovementMode>('inbound')
  const [viewMode, setViewMode] = useState<ViewMode>('history')
  const [warehouses, setWarehouses] = useState<InspectionOption[]>([])
  const [productOptions, setProductOptions] = useState<InspectionOption[]>([])
  const [movements, setMovements] = useState<InventoryMovement[]>([])
  const [balances, setBalances] = useState<InventoryBalance[]>([])
  const [form, setForm] = useState<MovementForm>(emptyForm)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    void Promise.all([
      supabase.from('flexcon_inspection_options').select('*').eq('option_type', 'warehouse').order('sort_order').order('name'),
      supabase.from('flexcon_inspection_options').select('*').in('option_type', ['origin', 'brand', 'brand_aomori', 'brand_iwate', 'shipment_product']).eq('active', true).order('sort_order').order('name'),
      supabase.from('flexcon_inventory_movements').select('*').order('movement_date', { ascending: false }).order('created_at', { ascending: false }).limit(500),
      supabase.from('flexcon_inventory_balances').select('*').order('warehouse_name').order('origin').order('product_name').order('unit'),
    ]).then(([warehouseResult, productResult, movementResult, balanceResult]) => {
      if (warehouseResult.error || movementResult.error || balanceResult.error) return setNotice({ type: 'error', text: '在庫情報を取得できません。在庫管理用SQLを実行してください。' })
      setWarehouses((warehouseResult.data ?? []) as InspectionOption[])
      if (!productResult.error) setProductOptions((productResult.data ?? []) as InspectionOption[])
      setMovements((movementResult.data ?? []) as InventoryMovement[])
      setBalances((balanceResult.data ?? []) as InventoryBalance[])
    })
  }, [version])

  const activeWarehouses = warehouses.filter((warehouse) => warehouse.active)
  const warehouseRouteAvailable = movementMode === 'inbound'
    ? activeWarehouses.length > 0
    : movementMode === 'outbound'
      ? warehouses.length > 0
      : activeWarehouses.length > 0 && warehouses.length > 1
  const originOptions = productOptions.filter((item) => item.option_type === 'origin')
  const uniqueProductOptions = useMemo(() => {
    const regionalType = form.origin === '青森県' ? 'brand_aomori' : form.origin === '岩手県' ? 'brand_iwate' : ''
    const allowedTypes = [regionalType, ...(form.origin === '青森県' ? ['brand'] : []), 'shipment_product']
    return [...new Set(productOptions.filter((item) => allowedTypes.includes(item.option_type)).map((item) => item.name))]
  }, [form.origin, productOptions])

  const changeMode = (mode: MovementMode) => {
    setMovementMode(mode)
    setForm((current) => ({ ...current, fromWarehouseId: mode === 'inbound' ? '' : current.fromWarehouseId, toWarehouseId: mode === 'outbound' ? '' : current.toWarehouseId }))
    setNotice(null)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || !canOperate) return
    const quantity = Number(form.quantity)
    if (!form.movementDate) return setNotice({ type: 'error', text: '日付を入力してください。' })
    if (!originOptions.some((item) => item.name === form.origin)) return setNotice({ type: 'error', text: '産地をマスタから選択してください。' })
    if (!uniqueProductOptions.includes(form.productName)) return setNotice({ type: 'error', text: '名称をマスタから選択してください。' })
    if (!Number.isFinite(quantity) || quantity <= 0) return setNotice({ type: 'error', text: '量は0より大きい数値で入力してください。' })
    if (!['本', '袋', 'kg'].includes(form.unit)) return setNotice({ type: 'error', text: '単位を本・袋・kgから選択してください。' })
    if (movementMode !== 'inbound' && !form.fromWarehouseId) return setNotice({ type: 'error', text: '移動元の倉庫を選択してください。' })
    if (movementMode !== 'outbound' && !form.toWarehouseId) return setNotice({ type: 'error', text: '移動先の倉庫を選択してください。' })
    if (movementMode === 'transfer' && form.fromWarehouseId === form.toWarehouseId) return setNotice({ type: 'error', text: '移動元と移動先には別の倉庫を選択してください。' })

    setBusy(true); setNotice(null)
    const { error } = await supabase.rpc('flexcon_add_inventory_movement', {
      p_worker_id: workerId, p_movement_date: form.movementDate, p_origin: form.origin.trim(), p_product_name: form.productName.trim(),
      p_quantity: quantity, p_unit: form.unit.trim(), p_from_warehouse_id: movementMode === 'inbound' ? null : form.fromWarehouseId,
      p_to_warehouse_id: movementMode === 'outbound' ? null : form.toWarehouseId,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: `${movementMode === 'inbound' ? '入庫' : movementMode === 'outbound' ? '出庫' : '倉庫間移動'}を記録しました。` })
    setForm((current) => ({ ...emptyForm(), movementDate: current.movementDate, origin: current.origin, productName: current.productName, unit: current.unit }))
    setVersion((value) => value + 1)
  }

  return <div className="inventory-page">
    <div className="page-heading"><h1>在庫</h1><p>米穀の入庫・出庫・倉庫間移動を記録します。</p></div>
    {canOperate && <section className="section-band inventory-entry-section">
      <div className="inventory-mode-switch" role="group" aria-label="移動区分">
        <button type="button" className={movementMode === 'inbound' ? 'active' : ''} onClick={() => changeMode('inbound')}><ArrowDownToLine size={18} />入庫</button>
        <button type="button" className={movementMode === 'outbound' ? 'active' : ''} onClick={() => changeMode('outbound')}><ArrowUpFromLine size={18} />出庫</button>
        <button type="button" className={movementMode === 'transfer' ? 'active' : ''} onClick={() => changeMode('transfer')}><ArrowRightLeft size={18} />倉庫間移動</button>
      </div>
      <form className="inventory-entry-form" onSubmit={(event) => void submit(event)}>
        <label>日付<input type="date" value={form.movementDate} onChange={(e) => setForm((c) => ({ ...c, movementDate: e.target.value }))} required /></label>
        <label>作業者<input value={workerName} readOnly /></label>
        <label>産地<select value={form.origin} onChange={(e) => setForm((c) => ({ ...c, origin: e.target.value, productName: '' }))} required><option value="">選択</option>{originOptions.map((origin) => <option key={origin.id} value={origin.name}>{origin.name}</option>)}</select></label>
        <label>名称<select value={form.productName} onChange={(e) => setForm((c) => ({ ...c, productName: e.target.value }))} disabled={!form.origin} required><option value="">{form.origin ? '選択' : '先に産地を選択'}</option>{uniqueProductOptions.map((product) => <option key={product} value={product}>{product}</option>)}</select></label>
        <label>量<input type="number" min="0.001" step="0.001" inputMode="decimal" value={form.quantity} onChange={(e) => setForm((c) => ({ ...c, quantity: e.target.value }))} required /></label>
        <label>単位<select value={form.unit} onChange={(e) => setForm((c) => ({ ...c, unit: e.target.value }))} required><option value="本">本</option><option value="袋">袋</option><option value="kg">kg</option></select></label>
        <label>移動元{movementMode === 'inbound' ? <input value="外部" readOnly /> : <select value={form.fromWarehouseId} onChange={(e) => setForm((c) => ({ ...c, fromWarehouseId: e.target.value }))} required><option value="">未選択</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.active ? '' : '（無効）'}</option>)}</select>}</label>
        <label>移動先{movementMode === 'outbound' ? <input value="外部" readOnly /> : <select value={form.toWarehouseId} onChange={(e) => setForm((c) => ({ ...c, toWarehouseId: e.target.value }))} required><option value="">未選択</option>{activeWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}</label>
        <button className="primary-button" type="submit" disabled={busy || !warehouseRouteAvailable}><Plus size={18} />{busy ? '登録中...' : '記録を追加'}</button>
      </form>
    </section>}
    {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    <div className="inventory-view-tabs" role="tablist" aria-label="在庫表示">
      <button type="button" role="tab" aria-selected={viewMode === 'history'} className={viewMode === 'history' ? 'active' : ''} onClick={() => setViewMode('history')}><List size={18} />入出庫記録</button>
      <button type="button" role="tab" aria-selected={viewMode === 'balance'} className={viewMode === 'balance' ? 'active' : ''} onClick={() => setViewMode('balance')}><Boxes size={18} />倉庫別在庫</button>
    </div>
    {viewMode === 'history' ? <div className="inventory-table-wrap"><table className="inventory-table inventory-history-table">
      <thead><tr><th>日付</th><th>作業者名</th><th>産地</th><th>銘柄等の名称</th><th>量</th><th>単位</th><th>移動元</th><th>移動先</th></tr></thead>
      <tbody>{movements.map((m) => <tr key={m.id}><td>{m.movement_date.replaceAll('-', '/')}</td><td>{m.worker_name}</td><td>{m.origin}</td><td>{m.product_name}</td><td className="numeric-cell">{formatQuantity(m.quantity)}</td><td>{m.unit}</td><td>{m.movement_from}</td><td>{m.movement_to}</td></tr>)}{movements.length === 0 && <tr><td className="empty-state" colSpan={8}>入出庫記録はありません</td></tr>}</tbody>
    </table></div> : <div className="inventory-table-wrap"><table className="inventory-table inventory-balance-table">
      <thead><tr><th>倉庫</th><th>産地</th><th>銘柄等の名称</th><th>在庫量</th><th>単位</th></tr></thead>
      <tbody>{balances.map((b) => <tr key={`${b.warehouse_id}-${b.origin}-${b.product_name}-${b.unit}`}><td><span className="warehouse-name"><Warehouse size={17} />{b.warehouse_name}</span></td><td>{b.origin}</td><td>{b.product_name}</td><td className={`numeric-cell ${Number(b.quantity) < 0 ? 'inventory-negative' : ''}`}>{formatQuantity(b.quantity)}</td><td>{b.unit}</td></tr>)}{balances.length === 0 && <tr><td className="empty-state" colSpan={5}>倉庫在庫はありません</td></tr>}</tbody>
    </table></div>}
  </div>
}
