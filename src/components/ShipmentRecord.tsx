import { useEffect, useState, type FormEvent } from 'react'
import { RotateCcw, Send, UserRound } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Destination, InspectionOption, TransportProfile } from '../types'
import { ShipmentRecordItemsEditor } from './ShipmentRecordItemsEditor'
import { type ShipmentRecordItemDraft, validateShipmentRecordItems } from '../lib/shipmentRecordValidation'

type Props = {
  workerId: string
  workerName: string
  onRegistered: () => void
}

function currentLocalDateTime() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

export function ShipmentRecord({ workerId, workerName, onRegistered }: Props) {
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [warehouses, setWarehouses] = useState<InspectionOption[]>([])
  const [transportProfiles, setTransportProfiles] = useState<TransportProfile[]>([])
  const [shipmentProducts, setShipmentProducts] = useState<InspectionOption[]>([])
  const [items, setItems] = useState<ShipmentRecordItemDraft[]>([])
  const [shippedAt, setShippedAt] = useState(currentLocalDateTime)
  const [destinationId, setDestinationId] = useState('')
  const [fromWarehouseId, setFromWarehouseId] = useState('')
  const [transportProfileId, setTransportProfileId] = useState('')
  const [driverName, setDriverName] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [purchasePrice, setPurchasePrice] = useState('')
  const [note, setNote] = useState('')
  const [editorVersion, setEditorVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    void Promise.all([
      supabase.from('flexcon_destinations').select('*').eq('active', true).order('name'),
      supabase.from('flexcon_inspection_options').select('*').eq('option_type', 'warehouse').order('sort_order').order('name'),
      supabase.from('flexcon_transport_profiles').select('*').eq('active', true).order('company_name'),
      supabase.from('flexcon_inspection_options').select('*').in('option_type', ['brand', 'brand_aomori', 'brand_iwate', 'shipment_product', 'grade']).eq('active', true).order('sort_order').order('name'),
    ]).then(([destinationResult, warehouseResult, transportResult, productResult]) => {
      if (destinationResult.error || warehouseResult.error || transportResult.error || productResult.error) {
        setNotice({ type: 'error', text: '出荷に必要なマスタを取得できませんでした。' })
        return
      }
      setDestinations((destinationResult.data ?? []) as Destination[])
      setWarehouses((warehouseResult.data ?? []) as InspectionOption[])
      setTransportProfiles((transportResult.data ?? []) as TransportProfile[])
      setShipmentProducts((productResult.data ?? []) as InspectionOption[])
      if (!productResult.data?.some((item) => item.option_type !== 'grade')) setNotice({ type: 'error', text: '種類がマスタに登録されていません。' })
    })
  }, [])

  const count = items.length
  const origin = [...new Set(items.map((item) => item.originPrefecture).filter(Boolean))].join('、') || '産地未登録'
  const products = items.map((item) => `${item.productName}${item.grade ? ` ${item.grade}` : ''} ${item.quantityCount}${item.unit}`).join('、') || '明細未登録'

  const clearForm = () => {
    setNotice(null)
    setItems([])
    setEditorVersion((version) => version + 1)
    setShippedAt(currentLocalDateTime())
    setDestinationId('')
    setFromWarehouseId('')
    setTransportProfileId('')
    setDriverName('')
    setVehicleNo('')
    setPurchasePrice('')
    setNote('')
  }

  const register = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!shippedAt || !Number.isFinite(new Date(shippedAt).getTime())) return setNotice({ type: 'error', text: '出荷日時を入力してください。' })
    if (!destinationId) return setNotice({ type: 'error', text: '納品先を選択してください。' })
    if (!fromWarehouseId) return setNotice({ type: 'error', text: '出庫元倉庫を選択してください。' })
    if (!transportProfileId) return setNotice({ type: 'error', text: '運送会社を選択してください。' })
    if (!driverName.trim()) return setNotice({ type: 'error', text: 'ドライバー名を入力してください。' })
    if (!vehicleNo.trim()) return setNotice({ type: 'error', text: '車両番号を入力してください。' })
    const itemError = validateShipmentRecordItems(items, shipmentProducts)
    if (itemError) return setNotice({ type: 'error', text: itemError })
    const price = purchasePrice.trim() === '' ? null : Number(purchasePrice)
    if (price !== null && (!Number.isFinite(price) || price < 0)) return setNotice({ type: 'error', text: '仕入値は0以上の数値で入力してください。' })

    setBusy(true)
    setNotice(null)
    const { error } = await supabase.rpc('flexcon_register_inventory_record', {
      p_worker_id: workerId,
      p_destination_id: destinationId,
      p_transport_profile_id: transportProfileId,
      p_shipped_at: new Date(shippedAt).toISOString(),
      p_driver_name: driverName.trim(),
      p_vehicle_no: vehicleNo.trim(),
      p_purchase_price_per_bale: price,
      p_from_warehouse_id: fromWarehouseId,
      p_note: note.trim() || null,
      p_items: items.map((item) => ({
        origin_prefecture: item.originPrefecture,
        product_name: item.productName,
        quantity_count: Number(item.quantityCount),
        grade: item.grade || null,
        unit: item.unit,
      })),
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setItems([])
    setEditorVersion((version) => version + 1)
    setDriverName('')
    setVehicleNo('')
    setPurchasePrice('')
    setNote('')
    setShippedAt(currentLocalDateTime())
    setNotice({ type: 'success', text: `${count}件の出荷明細を登録しました。` })
    onRegistered()
  }

  return <div className="other-rice-page">
    <div className="page-heading"><h1>出荷記録</h1></div>
    {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    <h2 className="other-rice-heading">出荷内容</h2>
    <div className="shipment-registration-summary" aria-label="出荷内容">
      <div><span>明細数</span><strong>{count}件</strong></div>
      <div><span>産地</span><strong>{origin}</strong></div>
      <div><span>種類・数量</span><strong>{products}</strong></div>
    </div>
    <form className="shipment-registration-form" noValidate onSubmit={(event) => void register(event)}>
      <div className="modal-actions other-rice-actions"><button className="secondary-button" type="button" onClick={clearForm} disabled={busy}><RotateCcw size={18} />入力をクリア</button><button className="primary-button" type="submit" disabled={busy || items.length === 0}><Send size={18} />{busy ? '登録中...' : '出荷を登録'}</button></div>
      <ShipmentRecordItemsEditor key={editorVersion} items={items} onChange={setItems} options={shipmentProducts} disabled={busy} />
      <div className="shipment-form-row worker-summary"><span className="worker-summary-label"><UserRound size={18} />担当者</span><strong>{workerName}</strong></div>
      <label className="shipment-form-row"><span>出荷日時</span><input className={!shippedAt ? 'shipment-required-missing' : ''} type="datetime-local" step={60} value={shippedAt} onChange={(event) => setShippedAt(event.target.value)} required /></label>
      <label className="shipment-form-row"><span>納品先</span><select className={!destinationId ? 'shipment-required-missing' : ''} value={destinationId} onChange={(event) => setDestinationId(event.target.value)} required><option value="">選択してください</option>{destinations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="shipment-form-row"><span>出庫元倉庫</span><select className={!fromWarehouseId ? 'shipment-required-missing' : ''} value={fromWarehouseId} onChange={(event) => setFromWarehouseId(event.target.value)} required><option value="">選択してください</option>{warehouses.map((item) => <option key={item.id} value={item.id}>{item.name}{item.active || item.name === '倉庫未設定' ? '' : '（無効）'}</option>)}</select></label>
      <label className="shipment-form-row"><span>運送会社</span><select className={!transportProfileId ? 'shipment-required-missing' : ''} value={transportProfileId} onChange={(event) => setTransportProfileId(event.target.value)} required><option value="">選択してください</option>{transportProfiles.map((item) => <option key={item.id} value={item.id}>{item.company_name}</option>)}</select></label>
      <label className="shipment-form-row"><span>ドライバー名</span><input className={!driverName.trim() ? 'shipment-required-missing' : ''} value={driverName} onChange={(event) => setDriverName(event.target.value)} required /></label>
      <label className="shipment-form-row"><span>車両番号</span><input className={!vehicleNo.trim() ? 'shipment-required-missing' : ''} value={vehicleNo} onChange={(event) => setVehicleNo(event.target.value)} required placeholder="例：岩手 100 あ 12-34" /></label>
      <label className="shipment-form-row"><span>仕入値（任意・1俵当たり）</span><input type="number" min="0" step="1" inputMode="decimal" value={purchasePrice} onChange={(event) => setPurchasePrice(event.target.value)} /></label>
      <label className="shipment-form-row"><span>備考（任意）</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="申し送りなど" /></label>
    </form>
  </div>
}
