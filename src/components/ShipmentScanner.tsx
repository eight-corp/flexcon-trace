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

type ShipmentDraft = {
  lots: string[]
  plannedCount: number
  shippedAt: string
  destinationId: string
  transportProfileId: string
  driverName: string
  vehicleNo: string
  note: string
}

type InspectionLotDetails = {
  origin: string
  brand: string
}

function currentLocalDateTime() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function loadShipmentDraft(storageKey: string): ShipmentDraft {
  const emptyDraft: ShipmentDraft = {
    lots: [],
    plannedCount: 12,
    shippedAt: currentLocalDateTime(),
    destinationId: '',
    transportProfileId: '',
    driverName: '',
    vehicleNo: '',
    note: '',
  }

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as unknown
    if (Array.isArray(saved)) {
      return {
        ...emptyDraft,
        lots: saved.filter((value): value is string => typeof value === 'string'),
      }
    }
    if (!saved || typeof saved !== 'object') return emptyDraft

    const draft = saved as Partial<ShipmentDraft>
    const lots = Array.isArray(draft.lots)
      ? draft.lots.filter((value): value is string => typeof value === 'string')
      : []
    const plannedCount = typeof draft.plannedCount === 'number'
      ? Math.min(24, Math.max(1, draft.plannedCount, lots.length))
      : Math.max(12, lots.length)

    return {
      lots,
      plannedCount,
      shippedAt: typeof draft.shippedAt === 'string' && draft.shippedAt ? draft.shippedAt : emptyDraft.shippedAt,
      destinationId: typeof draft.destinationId === 'string' ? draft.destinationId : '',
      transportProfileId: typeof draft.transportProfileId === 'string' ? draft.transportProfileId : '',
      driverName: typeof draft.driverName === 'string' ? draft.driverName : '',
      vehicleNo: typeof draft.vehicleNo === 'string' ? draft.vehicleNo : '',
      note: typeof draft.note === 'string' ? draft.note : '',
    }
  } catch {
    return emptyDraft
  }
}

function normalizeAuthorizationNo(value: string) {
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed
}

function authorizationNoFromLot(lotNumber: string) {
  const authorizationDigits = lotNumber.length === 11
    ? lotNumber.slice(4, 8)
    : lotNumber.length === 7
      ? lotNumber.slice(0, 4)
      : lotNumber.slice(0, 3)
  return normalizeAuthorizationNo(authorizationDigits)
}

