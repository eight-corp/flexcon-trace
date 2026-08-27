import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Plus, Send, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Destination } from '../types'

const QrScanner = lazy(() => import('./QrScanner').then((module) => ({ default: module.QrScanner })))

const STORAGE_KEY_PREFIX = 'flexcon-pending-shipment'

type Props = { userId: string; onRegistered: () => void }

export function ShipmentScanner({ userId, onRegistered }: Props) {
  const storageKey = `${STORAGE_KEY_PREFIX}-${userId}`
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [destinationId, setDestinationId] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
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
    void supabase.from('destinations').select('*').eq('active', true).order('name').then(({ data, error }) => {
      if (error) setNotice({ type: 'error', text: '納品先を取得できません。SupabaseのSQL設定を確認してください。' })
      else setDestinations((data ?? []) as Destination[])
    })
  }, [userId])

  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(lots)) }, [lots, storageKey])

  const startScanner = useCallback(() => setScannerActive(true), [])
  const stopScanner = useCallback(() => setScannerActive(false), [])

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
    if (!destinationId) return setNotice({ type: 'error', text: '納品先を選択してください。' })
    if (lots.length === 0) return setNotice({ type: 'error', text: 'ロット番号を1本以上読み取ってください。' })
    if (!window.confirm(`${lots.length}本をまとめて出荷登録しますか？`)) return

    setBusy(true)
    setScannerActive(false)
    setNotice(null)
    const registeredCount = lots.length
    const { error } = await supabase.rpc('register_shipment', {
      p_destination_id: destinationId,
      p_lot_numbers: lots,
      p_vehicle_no: vehicleNo.trim() || null,
      p_note: note.trim() || null,
    })

    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setLots([])
      setVehicleNo('')
      setNote('')
      localStorage.removeItem(storageKey)
      setNotice({ type: 'success', text: `${registeredCount}本の出荷を登録しました。` })
      onRegistered()
    }
    setBusy(false)
  }

  return (
    <div>
      <div className="page-heading"><h1>出荷QR連続読取</h1><p>納品先を選択してから、フレコンのQRを順番に読み取ります。</p></div>

      <section className="section-band">
        <div className="form-grid two">
          <label>納品先
            <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
              <option value="">選択してください</option>
              {destinations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>車両番号・便名（任意）
            <input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} placeholder="例：青森 100 あ 12-34" />
          </label>
        </div>
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
        <label>備考（任意）<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="運送会社、担当者への申し送りなど" /></label>
        <div className="button-row" style={{ marginTop: 14 }}>
          <button className="secondary-button" type="button" disabled={lots.length === 0} onClick={() => { if (window.confirm('読み取り済みの一覧を消去しますか？')) setLots([]) }}><Trash2 size={18} />一覧を消去</button>
          <button className="primary-button" type="button" disabled={busy || lots.length === 0 || !destinationId} onClick={() => void registerShipment()}><Send size={18} />{busy ? '登録中...' : `${lots.length}本を一括登録`}</button>
        </div>
      </section>
    </div>
  )
}
