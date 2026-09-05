import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Package, Plus, Send, Trash2, UserRound, Wheat, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Destination, InspectionOption, TransportProfile } from '../types'

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
  purchasePrice: string
}

type ManualShipmentKind = 'paper_bag' | 'other_rice'

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
    purchasePrice: '',
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
      purchasePrice: typeof draft.purchasePrice === 'string' ? draft.purchasePrice : '',
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
  const [shipmentProducts, setShipmentProducts] = useState<InspectionOption[]>([])
  const [authorizationNames, setAuthorizationNames] = useState<Record<string, string>>({})
  const [inspectionLotDetails, setInspectionLotDetails] = useState<Record<string, InspectionLotDetails>>({})
  const [shippedAt, setShippedAt] = useState(initialDraft.shippedAt)
  const [destinationId, setDestinationId] = useState(initialDraft.destinationId)
  const [transportProfileId, setTransportProfileId] = useState(initialDraft.transportProfileId)
  const [driverName, setDriverName] = useState(initialDraft.driverName)
  const [vehicleNo, setVehicleNo] = useState(initialDraft.vehicleNo)
  const [note, setNote] = useState(initialDraft.note)
  const [purchasePrice, setPurchasePrice] = useState(initialDraft.purchasePrice)
  const [plannedCount, setPlannedCount] = useState(initialDraft.plannedCount)
  const [lots, setLots] = useState<string[]>(initialDraft.lots)
  const [scannerActive, setScannerActive] = useState(false)
  const [registrationOpen, setRegistrationOpen] = useState(false)
  const [manualShipmentKind, setManualShipmentKind] = useState<ManualShipmentKind | null>(null)
  const [manualCount, setManualCount] = useState('1')
  const [manualProduct, setManualProduct] = useState('')
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
      supabase.from('flexcon_inspection_options').select('*').eq('option_type', 'shipment_product').eq('active', true).order('sort_order').order('name'),
    ]).then(([destinationResult, transportResult, authorizationResult, flexconResult, productResult]) => {
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
      if (!productResult.error) setShipmentProducts((productResult.data ?? []) as InspectionOption[])
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
      purchasePrice,
    }
    localStorage.setItem(storageKey, JSON.stringify(draft))
  }, [destinationId, driverName, lots, note, plannedCount, purchasePrice, shippedAt, storageKey, transportProfileId, vehicleNo])

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
    const price = purchasePrice.trim() === '' ? null : Number(purchasePrice)
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      return setNotice({ type: 'error', text: '仕入値は0以上の数値で入力してください。' })
    }

    const quantity = Number(manualCount)
    if (manualShipmentKind && (!Number.isInteger(quantity) || quantity < 1)) {
      return setNotice({ type: 'error', text: manualShipmentKind === 'paper_bag' ? '紙袋数を1以上で入力してください。' : 'フレコン本数を1以上で入力してください。' })
    }
    if (manualShipmentKind === 'other_rice' && !manualProduct) {
      return setNotice({ type: 'error', text: '銘柄米以外の種類を選択してください。' })
    }
    if (!manualShipmentKind && lots.length === 0) {
      return setNotice({ type: 'error', text: 'ロット番号を1本以上読み取ってください。' })
    }

    setBusy(true)
    setNotice(null)
    const registeredCount = manualShipmentKind ? quantity : lots.length
    const commonValues = {
      p_worker_id: workerId,
      p_destination_id: destinationId,
      p_transport_profile_id: transportProfileId,
      p_shipped_at: new Date(shippedAt).toISOString(),
      p_driver_name: driverName.trim(),
      p_vehicle_no: vehicleNo.trim(),
      p_purchase_price_per_bale: price,
      p_note: note.trim() || null,
    }
    const { error } = manualShipmentKind
      ? await supabase.rpc('flexcon_register_manual_shipment', {
        ...commonValues,
        p_shipment_kind: manualShipmentKind,
        p_product_name: manualShipmentKind === 'paper_bag' ? '紙袋' : manualProduct,
        p_quantity_count: quantity,
      })
      : await supabase.rpc('flexcon_register_shipment', {
        ...commonValues,
        p_lot_numbers: lots,
      })

    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      if (!manualShipmentKind) setLots([])
      setDriverName('')
      setVehicleNo('')
      setNote('')
      setPurchasePrice('')
      setShippedAt(currentLocalDateTime())
      setRegistrationOpen(false)
      const unit = manualShipmentKind === 'paper_bag' ? '袋' : '本'
      setNotice({ type: 'success', text: `${registeredCount}${unit}の出荷を登録しました。` })
      setManualShipmentKind(null)
      setManualCount('1')
      setManualProduct('')
      onRegistered()
    }
    setBusy(false)
  }

  const clearLots = () => {
    if (!window.confirm('読み取り済みの一覧を消去しますか？')) return
    setLots([])
    setRegistrationOpen(false)
  }

  const openQrRegistration = () => {
    setManualShipmentKind(null)
    setScannerActive(false)
    setRegistrationOpen(true)
  }

  const openManualRegistration = (kind: ManualShipmentKind) => {
    if (kind === 'other_rice' && shipmentProducts.length === 0) {
      setNotice({ type: 'error', text: '銘柄米以外の種類が登録されていません。追加SQLを実行してマスタを確認してください。' })
      return
    }
    setManualShipmentKind(kind)
    setManualCount('1')
    setManualProduct('')
    setScannerActive(false)
    setRegistrationOpen(true)
  }

  const registrationCount = manualShipmentKind ? Number(manualCount) || 0 : lots.length
  const registrationUnit = manualShipmentKind === 'paper_bag' ? '袋' : '本'
  const registrationProduct = manualShipmentKind === 'paper_bag'
    ? '紙袋'
    : manualShipmentKind === 'other_rice'
      ? shipmentProducts.find((item) => item.name === manualProduct)?.name || '種類未選択'
      : shipmentBrandCounts.map(([brand, count]) => `${brand} ${count}本`).join('、')

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
          <button className="primary-button" type="button" disabled={lots.length !== plannedCount} onClick={openQrRegistration}><Send size={18} />出荷情報を入力</button>
        </div>
      </section>

      <div className="manual-shipment-actions">
        <button className="secondary-button" type="button" onClick={() => openManualRegistration('paper_bag')}><Package size={18} />紙袋出荷</button>
        <button className="secondary-button" type="button" onClick={() => openManualRegistration('other_rice')}><Wheat size={18} />銘柄米以外の出荷</button>
      </div>

      {registrationOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="registration-modal" role="dialog" aria-modal="true" aria-labelledby="registration-title">
            <div className="modal-header">
              <div><h2 id="registration-title">出荷情報を登録</h2></div>
              <button className="icon-button" type="button" title="閉じる" aria-label="登録画面を閉じる" onClick={() => setRegistrationOpen(false)} disabled={busy}><X size={21} /></button>
            </div>

            <div className="shipment-registration-summary" aria-label="出荷内容">
              <div><span>{manualShipmentKind === 'paper_bag' ? '紙袋数' : '出荷本数'}</span><strong>{registrationCount}{registrationUnit}</strong></div>
              <div><span>{manualShipmentKind ? '種類' : '銘柄'}</span><strong>{registrationProduct}</strong></div>
            </div>

            {notice?.type === 'error' && <div className="notice error">{notice.text}</div>}

            <form className="shipment-registration-form" onSubmit={(event) => void registerShipment(event)}>
              {manualShipmentKind === 'paper_bag' && (
                <label className="shipment-form-row"><span>紙袋数</span><input type="number" min="1" step="1" value={manualCount} onChange={(e) => setManualCount(e.target.value)} required /></label>
              )}
              {manualShipmentKind === 'other_rice' && (
                <>
                  <label className="shipment-form-row"><span>種類</span>
                    <select value={manualProduct} onChange={(e) => setManualProduct(e.target.value)} required>
                      <option value="">選択してください</option>
                      {shipmentProducts.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
                    </select>
                  </label>
                  <label className="shipment-form-row"><span>フレコン本数</span><input type="number" min="1" step="1" value={manualCount} onChange={(e) => setManualCount(e.target.value)} required /></label>
                </>
              )}
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
              <label className="shipment-form-row"><span>仕入値（任意・1俵当たり）</span><input type="number" min="0" step="0.01" inputMode="decimal" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} /></label>
              <label className="shipment-form-row"><span>備考（任意）</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="申し送りなど" /></label>
              <div className="modal-actions">
                <button className="secondary-button" type="button" onClick={() => setRegistrationOpen(false)} disabled={busy}>戻る</button>
                <button className="primary-button" type="submit" disabled={busy}><Send size={18} />{busy ? '登録中...' : `${registrationCount}${registrationUnit}を登録`}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}