export function ShipmentScanner({ workerId, workerName, onRegistered }: Props) {
  const storageKey = `${STORAGE_KEY_PREFIX}-${workerId}`
  const [initialDraft] = useState(() => loadShipmentDraft(storageKey))
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [transportProfiles, setTransportProfiles] = useState<TransportProfile[]>([])
  const [authorizationNames, setAuthorizationNames] = useState<Record<string, string>>({})
  const [inspectionLotDetails, setInspectionLotDetails] = useState<Record<string, InspectionLotDetails>>({})
  const [shippedAt, setShippedAt] = useState(initialDraft.shippedAt)
  const [destinationId, setDestinationId] = useState(initialDraft.destinationId)
  const [transportProfileId, setTransportProfileId] = useState(initialDraft.transportProfileId)
  const [driverName, setDriverName] = useState(initialDraft.driverName)
  const [vehicleNo, setVehicleNo] = useState(initialDraft.vehicleNo)
  const [note, setNote] = useState(initialDraft.note)
  const [plannedCount, setPlannedCount] = useState(initialDraft.plannedCount)
  const [lots, setLots] = useState<string[]>(initialDraft.lots)
  const [scannerActive, setScannerActive] = useState(false)
  const [registrationOpen, setRegistrationOpen] = useState(false)
  const [manualLot, setManualLot] = useState('')
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const lastRead = useRef({ value: '', time: 0 })
  const shipmentBrandCounts = Object.entries(lots.reduce<Record<string, number>>((counts, lot) => {
    const brand = inspectionLotDetails[lot]?.brand.trim() || '銘柄未登録'
    counts[brand] = (counts[brand] ?? 0) + 1
    return counts
  }, {}))

  useEffect(() => {
    void Promise.all([
      supabase.from('flexcon_destinations').select('*').eq('active', true).order('name'),
      supabase.from('flexcon_transport_profiles').select('*').eq('active', true).order('company_name'),
      supabase.from('flexcon_authorizations').select('id, authorization_no, full_name, prefecture, municipality'),
      supabase.from('flexcon_inspection_flexcons').select('authorization_id, lot_number, brand'),
    ]).then(([destinationResult, transportResult, authorizationResult, flexconResult]) => {
      if (destinationResult.error) setNotice({ type: 'error', text: '納品先を取得できません。SupabaseのSQL設定を確認してください。' })
      else setDestinations((destinationResult.data ?? []) as Destination[])
      if (transportResult.error) setNotice({ type: 'error', text: '運送会社を取得できません。追加SQLを実行してください。' })
      else setTransportProfiles((transportResult.data ?? []) as TransportProfile[])
      if (authorizationResult.error) {
        setNotice({ type: 'error', text: '委任状一覧を取得できません。SupabaseのSQL設定を確認してください。' })
      } else {
        const names = Object.fromEntries((authorizationResult.data ?? []).map((record) => [
          normalizeAuthorizationNo(String(record.authorization_no)),
          String(record.full_name),
        ]))
        setAuthorizationNames(names)
      }
      if (flexconResult.error) {
        setNotice({ type: 'error', text: '検査記録を取得できません。追加SQLを実行してください。' })
      } else {
        const details: Record<string, InspectionLotDetails> = {}
        const authorizationById = Object.fromEntries((authorizationResult.data ?? []).map((record) => [record.id, record]))
        for (const flexcon of flexconResult.data ?? []) {
          const authorization = authorizationById[flexcon.authorization_id]
          if (!authorization) continue
          const origin = [authorization.prefecture, authorization.municipality]
            .map((value) => String(value ?? '').trim())
            .filter(Boolean)
            .join(' ')
          const detail = {
            origin: origin || '産地未登録',
            brand: String(flexcon.brand ?? '').trim() || '銘柄未登録',
          }
          details[flexcon.lot_number] = detail
          if (/^\d{11}$/.test(flexcon.lot_number)) {
            const sevenDigitLot = flexcon.lot_number.slice(4)
            details[sevenDigitLot] = detail
            if (sevenDigitLot.startsWith('0')) details[sevenDigitLot.slice(1)] = detail
          } else if (/^0\d{6}$/.test(flexcon.lot_number)) {
            details[flexcon.lot_number.slice(1)] = detail
          }
        }
        setInspectionLotDetails(details)
      }
    })
  }, [workerId])

  useEffect(() => {
    const draft: ShipmentDraft = {
      lots,
      plannedCount,
      shippedAt,
      destinationId,
      transportProfileId,
      driverName,
      vehicleNo,
      note,
    }
    localStorage.setItem(storageKey, JSON.stringify(draft))
  }, [destinationId, driverName, lots, note, plannedCount, shippedAt, storageKey, transportProfileId, vehicleNo])

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

    if (!/^\d{11}$/.test(value) && !/^\d{7}$/.test(value) && !/^\d{6}$/.test(value)) {
      setNotice({ type: 'error', text: `「${value.slice(0, 24)}」は11桁のロット番号ではありません。` })
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
      <div className="page-heading"><h1>出荷作業</h1><p>予定本数を読み取ったら「出荷情報を入力」をタップします。</p></div>

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
                <div className="lot-information">
                  <span className={`lot-producer-name ${authorizationNames[authorizationNoFromLot(lot)] ? '' : 'unknown'}`} title="生産者">
                    {authorizationNames[authorizationNoFromLot(lot)] ?? '委任状未登録'}
                  </span>
                  <span className={`lot-origin ${inspectionLotDetails[lot] ? '' : 'unknown'}`} title="産地">
                    {inspectionLotDetails[lot]?.origin ?? '検査記録未登録'}
                  </span>
                  <span className={`lot-brand ${inspectionLotDetails[lot] ? '' : 'unknown'}`} title="銘柄">
                    {inspectionLotDetails[lot]?.brand ?? '検査記録未登録'}
                  </span>
                </div>
                <span className="lot-number">{lot}</span>
                <button className="icon-button" type="button" title="削除" aria-label={`${lot}を削除`} onClick={() => setLots((current) => current.filter((item) => item !== lot))}><X size={18} /></button>
              </li>
            ))}
          </ul>
        )}

        <div className="manual-entry">
          <input inputMode="numeric" maxLength={11} value={manualLot} onChange={(e) => setManualLot(e.target.value.replace(/\D/g, ''))} placeholder="11桁を手入力" onKeyDown={(e) => { if (e.key === 'Enter') addManual() }} />
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
              <div><h2 id="registration-title">出荷情報を登録</h2></div>
              <button className="icon-button" type="button" title="閉じる" aria-label="登録画面を閉じる" onClick={() => setRegistrationOpen(false)} disabled={busy}><X size={21} /></button>
            </div>

            <div className="shipment-registration-summary" aria-label="出荷内容">
              <div><span>出荷本数</span><strong>{lots.length}本</strong></div>
              <div><span>銘柄</span><strong>{shipmentBrandCounts.map(([brand, count]) => `${brand} ${count}本`).join('、')}</strong></div>
            </div>

            {notice?.type === 'error' && <div className="notice error">{notice.text}</div>}

            <form className="shipment-registration-form" onSubmit={(event) => void registerShipment(event)}>
              <div className="shipment-form-row worker-summary">
                <span className="worker-summary-label"><UserRound size={18} />担当者</span>
                <strong>{workerName}</strong>
              </div>
              <label className="shipment-form-row"><span>出荷日時</span><input type="datetime-local" value={shippedAt} onChange={(e) => setShippedAt(e.target.value)} required /></label>
              <label className="shipment-form-row"><span>納品先</span>
                <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)} required>
                  <option value="">選択してください</option>
                  {destinations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label className="shipment-form-row"><span>運送会社</span>
                <select value={transportProfileId} onChange={(e) => setTransportProfileId(e.target.value)} required>
                  <option value="">選択してください</option>
                  {transportProfiles.map((item) => <option key={item.id} value={item.id}>{item.company_name}</option>)}
                </select>
              </label>
              <label className="shipment-form-row"><span>ドライバー名</span><input value={driverName} onChange={(e) => setDriverName(e.target.value)} required /></label>
              <label className="shipment-form-row"><span>車両番号</span><input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} required placeholder="例：岩手 100 あ 12-34" /></label>
              <label className="shipment-form-row"><span>備考（任意）</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="申し送りなど" /></label>
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
