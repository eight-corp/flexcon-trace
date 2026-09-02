import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Plus, Send, Trash2, Truck, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Destination, TransportProfile } from '../types'

const QrScanner = lazy(() => import('./QrScanner').then((module) => ({ default: module.QrScanner })))
const STORAGE_KEY_PREFIX = 'flexcon-pending-shipment'

type Props = { workerId: string; onRegistered: () => void }

function currentLocalDateTime() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

export function ShipmentScanner({ workerId, onRegistered }: Props) {
  const storageKey = `${STORAGE_KEY_PREFIX}-${workerId}`
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [transportProfiles, setTransportProfiles] = useState<TransportProfile[]>([])
  const [shippedAt, setShippedAt] = useState(currentLocalDateTime)
  const [destinationId, setDestinationId] = useState('')
  const [contactName, setContactName] = useState('')
  const [transportProfileId, setTransportProfileId] = useState('')
  const [note, setNote] = useState('')
  const [targetCount, setTargetCount] = useState(12)
  const [lots, setLots] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[] } catch { return [] }
  })
  const [scannerActive, setScannerActive] = useState(false)
  const [manualLot, setManualLot] = useState('')
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const lastRead = useRef({ value: '', time: 0 })

  useEffect(() => {
    void Promise.all([
      supabase.from('flexcon_destinations').select('*').eq('active', true).order('name'),
      supabase.from('flexcon_transport_profiles').select('*').eq('active', true).order('company_name').order('driver_name'),
    ]).then(([destinationResult, transportResult]) => {
      if (destinationResult.error) setNotice({ type: 'error', text: '納品先を取得できません。SupabaseのSQL設定を確認してください。' })
      else setDestinations((destinationResult.data ?? []) as Destination[])
      if (transportResult.error) setNotice({ type: 'error', text: '運送会社情報を取得できません。追加SQLを実行してください。' })
      else setTransportProfiles((transportResult.data ?? []) as TransportProfile[])
    })
  }, [workerId])

  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(lots)) }, [lots, storageKey])

  const selectedDestination = destinations.find((item) => item.id === destinationId)
  const selectedTransport = transportProfiles.find((item) => item.id === transportProfileId)
  const startScanner = useCallback(() => setScannerActive(true), [])
  const stopScanner = useCallback(() => setScannerActive(false), [])

  const changeDestination = (id: string) => {
    setDestinationId(id)
    setContactName(destinations.find((item) => item.id === id)?.contact_name ?? '')
  }

  const addLot = useCallback((rawValue: string) => {
    const value = rawValue.trim()
    const now = Date.now()
    if (lastRead.current.value === value && now - lastRead.current.time < 1800) return
    lastRead.current = { value, time: now }

    if (!/^\d{6}$/.test(value)) {
      setNotice({ type: 'error', text: `「${value.slice(0, 24)}」は6桁のロット番号ではありません。` })
      return
    }
    setLots((current) => {
      if (current.includes(value)) {
        setNotice({ type: 'warning', text: `${value} は読み取り済みです。` })
        return current
      }
      const next = [...current, value]
      setNotice({ type: 'success', text: `${value} を追加しました。` })
      navigator.vibrate?.(80)
      if (next.length >= targetCount) setScannerActive(false)
      return next
    })
  }, [targetCount])

  const addManual = () => {
    addLot(manualLot)
    setManualLot('')
  }

  const registerShipment = async () => {
    if (!shippedAt) return setNotice({ type: 'error', text: '出荷日時を入力してください。' })
    if (!destinationId) return setNotice({ type: 'error', text: '納品先を選択してください。' })
    if (!contactName.trim()) return setNotice({ type: 'error', text: '担当者を入力してください。' })
    if (!transportProfileId) return setNotice({ type: 'error', text: '運送会社情報を選択してください。' })
    if (lots.length === 0) return setNotice({ type: 'error', text: 'ロット番号を1本以上読み取ってください。' })
    const message = `${selectedDestination?.name ?? ''}へ${lots.length}本を、${selectedTransport?.company_name ?? ''}で出荷登録しますか？`
    if (!window.confirm(message)) return

    setBusy(true)
    setScannerActive(false)
    setNotice(null)
    const registeredCount = lots.length
    const { error } = await supabase.rpc('flexcon_register_shipment', {
      p_worker_id: workerId,
      p_destination_id: destinationId,
      p_transport_profile_id: transportProfileId,
      p_shipped_at: new Date(shippedAt).toISOString(),
      p_contact_name: contactName.trim(),
      p_lot_numbers: lots,
      p_note: note.trim() || null,
    })

    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setLots([])
      setNote('')
      setShippedAt(currentLocalDateTime())
      localStorage.removeItem(storageKey)
      setNotice({ type: 'success', text: `${registeredCount}本の出荷を登録しました。` })
      onRegistered()
    }
    setBusy(false)
  }

  return (
    <div>
      <div className="page-heading"><h1>出荷QR連続読取</h1><p>出荷情報を選択してから、フレコンのQRを順番に読み取ります。</p></div>

      <section className="section-band">
        <div className="form-grid two">
          <label>出荷日時<input type="datetime-local" value={shippedAt} onChange={(e) => setShippedAt(e.target.value)} required /></label>
          <label>納品先
            <select value={destinationId} onChange={(e) => changeDestination(e.target.value)} required>
              <option value="">選択してください</option>
              {destinations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>担当者<input value={contactName} onChange={(e) => setContactName(e.target.value)} required placeholder="納品先の担当者" /></label>
          <label>運送会社・ドライバー・車両
            <select value={transportProfileId} onChange={(e) => setTransportProfileId(e.target.value)} required>
              <option value="">選択してください</option>
              {transportProfiles.map((item) => <option key={item.id} value={item.id}>{item.company_name} / {item.driver_name} / {item.vehicle_no}</option>)}
            </select>
          </label>
        </div>
        {selectedTransport && <div className="transport-summary"><Truck size={18} /><span><strong>{selectedTransport.company_name}</strong>　{selectedTransport.driver_name}　{selectedTransport.vehicle_no}</span></div>}
      </section>

      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}

      <div className="scanner-layout">
        <section className="section-band">
          <Suspense fallback={<div className="scanner-frame"><div className="scanner-placeholder">カメラ機能を準備中...</div></div>}>
            <QrScanner active={scannerActive} onRead={addLot} onStart={startScanner} onStop={stopScanner} />
          </Suspense>
        </section>

        <section className="section-band">
          <div className="count-panel">
            <div className="count-display"><strong>{lots.length}</strong><span>/ {targetCount}本</span></div>
            <label className="target-control">目標本数
              <input type="number" min={1} max={24} value={targetCount} onChange={(e) => setTargetCount(Math.min(24, Math.max(1, Number(e.target.value) || 1)))} />
            </label>
          </div>

          {lots.length === 0 ? <div className="empty-state">まだ読み取られていません</div> : (
            <ul className="scan-list">
              {lots.map((lot, index) => (
                <li key={lot}>
                  <span className="sequence">{index + 1}</span><CheckCircle2 size={18} color="#236640" />
                  <span className="lot-number">{lot}</span>
                  <button className="icon-button" type="button" title="削除" aria-label={`${lot}を削除`} onClick={() => setLots((current) => current.filter((item) => item !== lot))}><X size={18} /></button>
                </li>
              ))}
            </ul>
          )}

          <div className="manual-entry">
            <input inputMode="numeric" maxLength={6} value={manualLot} onChange={(e) => setManualLot(e.target.value.replace(/\D/g, ''))} placeholder="6桁を手入力" onKeyDown={(e) => { if (e.key === 'Enter') addManual() }} />
            <button className="secondary-button" type="button" onClick={addManual}><Plus size={18} />追加</button>
          </div>
        </section>
      </div>

      <section className="section-band">
        <label>備考（任意）<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="申し送りなど" /></label>
        <div className="button-row" style={{ marginTop: 14 }}>
          <button className="secondary-button" type="button" disabled={lots.length === 0} onClick={() => { if (window.confirm('読み取り済みの一覧を消去しますか？')) setLots([]) }}><Trash2 size={18} />一覧を消去</button>
          <button className="primary-button" type="button" disabled={busy || lots.length === 0 || !shippedAt || !destinationId || !contactName.trim() || !transportProfileId} onClick={() => void registerShipment()}><Send size={18} />{busy ? '登録中...' : `${lots.length}本を一括登録`}</button>
        </div>
      </section>
    </div>
  )
}
