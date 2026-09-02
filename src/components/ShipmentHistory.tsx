import { useEffect, useMemo, useState } from 'react'
import { Building2, Download, Pencil, Save, Search, Trash2, Truck, UserRound, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Destination, Shipment, TransportProfile } from '../types'

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

export function ShipmentHistory({ refreshKey, workerId, isAdmin }: Props) {
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [transportProfiles, setTransportProfiles] = useState<TransportProfile[]>([])
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
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void supabase.from('flexcon_shipments').select('id, destination_id, transport_profile_id, shipped_at, carrier_name, driver_name, vehicle_no, note, flexcon_destinations(name), flexcon_shipment_items(lot_number), workers(worker_name)').order('shipped_at', { ascending: false }).limit(200)
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
    ]).then(([destinationResult, transportResult]) => {
      if (destinationResult.error) setNotice({ type: 'error', text: destinationResult.error.message })
      else setDestinations((destinationResult.data ?? []) as Destination[])
      if (transportResult.error) setNotice({ type: 'error', text: transportResult.error.message })
      else setTransportProfiles((transportResult.data ?? []) as TransportProfile[])
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
    const message = `${destination}への${shipment.flexcon_shipment_items.length}本の出荷履歴を削除しますか？\n対象のQRコードは未出荷状態へ戻ります。`
    if (!window.confirm(message)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_shipment', {
      p_worker_id: workerId,
      p_shipment_id: shipment.id,
    })
    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setNotice({ type: 'success', text: '出荷履歴を削除し、対象QRを未出荷へ戻しました。' })
      setLocalVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const exportCsv = () => {
    const rows = [['出荷日時', '納品先', '担当者', '運送会社名', 'ドライバー名', '車両番号', 'QRコード', 'フレコン本数', '備考']]
    filtered.forEach((shipment) => shipment.flexcon_shipment_items.forEach((item) => rows.push([
      new Date(shipment.shipped_at).toLocaleString('ja-JP'),
      shipment.flexcon_destinations?.name ?? '',
      shipment.workers?.worker_name ?? '',
      shipment.carrier_name ?? '',
      shipment.driver_name ?? '',
      shipment.vehicle_no ?? '',
      item.lot_number,
      String(shipment.flexcon_shipment_items.length),
      shipment.note ?? '',
    ])))
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
    const csv = '\uFEFF' + rows.map((row) => row.map(quote).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `出荷履歴_${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

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
                <strong>{shipment.flexcon_destinations?.name ?? '納品先不明'}</strong>
                <small>{new Date(shipment.shipped_at).toLocaleString('ja-JP')}</small>
                <small><UserRound size={13} className="inline-icon" />担当：{shipment.workers?.worker_name ?? '不明'}</small>
                {shipment.carrier_name && <small><Building2 size={13} className="inline-icon" />{shipment.carrier_name} / {shipment.driver_name ?? 'ドライバー不明'}</small>}
                {shipment.vehicle_no && <small><Truck size={13} className="inline-icon" />{shipment.vehicle_no}</small>}
              </div>
              <div className="shipment-side">
                <span className="shipment-count">{shipment.flexcon_shipment_items.length}本</span>
                {isAdmin && (
                  <div className="shipment-admin-actions">
                    <button className="icon-button" type="button" title="出荷履歴を編集" aria-label="出荷履歴を編集" onClick={() => beginEdit(shipment)} disabled={busy}><Pencil size={18} /></button>
                    <button className="icon-button delete-icon" type="button" title="出荷履歴を削除" aria-label="出荷履歴を削除" onClick={() => void deleteShipment(shipment)} disabled={busy}><Trash2 size={18} /></button>
                  </div>
                )}
              </div>
            </div>
            <div className="lot-tags">{shipment.flexcon_shipment_items.map((item) => <span className="lot-tag" key={item.lot_number}>{item.lot_number}</span>)}</div>
            {shipment.note && <p className="shipment-note">{shipment.note}</p>}
          </article>
        ))}
        {filtered.length === 0 && <div className="empty-state">該当する出荷履歴がありません</div>}
      </div>

      {editing && (
        <div className="modal-backdrop" role="presentation">
          <section className="registration-modal" role="dialog" aria-modal="true" aria-labelledby="history-edit-title">
            <div className="modal-header">
              <div><h2 id="history-edit-title">出荷履歴を編集</h2><p>{editing.flexcon_shipment_items.length}本の出荷情報</p></div>
              <button className="icon-button" type="button" title="閉じる" aria-label="編集画面を閉じる" onClick={() => setEditing(null)} disabled={busy}><X size={21} /></button>
            </div>

            {notice?.type === 'error' && <div className="notice error">{notice.text}</div>}

            <form className="form-grid" onSubmit={(event) => void saveEdit(event)}>
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
