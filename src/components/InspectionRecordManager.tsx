import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CalendarPlus, FileSpreadsheet, PackageOpen, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { AuthorizationRecord, FlexconInspection, InspectionOption, InspectionWeight, PaperBagInspection, ProducerInspectionBatch } from '../types'

type Props = {
  workerId: string
  selectedAuthorizationId: string | null
  onSelectedAuthorizationChange: (authorizationId: string | null) => void
}
type Notice = { type: 'success' | 'error'; text: string } | null
type DetailKind = 'flexcon' | 'paper'
type BatchForm = { purchase_date: string; fiscal_year: string; inspection_date: string; inspection_location: string; brand: string }
type DetailForm = { flexcon_no: string; quantity: string; grade: string; reason: string; moisture_values: string[] }

const MOISTURE_COUNT = 100
const DEFAULT_BRANDED_RICE_WEIGHT = 1020
const DEFAULT_FEED_RICE_WEIGHT = 1000
const AUTHORIZATION_NO_COLLATOR = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })

function currentFiscalYear() { return new Date().getFullYear() - 2018 }
function today() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}
function emptyMoistureValues() { return Array.from({ length: MOISTURE_COUNT }, () => '') }
function moistureFormValues(values: (number | null)[]) {
  return Array.from({ length: MOISTURE_COUNT }, (_, index) => values[index] === null || values[index] === undefined ? '' : String(values[index]))
}
function emptyBatchForm(): BatchForm {
  return { purchase_date: today(), fiscal_year: String(currentFiscalYear()), inspection_date: '', inspection_location: '', brand: '' }
}
function formFromBatch(batch: ProducerInspectionBatch): BatchForm {
  return { purchase_date: batch.purchase_date, fiscal_year: String(batch.fiscal_year), inspection_date: batch.inspection_date ?? '', inspection_location: batch.inspection_location ?? '', brand: batch.brand ?? '' }
}
function emptyDetailForm(flexconNo: number, quantity: number): DetailForm {
  return { flexcon_no: String(flexconNo), quantity: String(quantity), grade: '', reason: '', moisture_values: emptyMoistureValues() }
}
function averageMoisture(values: string[]) {
  const measured = values.filter((value) => value.trim() !== '').map(Number).filter(Number.isFinite)
  if (measured.length === 0) return ''
  return (Math.round((measured.reduce((total, value) => total + value, 0) / measured.length) * 10) / 10).toFixed(1)
}
function isHighMoisture(value: string | number | null | undefined) {
  return value !== null && value !== undefined && value !== '' && Number(value) > 16
}
function displayDate(value: string | null | undefined) { return value ? value.replaceAll('-', '/') : '' }
function brandTypeForPrefecture(prefecture: string | null): 'brand_aomori' | 'brand_iwate' | null {
  const normalized = (prefecture ?? '').trim().replace(/県$/, '')
  if (normalized === '青森') return 'brand_aomori'
  if (normalized === '岩手') return 'brand_iwate'
  return null
}
function csvValue(value: string | number) { return `"${String(value).replaceAll('"', '""')}"` }

