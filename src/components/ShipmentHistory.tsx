import { useEffect, useMemo, useState } from 'react'
import { Download, Search, Truck } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Shipment } from '../types'

export function ShipmentHistory({ refreshKey }: { refreshKey: number }) {
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void supabase.from('shipments').select('id, shipped_at, vehicle_no, note, destinations(name), shipment_items(lot_number)').order('shipped_at', { ascending: false }).limit(200)
      .then(({ data, error: queryError }) => {
        if (queryError) setError(queryError.message)
        else setShipments((data ?? []) as unknown as Shipment[])
      })
  }, [refreshKey])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return shipments
    return shipments.filter((item) => item.destinations?.name.toLowerCase().includes(term) || item.vehicle_no?.toLowerCase().includes(term) || item.shipment_items.some((detail) => detail.lot_number.includes(term)))
  }, [search, shipments])

  const exportCsv = () => {
    const rows = [['出荷日時', '納品先', '車両番号・便名', 'ロット番号', '備考']]
    filtered.forEach((shipment) => shipment.shipment_items.forEach((item) => rows.push([
      new Date(shipment.shipped_at).toLocaleString('ja-JP'), shipment.destinations?.name ?? '', shipment.vehicle_no ?? '', item.lot_number, shipment.note ?? '',
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
      <div className="page-heading"><h1>出荷履歴</h1><p>納品先、車両番号、6桁のロット番号で検索できます。</p></div>
      {error && <div className="notice error">{error}</div>}
      <div className="search-row">
        <div style={{ position: 'relative', flex: 1 }}><Search size={18} style={{ position: 'absolute', left: 12, top: 13, color: '#6b756d' }} /><input style={{ paddingLeft: 38 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="検索" /></div>
        <button className="secondary-button" type="button" onClick={exportCsv} disabled={filtered.length === 0} title="CSV出力"><Download size={19} /><span>CSV</span></button>
      </div>
      <div className="shipment-list">
        {filtered.map((shipment) => (
          <article className="shipment-item" key={shipment.id}>
            <div className="shipment-head">
              <div><strong>{shipment.destinations?.name ?? '納品先不明'}</strong><small>{new Date(shipment.shipped_at).toLocaleString('ja-JP')}</small>{shipment.vehicle_no && <small><Truck size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{shipment.vehicle_no}</small>}</div>
              <span className="shipment-count">{shipment.shipment_items.length}本</span>
            </div>
            <div className="lot-tags">{shipment.shipment_items.map((item) => <span className="lot-tag" key={item.lot_number}>{item.lot_number}</span>)}</div>
            {shipment.note && <p style={{ margin: '10px 0 0', color: '#667068', fontSize: 13 }}>{shipment.note}</p>}
          </article>
        ))}
        {filtered.length === 0 && <div className="empty-state">該当する出荷履歴がありません</div>}
      </div>
    </div>
  )
}
