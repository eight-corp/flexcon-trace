import { useEffect, useMemo, useState } from 'react'
import { Building2, Download, Search, Truck, UserRound } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Shipment } from '../types'

export function ShipmentHistory({ refreshKey }: { refreshKey: number }) {
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void supabase.from('flexcon_shipments').select('id, shipped_at, contact_name, carrier_name, driver_name, vehicle_no, note, flexcon_destinations(name), flexcon_shipment_items(lot_number), workers(worker_name)').order('shipped_at', { ascending: false }).limit(200)
      .then(({ data, error: queryError }) => {
        if (queryError) setError(queryError.message)
        else setShipments((data ?? []) as unknown as Shipment[])
      })
  }, [refreshKey])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return shipments
    return shipments.filter((item) =>
      item.flexcon_destinations?.name.toLowerCase().includes(term)
      || item.contact_name?.toLowerCase().includes(term)
      || item.carrier_name?.toLowerCase().includes(term)
      || item.driver_name?.toLowerCase().includes(term)
      || item.vehicle_no?.toLowerCase().includes(term)
      || item.workers?.worker_name.toLowerCase().includes(term)
      || item.flexcon_shipment_items.some((detail) => detail.lot_number.includes(term)))
  }, [search, shipments])

  const exportCsv = () => {
    const rows = [['出荷日時', '納品先', '担当者', '運送会社名', 'ドライバー名', '車両番号', '登録作業者', 'QRコード', 'フレコン本数', '備考']]
    filtered.forEach((shipment) => shipment.flexcon_shipment_items.forEach((item) => rows.push([
      new Date(shipment.shipped_at).toLocaleString('ja-JP'),
      shipment.flexcon_destinations?.name ?? '',
      shipment.contact_name ?? '',
      shipment.carrier_name ?? '',
      shipment.driver_name ?? '',
      shipment.vehicle_no ?? '',
      shipment.workers?.worker_name ?? '',
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
      {error && <div className="notice error">{error}</div>}
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
                <small>{new Date(shipment.shipped_at).toLocaleString('ja-JP')} / 登録：{shipment.workers?.worker_name ?? '不明'}</small>
                {shipment.contact_name && <small><UserRound size={13} className="inline-icon" />担当：{shipment.contact_name}</small>}
                {shipment.carrier_name && <small><Building2 size={13} className="inline-icon" />{shipment.carrier_name} / {shipment.driver_name ?? 'ドライバー不明'}</small>}
                {shipment.vehicle_no && <small><Truck size={13} className="inline-icon" />{shipment.vehicle_no}</small>}
              </div>
              <span className="shipment-count">{shipment.flexcon_shipment_items.length}本</span>
            </div>
            <div className="lot-tags">{shipment.flexcon_shipment_items.map((item) => <span className="lot-tag" key={item.lot_number}>{item.lot_number}</span>)}</div>
            {shipment.note && <p className="shipment-note">{shipment.note}</p>}
          </article>
        ))}
        {filtered.length === 0 && <div className="empty-state">該当する出荷履歴がありません</div>}
      </div>
    </div>
  )
}