export function InspectionRecordManager({ workerId, selectedAuthorizationId, onSelectedAuthorizationChange }: Props) {
  const [authorizations, setAuthorizations] = useState<AuthorizationRecord[]>([])
  const [batches, setBatches] = useState<ProducerInspectionBatch[]>([])
  const [flexcons, setFlexcons] = useState<FlexconInspection[]>([])
  const [paperBags, setPaperBags] = useState<PaperBagInspection[]>([])
  const [inspectionOptions, setInspectionOptions] = useState<InspectionOption[]>([])
  const [weights, setWeights] = useState<Record<InspectionWeight['weight_type'], number>>({ branded_rice: DEFAULT_BRANDED_RICE_WEIGHT, feed_rice: DEFAULT_FEED_RICE_WEIGHT })
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null)
  const [batchEditingId, setBatchEditingId] = useState<string | null>(null)
  const [batchForm, setBatchForm] = useState<BatchForm>(emptyBatchForm)
  const [detailKind, setDetailKind] = useState<DetailKind | null>(null)
  const [detailEditingId, setDetailEditingId] = useState<string | null>(null)
  const [detailForm, setDetailForm] = useState<DetailForm>(() => emptyDetailForm(1, DEFAULT_BRANDED_RICE_WEIGHT))
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const load = async () => {
      const [authorizationResult, batchResult, flexconResult, paperResult, optionResult, weightResult] = await Promise.all([
        supabase.from('flexcon_authorizations').select('*').order('authorization_no'),
        supabase.from('flexcon_inspection_batches').select('*').order('purchase_date', { ascending: false }),
        supabase.from('flexcon_inspection_flexcons').select('*').order('flexcon_no'),
        supabase.from('flexcon_inspection_paper_bags').select('*'),
        supabase.from('flexcon_inspection_options').select('*').eq('active', true).order('sort_order').order('name'),
        supabase.from('flexcon_inspection_weights').select('*'),
      ])
      if (batchResult.error || flexconResult.error || paperResult.error) {
        setNotice({ type: 'error', text: '新しい検査記録用SQLを実行してください。' })
        return
      }
      if (authorizationResult.error) {
        setNotice({ type: 'error', text: authorizationResult.error.message })
        return
      }
      setAuthorizations(((authorizationResult.data ?? []) as AuthorizationRecord[]).sort((left, right) => (
        AUTHORIZATION_NO_COLLATOR.compare(left.authorization_no, right.authorization_no)
      )))
      setBatches((batchResult.data ?? []) as ProducerInspectionBatch[])
      setFlexcons((flexconResult.data ?? []) as FlexconInspection[])
      setPaperBags((paperResult.data ?? []) as PaperBagInspection[])
      if (!optionResult.error) setInspectionOptions((optionResult.data ?? []) as InspectionOption[])
      if (!weightResult.error) {
        const loadedWeights = weightResult.data as InspectionWeight[]
        setWeights({
          branded_rice: loadedWeights.find((item) => item.weight_type === 'branded_rice')?.weight_kg ?? DEFAULT_BRANDED_RICE_WEIGHT,
          feed_rice: loadedWeights.find((item) => item.weight_type === 'feed_rice')?.weight_kg ?? DEFAULT_FEED_RICE_WEIGHT,
        })
      }
    }
    void load()
  }, [version])

  const selectedAuthorization = authorizations.find((item) => item.id === selectedAuthorizationId) ?? null
  const producerBatches = useMemo(() => batches.filter((item) => item.authorization_id === selectedAuthorizationId), [batches, selectedAuthorizationId])
  useEffect(() => {
    // This keeps the selected purchase date valid after a producer switch or reload.
    // oxlint-disable-next-line react/set-state-in-effect
    if (!selectedAuthorizationId) return setSelectedBatchId(null)
    setSelectedBatchId((current) => producerBatches.some((item) => item.id === current) ? current : producerBatches[0]?.id ?? null)
  }, [producerBatches, selectedAuthorizationId])
  const selectedBatch = producerBatches.find((item) => item.id === selectedBatchId) ?? null
  const selectedFlexcons = flexcons.filter((item) => item.batch_id === selectedBatchId)
  const selectedPaperBags = paperBags.find((item) => item.batch_id === selectedBatchId) ?? null
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    if (selectedBatch) { setBatchEditingId(selectedBatch.id); setBatchForm(formFromBatch(selectedBatch)) }
  }, [selectedBatch])

  const summaryRows = useMemo(() => authorizations.map((authorization) => {
    const producerBatches = batches.filter((batch) => batch.authorization_id === authorization.id)
    const batchIds = new Set(producerBatches.map((batch) => batch.id))
    const producerFlexcons = flexcons.filter((item) => batchIds.has(item.batch_id))
    const producerPaperBags = paperBags.filter((item) => batchIds.has(item.batch_id))
    return {
      authorization,
      lastPurchaseDate: producerBatches[0]?.purchase_date ?? null,
      brands: [...new Set(producerBatches.map((batch) => batch.brand).filter(Boolean))].join('、'),
      flexconCount: producerFlexcons.length,
      paperBagCount: producerPaperBags.reduce((total, item) => total + item.bag_count, 0),
      totalQuantity: producerFlexcons.reduce((total, item) => total + item.quantity_kg, 0) + producerPaperBags.reduce((total, item) => total + item.bag_count * 30, 0),
    }
  }), [authorizations, batches, flexcons, paperBags])
  const filteredSummary = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return summaryRows
    return summaryRows.filter(({ authorization, brands }) => [authorization.authorization_no, authorization.full_name, authorization.prefecture, authorization.municipality, brands].some((value) => String(value ?? '').toLowerCase().includes(term)))
  }, [search, summaryRows])

  const locationOptions = inspectionOptions.filter((item) => item.option_type === 'location')
  const gradeOptions = inspectionOptions.filter((item) => item.option_type === 'grade')
  const selectedBrandType = brandTypeForPrefecture(selectedAuthorization?.prefecture ?? null)
  const brandOptions = inspectionOptions.filter((item) => item.option_type === selectedBrandType || item.option_type === 'brand')

  const beginAddBatch = () => {
    setBatchEditingId(null); setBatchForm(emptyBatchForm()); setSelectedBatchId(null); setNotice(null)
  }
  const saveBatch = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedAuthorization || busy) return
    if (!batchForm.purchase_date) return setNotice({ type: 'error', text: '仕入日を入力してください。' })
    setBusy(true); setNotice(null)
    const { data, error } = await supabase.rpc('flexcon_save_inspection_batch', {
      p_worker_id: workerId, p_batch_id: batchEditingId, p_authorization_id: selectedAuthorization.id,
      p_purchase_date: batchForm.purchase_date, p_fiscal_year: Number(batchForm.fiscal_year),
      p_inspection_date: batchForm.inspection_date || null, p_inspection_location: batchForm.inspection_location.trim() || null,
      p_brand: batchForm.brand.trim() || null,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setSelectedBatchId(String(data)); setBatchEditingId(String(data))
    setNotice({ type: 'success', text: batchEditingId ? '仕入日別情報を更新しました。' : '仕入日を追加しました。' })
    setVersion((value) => value + 1)
  }

  const nextFlexconNo = () => {
    const batchIds = new Set(batches.filter((item) => item.authorization_id === selectedAuthorizationId).map((item) => item.id))
    const numbers = flexcons.filter((item) => batchIds.has(item.batch_id)).map((item) => item.flexcon_no)
    return (numbers.length > 0 ? Math.max(...numbers) : 0) + 1
  }
  const defaultFlexconQuantity = () => selectedBatch?.brand?.trim() === '飼料用玄米' ? weights.feed_rice : weights.branded_rice
  const beginAddFlexcon = () => {
    setDetailKind('flexcon'); setDetailEditingId(null); setDetailForm(emptyDetailForm(nextFlexconNo(), defaultFlexconQuantity()))
  }
  const beginEditFlexcon = (item: FlexconInspection) => {
    setDetailKind('flexcon'); setDetailEditingId(item.id)
    setDetailForm({ flexcon_no: String(item.flexcon_no), quantity: String(item.quantity_kg), grade: item.grade ?? '', reason: item.reason ?? '', moisture_values: moistureFormValues(item.moisture_values) })
  }
  const beginEditPaper = () => {
    setDetailKind('paper'); setDetailEditingId(selectedPaperBags?.id ?? null)
    setDetailForm({ flexcon_no: '', quantity: selectedPaperBags ? String(selectedPaperBags.bag_count) : '', grade: selectedPaperBags?.grade ?? '', reason: selectedPaperBags?.reason ?? '', moisture_values: moistureFormValues(selectedPaperBags?.moisture_values ?? []) })
  }
  const saveDetail = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedBatch || !detailKind || busy) return
    const moistureValues = detailForm.moisture_values.map((value) => value.trim() === '' ? null : Number(value))
    setBusy(true); setNotice(null)
    const { error } = detailKind === 'flexcon'
      ? await supabase.rpc('flexcon_save_inspection_flexcon', { p_worker_id: workerId, p_flexcon_id: detailEditingId, p_batch_id: selectedBatch.id, p_flexcon_no: Number(detailForm.flexcon_no), p_quantity_kg: Number(detailForm.quantity), p_grade: detailForm.grade.trim() || null, p_reason: detailForm.reason.trim() || null, p_moisture_values: moistureValues })
      : await supabase.rpc('flexcon_save_inspection_paper_bags', { p_worker_id: workerId, p_paper_bag_id: detailEditingId, p_batch_id: selectedBatch.id, p_bag_count: Number(detailForm.quantity), p_grade: detailForm.grade.trim() || null, p_reason: detailForm.reason.trim() || null, p_moisture_values: moistureValues })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setDetailKind(null)
    setNotice({ type: 'success', text: detailKind === 'flexcon' ? 'フレコン検査記録を保存しました。' : '紙袋検査記録を保存しました。' })
    setVersion((value) => value + 1)
  }
  const deleteFlexcon = async (item: FlexconInspection) => {
    if (!window.confirm(`ロット№${item.lot_number}を削除しますか？`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_inspection_flexcon', { p_worker_id: workerId, p_flexcon_id: item.id })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: 'フレコン検査記録を削除しました。' }); setVersion((value) => value + 1)
  }
  const deleteBatch = async () => {
    if (!selectedBatch || !window.confirm(`${displayDate(selectedBatch.purchase_date)}の検査記録をすべて削除しますか？`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_inspection_batch', { p_worker_id: workerId, p_batch_id: selectedBatch.id })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setSelectedBatchId(null); setNotice({ type: 'success', text: '仕入日別の検査記録を削除しました。' }); setVersion((value) => value + 1)
  }
  const createCertificateCsv = () => {
    if (!selectedAuthorization || !selectedBatch || selectedFlexcons.length === 0) return
    const rows: (string | number)[][] = [['委任状№', '氏名', '県名', '銘柄', '推フレ本数'], [selectedAuthorization.authorization_no, selectedAuthorization.full_name, selectedAuthorization.prefecture ?? '', selectedBatch.brand ?? '', selectedFlexcons.length]]
    const csv = '\uFEFF' + rows.map((row) => row.map(csvValue).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `検査証明書取込_${selectedAuthorization.authorization_no}_${selectedBatch.purchase_date}.csv`; anchor.click(); URL.revokeObjectURL(url)
  }
  const setMoistureValue = (index: number, value: string) => {
    setDetailForm((current) => { const moistureValues = [...current.moisture_values]; moistureValues[index] = value; return { ...current, moisture_values: moistureValues } })
  }

  if (!selectedAuthorization) {
    return <div className="inspection-page">
      <div className="page-heading inspection-heading"><div><h1>検査記録</h1><p>生産者ごとの検査数量を集計表示します。</p></div></div>
      <div className="search-row"><div className="search-input-wrap"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="委任状№・氏名・産地・銘柄で検索" /></div></div>
      <div className="inspection-summary-wrap"><table className="inspection-summary-table">
        <thead><tr><th>委任状№</th><th>氏名</th><th>産地</th><th>最終仕入日</th><th>銘柄</th><th>フレコン</th><th>紙袋</th><th>総数量</th></tr></thead>
        <tbody>{filteredSummary.map((row) => <tr key={row.authorization.id} tabIndex={0} onClick={() => onSelectedAuthorizationChange(row.authorization.id)} onKeyDown={(event) => { if (event.key === 'Enter') onSelectedAuthorizationChange(row.authorization.id) }}>
          <td>{row.authorization.authorization_no}</td><td><strong>{row.authorization.full_name}</strong></td><td>{[row.authorization.prefecture, row.authorization.municipality].filter(Boolean).join(' ')}</td><td>{displayDate(row.lastPurchaseDate)}</td><td>{row.brands}</td><td>{row.flexconCount}本</td><td>{row.paperBagCount}袋</td><td>{row.totalQuantity.toLocaleString()}kg</td>
        </tr>)}</tbody>
      </table></div>
      {notice && <div className={`notice operation-log ${notice.type}`}>{notice.text}</div>}
    </div>
  }

  return <div className="producer-inspection-page">
    <div className="producer-inspection-heading">
      <button className="icon-button" type="button" title="集計へ戻る" aria-label="集計へ戻る" onClick={() => onSelectedAuthorizationChange(null)}><ArrowLeft size={21} /></button>
      <div><h1>{selectedAuthorization.full_name}</h1><p>委任状№ {selectedAuthorization.authorization_no}　{[selectedAuthorization.prefecture, selectedAuthorization.municipality].filter(Boolean).join(' ')}</p></div>
      <button className="primary-button" type="button" onClick={beginAddBatch}><CalendarPlus size={18} />仕入日を追加</button>
    </div>
    <div className="purchase-date-tabs" role="tablist" aria-label="仕入日">
      {producerBatches.map((batch) => <button className={selectedBatchId === batch.id ? 'active' : ''} type="button" key={batch.id} onClick={() => setSelectedBatchId(batch.id)}>{displayDate(batch.purchase_date)}</button>)}
      {producerBatches.length === 0 && <span>仕入日が登録されていません</span>}
    </div>
    {(selectedBatch || batchEditingId === null) && <form className="inspection-batch-form section-band" onSubmit={(event) => void saveBatch(event)}>
      <label>仕入日<input type="date" value={batchForm.purchase_date} onChange={(event) => setBatchForm((current) => ({ ...current, purchase_date: event.target.value }))} required /></label>
      <label>年度<input type="number" min="1" max="99" value={batchForm.fiscal_year} onChange={(event) => setBatchForm((current) => ({ ...current, fiscal_year: event.target.value }))} required /></label>
      <label>検査日<input type="date" value={batchForm.inspection_date} onChange={(event) => setBatchForm((current) => ({ ...current, inspection_date: event.target.value }))} /></label>
      <label>検査場所<select value={batchForm.inspection_location} onChange={(event) => setBatchForm((current) => ({ ...current, inspection_location: event.target.value }))}><option value="">選択してください</option>{locationOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
      <label>銘柄<select value={batchForm.brand} onChange={(event) => setBatchForm((current) => ({ ...current, brand: event.target.value }))}><option value="">選択してください</option>{brandOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
      <button className="primary-button" type="submit" disabled={busy}><Save size={18} />保存</button>
      {selectedBatch && <button className="icon-button delete-icon" type="button" title="この仕入日を削除" aria-label="この仕入日を削除" onClick={() => void deleteBatch()} disabled={busy}><Trash2 size={18} /></button>}
    </form>}
    {selectedBatch && <>
      <section className="section-band inspection-detail-section">
        <div className="section-title"><div><h2>フレコン</h2><span>{selectedFlexcons.length}本</span></div><div className="button-row"><button className="secondary-button certificate-create-button" type="button" disabled={selectedFlexcons.length === 0} onClick={createCertificateCsv}><FileSpreadsheet size={18} />検査証明書作成</button><button className="primary-button" type="button" onClick={beginAddFlexcon}><Plus size={18} />フレコン追加</button></div></div>
        <div className="inspection-detail-table-wrap"><table className="inspection-detail-table">
          <thead><tr><th>フレコン№</th><th>ロット№</th><th>数量</th><th>等級</th><th>水分</th><th>理由</th><th></th></tr></thead>
          <tbody>{selectedFlexcons.map((item) => <tr key={item.id} onClick={() => beginEditFlexcon(item)}><td>{item.flexcon_no}</td><td className="lot-cell">{item.lot_number}</td><td>{item.quantity_kg.toLocaleString()}kg</td><td>{item.grade ?? ''}</td><td className={isHighMoisture(item.moisture) ? 'moisture-high' : ''}>{item.moisture === null ? '' : Number(item.moisture).toFixed(1)}</td><td>{item.reason ?? ''}</td><td className="inspection-row-actions"><button className="icon-button delete-icon" type="button" title="削除" aria-label={`${item.lot_number}を削除`} onClick={(event) => { event.stopPropagation(); void deleteFlexcon(item) }}><Trash2 size={17} /></button></td></tr>)}
          {selectedFlexcons.length === 0 && <tr><td colSpan={7} className="empty-state">フレコンは登録されていません</td></tr>}</tbody>
        </table></div>
      </section>
      <section className="section-band inspection-detail-section">
        <div className="section-title"><div><h2>紙袋</h2><span>仕入日ごとに1行</span></div><button className="primary-button" type="button" onClick={beginEditPaper}><Pencil size={18} />{selectedPaperBags ? '編集' : '入力'}</button></div>
        {selectedPaperBags ? <div className="paper-bag-summary" onClick={beginEditPaper}><div><span>数量</span><strong>{selectedPaperBags.bag_count}袋</strong></div><div><span>総重量</span><strong>{(selectedPaperBags.bag_count * 30).toLocaleString()}kg</strong></div><div><span>等級</span><strong>{selectedPaperBags.grade ?? ''}</strong></div><div><span>水分</span><strong className={isHighMoisture(selectedPaperBags.moisture) ? 'moisture-high' : ''}>{selectedPaperBags.moisture === null ? '' : Number(selectedPaperBags.moisture).toFixed(1)}</strong></div><div><span>理由</span><strong>{selectedPaperBags.reason ?? ''}</strong></div></div>
          : <button className="empty-state empty-state-button" type="button" onClick={beginEditPaper}><PackageOpen size={24} />紙袋の検査記録を入力</button>}
      </section>
    </>}
    {detailKind && <div className="modal-backdrop"><section className="registration-modal inspection-detail-modal" role="dialog" aria-modal="true" aria-labelledby="inspection-detail-title">
      <div className="modal-header"><div><h2 id="inspection-detail-title">{detailKind === 'flexcon' ? 'フレコン検査記録' : '紙袋検査記録'}</h2><p>{displayDate(selectedBatch?.purchase_date)}</p></div><button className="icon-button" type="button" title="閉じる" aria-label="閉じる" onClick={() => setDetailKind(null)}><X size={20} /></button></div>
      <form className="inspection-detail-form" onSubmit={(event) => void saveDetail(event)}>
        <div className="inspection-detail-main-fields">{detailKind === 'flexcon' && <label>フレコン№<input type="number" min="1" max="999" value={detailForm.flexcon_no} onChange={(event) => setDetailForm((current) => ({ ...current, flexcon_no: event.target.value }))} required /></label>}<label>{detailKind === 'flexcon' ? '数量（kg）' : '数量（袋）'}<input type="number" min={detailKind === 'flexcon' ? 1 : 0} value={detailForm.quantity} onChange={(event) => setDetailForm((current) => ({ ...current, quantity: event.target.value }))} required /></label><label>等級<select value={detailForm.grade} onChange={(event) => setDetailForm((current) => ({ ...current, grade: event.target.value }))}><option value="">選択してください</option>{gradeOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label><label>理由<input value={detailForm.reason} onChange={(event) => setDetailForm((current) => ({ ...current, reason: event.target.value }))} /></label><label>水分<input className={`inspection-average-input ${isHighMoisture(averageMoisture(detailForm.moisture_values)) ? 'moisture-high' : ''}`} value={averageMoisture(detailForm.moisture_values)} readOnly /></label></div>
        <fieldset className="inspection-fieldset"><legend>水分測定値</legend><div className="moisture-input-grid">{detailForm.moisture_values.map((value, index) => <label key={index}>水分{index + 1}<input className={isHighMoisture(value) ? 'moisture-high' : ''} type="number" min="0" max="100" step="0.01" value={value} onChange={(event) => setMoistureValue(index, event.target.value)} /></label>)}</div></fieldset>
        <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : '保存'}</button><button className="secondary-button" type="button" onClick={() => setDetailKind(null)} disabled={busy}>取り消し</button></div>
      </form>
    </section></div>}
    {notice && <div className={`notice operation-log ${notice.type}`}>{notice.text}</div>}
  </div>
}
