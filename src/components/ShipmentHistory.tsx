import { useEffect, useMemo, useState } from 'react'
import { Building2, Download, Pencil, Save, Search, Trash2, Truck, UserRound, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Destination, InspectionOption, Shipment, TransportProfile } from '../types'

type Props = {
  refreshKey: number
  workerId: string
  isAdmin: boolean
}

type Notice = { type: 'success' | 'error'; text: string } | null

function toLocalDateTime(value: string) {
  const date = new Date(value)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function shipmentProductSummary(shipment: Shipment) {
  if (shipment.shipment_kind !== 'qr_flexcon') {
    const unit = shipment.shipment_kind === 'paper_bag' ? '袋' : '本'
    return `${shipment.product_name ?? '品名未登録'} ${shipment.quantity_count ?? 0}${unit}`
  }

  const counts = shipment.flexcon_shipment_items.reduce<Record<string, number>>((result, item) => {
    const name = item.product_name?.trim() || shipment.product_name?.trim() || '品名未登録'
    result[name] = (result[name] ?? 0) + 1
    return result
  }, {})
  return Object.entries(counts).map(([name, count]) => `${name} ${count}本`).join('、')
}

export function ShipmentHistory({ refreshKey, workerId, isAdmin }: Props) {
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [transportProfiles, setTransportProfiles] = useState<TransportProfile[]>([])
  const [shipmentProducts, setShipmentProducts] = useState<InspectionOption[]>([])
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [localVersion, setLocalVersion] = useState(0)
  const [editing, setEditing] = useState<Shipment | null>(null)
  const [shippedAt, setShippedAt] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [transportProfileId, setTransportProfileId] = useState('')
  const [driverName, setDriverName] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [note, setNote] = useState('')
  const [purchasePrice, setPurchasePrice] = useState('')
  const [productName, setProductName] = useState('')
  const [quantityCount, setQuantityCount] = useState('')
  const [originPrefecture, setOriginPrefecture] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void supabase.from('flexcon_shipments').select('id, destination_id, transport_profile_id, shipped_at, carrier_name, driver_name, vehicle_no, note, shipment_kind, origin_prefecture, product_name, quantity_count, purchase_price_per_bale, flexcon_destinations(name), flexcon_shipment_items(lot_number, product_name), workers(worker_name)').order('shipped_at', { ascending: false }).limit(200)
      .then(({ data, error }) => {
        if (error) setNotice({ type: 'error', text: error.message })
        else setShipments((data ?? []) as unknown as Shipment[])
      })
  }, [refreshKey, localVersion])

  useEffect(() => {
    if (!isAdmin) return
    void Promise.all([
      supabase.from('flexcon_destinations').select('*').order('active', { ascending: false }).order('name'),
      supabase.from('flexcon_transport_profiles').select('*').order('active', { ascending: false }).order('company_name'),
      supabase.from('flexcon_inspection_options').select('*').in('option_type', ['shipment_product', 'brand_aomori', 'brand_iwate']).order('sort_order').order('name'),
    ]).then(([destinationResult, transportResult, productResult]) => {
      if (destinationResult.error) setNotice({ type: 'error', text: destinationResult.error.message })
      else setDestinations((destinationResult.data ?? []) as Destination[])
      if (transportResult.error) setNotice({ type: 'error', text: transportResult.error.message })
      else setTransportProfiles((transportResult.data ?? []) as TransportProfile[])
      if (!productResult.error) setShipmentProducts((productResult.data ?? []) as InspectionOption[])
    })
  }, [isAdmin])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return shipments
    return shipments.filter((item) =>
      item.flexcon_destinations?.name.toLowerCase().includes(term)
      || item.carrier_name?.toLowerCase().includes(term)
      || item.driver_name?.toLowerCase().includes(term)
      || item.vehicle_no?.toLowerCase().includes(term)
      || item.product_name?.toLowerCase().includes(term)
      || shipmentProductSummary(item).toLowerCase().includes(term)
      || item.workers?.worker_name.toLowerCase().includes(term)
      || item.flexcon_shipment_items.some((detail) => detail.lot_number.includes(term)))
  }, [search, shipments])

  const beginEdit = (shipment: Shipment) => {
    setEditing(shipment)
    setShippedAt(toLocalDateTime(shipment.shipped_at))
    setDestinationId(shipment.destination_id)
    setTransportProfileId(
      shipment.transport_profile_id
      ?? transportProfiles.find((item) => item.company_name === shipment.carrier_name)?.id
      ?? '',
    )
    setDriverName(shipment.driver_name ?? '')
    setVehicleNo(shipment.vehicle_no ?? '')
    setNote(shipment.note ?? '')
    setPurchasePrice(shipment.purchase_price_per_bale == null ? '' : String(shipment.purchase_price_per_bale))
    setProductName(shipment.product_name ?? '')
    setQuantityCount(String(shipment.quantity_count ?? shipment.flexcon_shipment_items.length))
    setOriginPrefecture(shipment.origin_prefecture ?? '')
    setNotice(null)
  }

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing || !isAdmin) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_update_shipment', {
      p_worker_id: workerId,
      p_shipment_id: editing.id,
      p_destination_id: destinationId,
      p_transport_profile_id: transportProfileId,
      p_shipped_at: new Date(shippedAt).toISOString(),
      p_driver_name: driverName.trim(),
      p_vehicle_no: vehicleNo.trim(),
      p_origin_prefecture: originPrefecture || null,
      p_product_name: productName || null,
      p_quantity_count: Number(quantityCount),
      p_purchase_price_per_bale: purchasePrice.trim() === '' ? null : Number(purchasePrice),
      p_note: note.trim() || null,
    })
    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setEditing(null)
      setNotice({ type: 'success', text: '出荷履歴を更新しました。' })
      setLocalVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const deleteShipment = async (shipment: Shipment) => {
    if (!isAdmin) return
    const destination = shipment.flexcon_destinations?.name ?? '納品先不明'
    const count = shipment.quantity_count ?? shipment.flexcon_shipment_items.length
    const unit = shipment.shipment_kind === 'paper_bag' ? '袋' : '本'
    const qrMessage = shipment.shipment_kind === 'qr_flexcon' ? '\n対象のQRコードは未出荷状態へ戻ります。' : ''
    const message = `${destination}への${count}${unit}の出荷履歴を削除しますか？${qrMessage}`
    if (!window.confirm(message)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_shipment', {
      p_worker_id: workerId,
      p_shipment_id: shipment.id,
    })
    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setNotice({ type: 'success', text: shipment.shipment_kind === 'qr_flexcon' ? '出荷履歴を削除し、対象QRを未出荷へ戻しました。' : '出荷履歴を削除しました。' })
      setLocalVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const exportCsv = () => {
    const rows = [['出荷日時', '納品先', '担当者', '運送会社名', 'ドライバー名', '車両番号', '出荷区分', '県名', '品名', '種類別数量', 'QRコード', '数量', '単位', '仕入値（1俵当たり）', '備考']]
    filtered.forEach((shipment) => {
      const details: Array<{ lot_number: string; product_name: string | null } | null> = shipment.flexcon_shipment_items.length > 0
        ? shipment.flexcon_shipment_items
        : [null]
      details.forEach((item) => rows.push([
        new Date(shipment.shipped_at).toLocaleString('ja-JP'),
        shipment.flexcon_destinations?.name ?? '',
        shipment.workers?.worker_name ?? '',
        shipment.carrier_name ?? '',
        shipment.driver_name ?? '',
        shipment.vehicle_no ?? '',
        shipment.shipment_kind === 'paper_bag' ? '紙袋' : shipment.shipment_kind === 'other_rice' ? '銘柄米以外' : 'QRフレコン',
        shipment.origin_prefecture ?? '',
        item?.product_name ?? shipment.product_name ?? '品名未登録',
        shipmentProductSummary(shipment),
        item?.lot_number ?? '',
        String(shipment.quantity_count ?? shipment.flexcon_shipment_items.length),
        shipment.shipment_kind === 'paper_bag' ? '袋' : '本',
        shipment.purchase_price_per_bale == null ? '' : String(shipment.purchase_price_per_bale),
        shipment.note ?? '',
      ]))
    })
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
    const csv = '\uFEFF' + rows.map((row) => row.map(quote).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `出荷履歴_${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const paperBagBrands = shipmentProducts.filter((item) =>
    item.option_type === (originPrefecture === '青森県' ? 'brand_aomori' : originPrefecture === '岩手県' ? 'brand_iwate' : 'brand'))

  return (
    <div>
      <div className="page-heading"><h1>出荷履歴</h1><p>納品先、担当者、運送会社、ドライバー、車両番号、ロット番号で検索できます。</p></div>
      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
      <div className="search-row">
        <div style={{ position: 'relative', flex: 1 }}><Search size={18} style={{ position: 'absolute', left: 12, top: 13, color: '#6b756d' }} /><input style={{ paddingLeft: 38 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="検索" /></div>
        <button className="secondary-button" type="button" onClick={exportCsv} disabled={filtered.length === 0} title="CSV出力"><Download size={19} /><span>CSV</span></button>
      </div>
      <div className="shipment-list">
        {filtered.map((shipment) => (
          <article className="shipment-item" key={shipment.id}>
            <div className="shipment-head">
              <div>
                <div className="shipment-title-line">
                  <strong>{shipment.flexcon_destinations?.name ?? '納品先不明'}</strong>
                  <span>{shipmentProductSummary(shipment)}</span>
                </div>
                <small>{new Date(shipment.shipped_at).toLocaleString('ja-JP')}</small>
                <small><UserRound size={13} className="inline-icon" />担当：{shipment.workers?.worker_name ?? '不明'}</small>
                {shipment.carrier_name && <small><Building2 size={13} className="inline-icon" />{shipment.carrier_name} / {shipment.driver_name ?? 'ドライバー不明'}</small>}
                {shipment.vehicle_no && <small><Truck size={13} className="inline-icon" />{shipment.vehicle_no}</small>}
                {shipment.purchase_price_per_bale != null && <small>仕入値：{shipment.purchase_price_per_bale.toLocaleString('ja-JP')}円／俵</small>}
              </div>
              <div className="shipment-side">
                <span className="shipment-count">{shipment.quantity_count ?? shipment.flexcon_shipment_items.length}{shipment.shipment_kind === 'paper_bag' ? '袋' : '本'}</span>
                {isAdmin && (
                  <div className="shipment-admin-actions">
                    <button className="icon-button" type="button" title="出荷履歴を編集" aria-label="出荷履歴を編集" onClick={() => beginEdit(shipment)} disabled={busy}><Pencil size={18} /></button>
                    <button className="icon-button delete-icon" type="button" title="出荷履歴を削除" aria-label="出荷履歴を削除" onClick={() => void deleteShipment(shipment)} disabled={busy}><Trash2 size={18} /></button>
                  </div>
                )}
              </div>
            </div>
            {shipment.flexcon_shipment_items.length > 0 && <div className="lot-tags">{shipment.flexcon_shipment_items.map((item) => <span className="lot-tag" key={item.lot_number}>{item.lot_number}</span>)}</div>}
            {shipment.note && <p className="shipment-note">{shipment.note}</p>}
          </article>
        ))}
        {filtered.length === 0 && <div className="empty-state">該当する出荷履歴がありません</div>}
      </div>

      {editing && (
        <div className="modal-backdrop" role="presentation">
          <section className="registration-modal" role="dialog" aria-modal="true" aria-labelledby="history-edit-title">
            <div className="modal-header">
              <div><h2 id="history-edit-title">出荷履歴を編集</h2><p>{editing.quantity_count ?? editing.flexcon_shipment_items.length}{editing.shipment_kind === 'paper_bag' ? '袋' : '本'}の出荷情報</p></div>
              <button className="icon-button" type="button" title="閉じる" aria-label="編集画面を閉じる" onClick={() => setEditing(null)} disabled={busy}><X size={21} /></button>
            </div>

            {notice?.type === 'error' && <div className="notice error">{notice.text}</div>}

            <form className="form-grid" onSubmit={(event) => void saveEdit(event)}>
              {editing.shipment_kind === 'paper_bag' && (
                <div className="form-grid two">
                  <label>県名
                    <select value={originPrefecture} onChange={(e) => { setOriginPrefecture(e.target.value); setProductName('') }} required>
                      <option value="">選択してください</option>
                      <option value="青森県">青森県</option>
                      <option value="岩手県">岩手県</option>
                    </select>
                  </label>
                  <label>銘柄
                    <select value={productName} onChange={(e) => setProductName(e.target.value)} required disabled={!originPrefecture}>
                      <option value="">{originPrefecture ? '選択してください' : '先に県名を選択'}</option>
                      {paperBagBrands.map((item) => <option key={item.id} value={item.name} disabled={!item.active}>{item.name}{item.active ? '' : '（無効）'}</option>)}
                    </select>
                  </label>
                  <label>紙袋数<input type="number" min="1" step="1" value={quantityCount} onChange={(e) => setQuantityCount(e.target.value)} required /></label>
                </div>
              )}
              {editing.shipment_kind === 'other_rice' && (
                <div className="form-grid two">
                  <label>種類
                    <select value={productName} onChange={(e) => setProductName(e.target.value)} required>
                      <option value="">選択してください</option>
                      {shipmentProducts.filter((item) => item.option_type === 'shipment_product').map((item) => <option key={item.id} value={item.name} disabled={!item.active}>{item.name}{item.active ? '' : '（無効）'}</option>)}
                    </select>
                  </label>
                  <label>フレコン本数<input type="number" min="1" step="1" value={quantityCount} onChange={(e) => setQuantityCount(e.target.value)} required /></label>
                </div>
              )}
              <div className="form-grid two">
                <label>出荷日時<input type="datetime-local" value={shippedAt} onChange={(e) => setShippedAt(e.target.value)} required /></label>
                <label>納品先
                  <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)} required>
                    <option value="">選択してください</option>
                    {destinations.map((item) => <option key={item.id} value={item.id} disabled={!item.active}>{item.name}{item.active ? '' : '（無効）'}</option>)}
                  </select>
                </label>
              </div>
              <label>運送会社
                <select value={transportProfileId} onChange={(e) => setTransportProfileId(e.target.value)} required>
                  <option value="">選択してください</option>
                  {transportProfiles.map((item) => <option key={item.id} value={item.id} disabled={!item.active}>{item.company_name}{item.active ? '' : '（無効）'}</option>)}
                </select>
              </label>
              <fieldset className="driver-vehicle-fields">
                <legend>ドライバー・車両情報</legend>
                <div className="form-grid two">
                  <label>ドライバー名<input value={driverName} onChange={(e) => setDriverName(e.target.value)} required /></label>
                  <label>車両番号<input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} required /></label>
                </div>
              </fieldset>
              <label>仕入値（任意・1俵当たり）<input type="number" min="0" step="0.01" inputMode="decimal" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} /></label>
              <label>備考（任意）<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <div className="modal-actions">
                <button className="secondary-button" type="button" onClick={() => setEditing(null)} disabled={busy}>取消</button>
                <button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : '変更を保存'}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}
