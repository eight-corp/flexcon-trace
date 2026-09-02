import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Plus, Send, Trash2, UserRound, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Destination, TransportProfile } from '../types'

const QrScanner = lazy(() => import('./QrScanner').then((module) => ({ default: module.QrScanner })))
const STORAGE_KEY_PREFIX = 'flexcon-pending-shipment'

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

export function ShipmentScanner({ workerId, workerName, onRegistered }: Props) {
  const storageKey = `${STORAGE_KEY_PREFIX}-${workerId}`
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [transportProfiles, setTransportProfiles] = useState<TransportProfile[]>([])
  const [shippedAt, setShippedAt] = useState(currentLocalDateTime)
  const [destinationId, setDestinationId] = useState('')
  const [transportProfileId, setTransportProfileId] = useState('')
  const [driverName, setDriverName] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [note, setNote] = useState('')
  const [plannedCount, setPlannedCount] = useState(12)
  const [lots, setLots] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[] } catch { return [] }
  })
  const [scannerActive, setScannerActive] = useState(false)
  const [registrationOpen, setRegistrationOpen] = useState(false)
  const [manualLot, setManualLot] = useState('')
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const lastRead = useRef({ value: '', time: 0 })

  useEffect(() => {
    void Promise.all([
      supabase.from('flexcon_destinations').select('*').eq('active', true).order('name'),
      supabase.from('flexcon_transport_profiles').select('*').eq('active', true).order('company_name'),
    ]).then(([destinationResult, transportResult]) => {
      if (destinationResult.error) setNotice({ type: 'error', text: '納品先を取得できません。SupabaseのSQL設定を確認してください。' })
      else setDestinations((destinationResult.data ?? []) as Destination[])
      if (transportResult.error) setNotice({ type: 'error', text: '運送会社を取得できません。追加SQLを実行してください。' })
      else setTransportProfiles((transportResult.data ?? []) as TransportProfile[])
    })
  }, [workerId])

  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(lots)) }, [lots, storageKey])

  const startScanner = useCallback(() => setScannerActive(true), [])
  const stopScanner = useCallback(() => setScannerActive(false), [])

  const changePlannedCount = (value: number) => {
    const minimumCount = Math.max(1, lots.length)
    const nextCount = Math.min(24, Math.max(minimumCount, value || minimumCount))
    setPlannedCount(nextCount)
    if (lots.length > 0 && lots.length >= nextCount) {
      setScannerActive(false)
    }
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
      if (current.length >= plannedCount) return current
      if (current.includes(value)) {
        setNotice({ type: 'warning', text: `${value} は読み取り済みです。` })
        return current
      }
      const next = [...current, value]
      setNotice({
        type: 'success',
        text: next.length >= plannedCount
          ? `予定本数${plannedCount}本の読み取りが完了しました。「出荷情報を入力」をタップしてください。`
          : `${value} を追加しました。`,
      })
      navigator.vibrate?.(80)
      if (next.length >= plannedCount) {
        window.setTimeout(() => setScannerActive(false), 0)
      }
      return next
    })
  }, [plannedCount])

  const addManual = () => {
    addLot(manualLot)
    setManualLot('')
  }

  const registerShipment = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!shippedAt) return setNotice({ type: 'error', text: '出荷日時を入力してください。' })
    if (!destinationId) return setNotice({ type: 'error', text: '納品先を選択してください。' })
    if (!transportProfileId) return setNotice({ type: 'error', text: '運送会社を選択してください。' })
    if (!driverName.trim()) return setNotice({ type: 'error', text: 'ドライバー名を入力してください。' })
    if (!vehicleNo.trim()) return setNotice({ type: 'error', text: '車両番号を入力してください。' })
    if (lots.length === 0) return setNotice({ type: 'error', text: 'ロット番号を1本以上読み取ってください。' })

    setBusy(true)
    setNotice(null)
    const registeredCount = lots.length
    const { error } = await supabase.rpc('flexcon_register_shipment', {
      p_worker_id: workerId,
      p_destination_id: destinationId,
      p_transport_profile_id: transportProfileId,
      p_shipped_at: new Date(shippedAt).toISOString(),
      p_driver_name: driverName.trim(),
      p_vehicle_no: vehicleNo.trim(),
      p_lot_numbers: lots,
      p_note: note.trim() || null,
    })

    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setLots([])
      setDriverName('')
      setVehicleNo('')
      setNote('')
      setShippedAt(currentLocalDateTime())
      setRegistrationOpen(false)
      localStorage.removeItem(storageKey)
      setNotice({ type: 'success', text: `${registeredCount}本の出荷を登録しました。` })
      onRegistered()
    }
    setBusy(false)
  }

  const clearLots = () => {
    if (!window.confirm('読み取り済みの一覧を消去しますか？')) return
    setLots([])
    setRegistrationOpen(false)
  }

  return (
    <div>
      <div className="page-heading"><h1>出荷QR連続読取</h1><p>予定本数を読み取ったら「出荷情報を入力」をタップします。</p></div>

      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}

      <section className="section-band scanner-top">
        <Suspense fallback={<div className="scanner-frame"><div className="scanner-placeholder">カメラ機能を準備中...</div></div>}>
          <QrScanner active={scannerActive} onRead={addLot} onStart={startScanner} onStop={stopScanner} />
        </Suspense>
      </section>

      <section className="section-band">
        <div className="count-panel">
          <div className="count-display"><strong>{lots.length}</strong><span>/ {plannedCount}本</span></div>
          <label className="target-control">予定本数
            <input type="number" min={Math.max(1, lots.length)} max={24} value={plannedCount} onChange={(e) => changePlannedCount(Number(e.target.value))} />
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

        <div className="button-row scan-actions">
          <button className="secondary-button" type="button" disabled={lots.length === 0} onClick={clearLots}><Trash2 size={18} />一覧を消去</button>
          <button className="primary-button" type="button" disabled={lots.length !== plannedCount} onClick={() => { setScannerActive(false); setRegistrationOpen(true) }}><Send size={18} />出荷情報を入力</button>
        </div>
      </section>

      {registrationOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="registration-modal" role="dialog" aria-modal="true" aria-labelledby="registration-title">
            <div className="modal-header">
              <div><h2 id="registration-title">出荷情報を登録</h2><p>{lots.length}本のQRコードを読み取り済み</p></div>
              <button className="icon-button" type="button" title="閉じる" aria-label="登録画面を閉じる" onClick={() => setRegistrationOpen(false)} disabled={busy}><X size={21} /></button>
            </div>

            {notice?.type === 'error' && <div className="notice error">{notice.text}</div>}

            <form className="form-grid" onSubmit={(event) => void registerShipment(event)}>
              <div className="worker-summary"><UserRound size={18} /><span>担当者</span><strong>{workerName}</strong></div>
              <div className="form-grid two">
                <label>出荷日時<input type="datetime-local" value={shippedAt} onChange={(e) => setShippedAt(e.target.value)} required /></label>
                <label>納品先
                  <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)} required>
                    <option value="">選択してください</option>
                    {destinations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
              </div>
              <label>運送会社
                <select value={transportProfileId} onChange={(e) => setTransportProfileId(e.target.value)} required>
                  <option value="">選択してください</option>
                  {transportProfiles.map((item) => <option key={item.id} value={item.id}>{item.company_name}</option>)}
                </select>
              </label>
              <fieldset className="driver-vehicle-fields">
                <legend>ドライバー・車両情報</legend>
                <div className="form-grid two">
                  <label>ドライバー名<input value={driverName} onChange={(e) => setDriverName(e.target.value)} required /></label>
                  <label>車両番号<input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} required placeholder="例：岩手 100 あ 12-34" /></label>
                </div>
              </fieldset>
              <label>備考（任意）<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="申し送りなど" /></label>
              <div className="modal-actions">
                <button className="secondary-button" type="button" onClick={() => setRegistrationOpen(false)} disabled={busy}>戻る</button>
                <button className="primary-button" type="submit" disabled={busy}><Send size={18} />{busy ? '登録中...' : `${lots.length}本を登録`}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}
