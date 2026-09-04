import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, FileSpreadsheet, Plus, Search, TableRowsSplit, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { AuthorizationRecord, FlexconInspection, InspectionOption, InspectionWeight, PaperBagInspection } from '../types'

type Props = {
  workerId: string
  selectedAuthorizationId: string | null
  onSelectedAuthorizationChange: (authorizationId: string | null) => void
}
type Notice = { type: 'success' | 'error'; text: string } | null
type AddGroupForm = {
  fiscal_year: string
  purchase_date: string
  inspection_date: string
  inspection_location: string
  brand: string
  flexcon_count: string
  paper_bag_count: string
}
type InlineDetailDraft = {
  fiscal_year: string
  purchase_date: string
  inspection_date: string
  inspection_location: string
  brand: string
  quantity: string
  grade: string
  reason: string
  moisture: string
}

const DEFAULT_BRANDED_RICE_WEIGHT = 1020
const DEFAULT_FEED_RICE_WEIGHT = 1000
const AUTHORIZATION_NO_COLLATOR = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })

function currentFiscalYear() { return new Date().getFullYear() - 2018 }
function today() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}
function emptyAddGroupForm(): AddGroupForm {
  return {
    fiscal_year: String(currentFiscalYear()),
    purchase_date: today(),
    inspection_date: '',
    inspection_location: '',
    brand: '',
    flexcon_count: '',
    paper_bag_count: '',
  }
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
  const [flexcons, setFlexcons] = useState<FlexconInspection[]>([])
  const [paperBags, setPaperBags] = useState<PaperBagInspection[]>([])
  const [inspectionOptions, setInspectionOptions] = useState<InspectionOption[]>([])
  const [weights, setWeights] = useState<Record<InspectionWeight['weight_type'], number>>({ branded_rice: DEFAULT_BRANDED_RICE_WEIGHT, feed_rice: DEFAULT_FEED_RICE_WEIGHT })
  const [addGroupForm, setAddGroupForm] = useState<AddGroupForm>(emptyAddGroupForm)
  const [detailDrafts, setDetailDrafts] = useState<Record<string, InlineDetailDraft>>({})
  const [splitPaper, setSplitPaper] = useState<PaperBagInspection | null>(null)
  const [splitCounts, setSplitCounts] = useState({ first: '', second: '' })
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const load = async () => {
      const [authorizationResult, flexconResult, paperResult, optionResult, weightResult] = await Promise.all([
        supabase.from('flexcon_authorizations').select('*').order('authorization_no'),
        supabase.from('flexcon_inspection_flexcons').select('*').order('purchase_date', { ascending: false }).order('flexcon_no'),
        supabase.from('flexcon_inspection_paper_bags').select('*').order('purchase_date', { ascending: false }).order('created_at'),
        supabase.from('flexcon_inspection_options').select('*').eq('active', true).order('sort_order').order('name'),
        supabase.from('flexcon_inspection_weights').select('*'),
      ])
      if (flexconResult.error || paperResult.error) {
        setNotice({ type: 'error', text: '委任状単位の検査記録用SQLを実行してください。' })
        return
      }
      if (authorizationResult.error) {
        setNotice({ type: 'error', text: authorizationResult.error.message })
        return
      }
      setAuthorizations(((authorizationResult.data ?? []) as AuthorizationRecord[]).sort((left, right) => (
        AUTHORIZATION_NO_COLLATOR.compare(left.authorization_no, right.authorization_no)
      )))
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
  const selectedFlexcons = flexcons.filter((item) => item.authorization_id === selectedAuthorizationId)
  const selectedPaperBags = paperBags.filter((item) => item.authorization_id === selectedAuthorizationId)

  const summaryRows = useMemo(() => authorizations.map((authorization) => {
    const producerFlexcons = flexcons.filter((item) => item.authorization_id === authorization.id)
    const producerPaperBags = paperBags.filter((item) => item.authorization_id === authorization.id)
    const purchaseDates = [...producerFlexcons, ...producerPaperBags].map((item) => item.purchase_date).filter(Boolean).sort().reverse()
    return {
      authorization,
      lastPurchaseDate: purchaseDates[0] ?? null,
      brands: [...new Set([...producerFlexcons.map((item) => item.brand), ...producerPaperBags.map((item) => item.brand)].filter(Boolean))].join('、'),
      flexconCount: producerFlexcons.length,
      paperBagCount: producerPaperBags.reduce((total, item) => total + item.bag_count, 0),
      totalQuantity: producerFlexcons.reduce((total, item) => total + item.quantity_kg, 0) + producerPaperBags.reduce((total, item) => total + item.bag_count * 30, 0),
    }
  }).filter((row) => row.flexconCount > 0 || row.paperBagCount > 0), [authorizations, flexcons, paperBags])
  const filteredSummary = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return summaryRows
    return summaryRows.filter(({ authorization, brands }) => [authorization.authorization_no, authorization.full_name, authorization.prefecture, authorization.municipality, brands].some((value) => String(value ?? '').toLowerCase().includes(term)))
  }, [search, summaryRows])

  const locationOptions = inspectionOptions.filter((item) => item.option_type === 'location')
  const gradeOptions = inspectionOptions.filter((item) => item.option_type === 'grade')
  const reasonOptions = inspectionOptions.filter((item) => item.option_type === 'grade_reason')
  const selectedBrandType = brandTypeForPrefecture(selectedAuthorization?.prefecture ?? null)
  const brandOptions = inspectionOptions.filter((item) => item.option_type === selectedBrandType || item.option_type === 'brand')

  const addInspectionGroup = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedAuthorization || busy) return
    const flexconCount = Number(addGroupForm.flexcon_count || 0)
    const paperBagCount = Number(addGroupForm.paper_bag_count || 0)
    if (!addGroupForm.purchase_date) return setNotice({ type: 'error', text: '仕入日を入力してください。' })
    if (!addGroupForm.brand) return setNotice({ type: 'error', text: '銘柄を選択してください。' })
    if (flexconCount <= 0 && paperBagCount <= 0) return setNotice({ type: 'error', text: 'フレコン本数または紙袋数を入力してください。' })
    const flexconQuantity = addGroupForm.brand === '飼料用玄米' ? weights.feed_rice : weights.branded_rice
    setBusy(true); setNotice(null)
    const { error } = await supabase.rpc('flexcon_add_inspection_group', {
      p_worker_id: workerId,
      p_authorization_id: selectedAuthorization.id,
      p_fiscal_year: Number(addGroupForm.fiscal_year),
      p_purchase_date: addGroupForm.purchase_date,
      p_inspection_date: addGroupForm.inspection_date || null,
      p_inspection_location: addGroupForm.inspection_location.trim() || null,
      p_brand: addGroupForm.brand,
      p_flexcon_count: flexconCount,
      p_paper_bag_count: paperBagCount,
      p_flexcon_quantity_kg: flexconQuantity,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setAddGroupForm((current) => ({ ...current, brand: '', flexcon_count: '', paper_bag_count: '' }))
    setNotice({ type: 'success', text: `${addGroupForm.brand}を追加しました。` })
    setVersion((value) => value + 1)
  }

  const detailDraft = (item: FlexconInspection | PaperBagInspection): InlineDetailDraft => detailDrafts[item.id] ?? {
    fiscal_year: String(item.fiscal_year),
    purchase_date: item.purchase_date,
    inspection_date: item.inspection_date ?? '',
    inspection_location: item.inspection_location ?? '',
    brand: item.brand ?? '',
    quantity: String('quantity_kg' in item ? item.quantity_kg : item.bag_count),
    grade: item.grade ?? '',
    reason: item.reason ?? '',
    moisture: item.moisture === null ? '' : String(item.moisture),
  }
  const changeDetailDraft = (item: FlexconInspection | PaperBagInspection, values: Partial<InlineDetailDraft>) => {
    setDetailDrafts((current) => {
      const previous = current[item.id] ?? detailDraft(item)
      return { ...current, [item.id]: { ...previous, ...values } }
    })
  }
  const saveInlineDetail = async (
    detailKind: 'flexcon' | 'paper',
    item: FlexconInspection | PaperBagInspection,
    values: Partial<InlineDetailDraft> = {},
  ) => {
    if (!selectedAuthorization || busy) return
    const draft = { ...detailDraft(item), ...values }
    if (draft.grade === '1等' || draft.grade === '合格') draft.reason = ''
    const fiscalYear = Number(draft.fiscal_year)
    const quantity = Number(draft.quantity)
    const moisture = draft.moisture.trim() === '' ? null : Number(draft.moisture)
    if (!Number.isInteger(fiscalYear) || fiscalYear < 1 || fiscalYear > 99) return setNotice({ type: 'error', text: '年度は1から99の整数で入力してください。' })
    if (!draft.purchase_date) return setNotice({ type: 'error', text: '仕入日を入力してください。' })
    if (!draft.brand) return setNotice({ type: 'error', text: '銘柄を選択してください。' })
    if (!Number.isInteger(quantity) || quantity <= 0) return setNotice({ type: 'error', text: detailKind === 'flexcon' ? '数量は1kg以上の整数で入力してください。' : '紙袋数は1以上の整数で入力してください。' })
    if (moisture !== null && (!Number.isFinite(moisture) || moisture < 0 || moisture > 100)) return setNotice({ type: 'error', text: '水分は0から100の範囲で入力してください。' })
    changeDetailDraft(item, draft)
    const common = {
      p_worker_id: workerId,
      p_authorization_id: selectedAuthorization.id,
      p_fiscal_year: fiscalYear,
      p_purchase_date: draft.purchase_date,
      p_inspection_date: draft.inspection_date || null,
      p_inspection_location: draft.inspection_location.trim() || null,
      p_brand: draft.brand,
      p_grade: draft.grade.trim() || null,
      p_reason: draft.reason.trim() || null,
      p_moisture: moisture,
    }
    setBusy(true); setNotice(null)
    const { error } = detailKind === 'flexcon'
      ? await supabase.rpc('flexcon_save_inspection_flexcon', { ...common, p_flexcon_id: item.id, p_flexcon_no: (item as FlexconInspection).flexcon_no, p_quantity_kg: quantity })
      : await supabase.rpc('flexcon_save_inspection_paper_bags', { ...common, p_paper_bag_id: item.id, p_bag_count: quantity })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setDetailDrafts((current) => { const next = { ...current }; delete next[item.id]; return next })
    setNotice({ type: 'success', text: detailKind === 'flexcon' ? 'フレコン検査記録を保存しました。' : '紙袋検査記録を保存しました。' })
    setVersion((value) => value + 1)
  }

  const renderInlineMetadataFields = (detailKind: 'flexcon' | 'paper', item: FlexconInspection | PaperBagInspection) => {
    const draft = detailDraft(item)
    const save = (values: Partial<InlineDetailDraft> = {}) => void saveInlineDetail(detailKind, item, values)
    return <>
      <td className="inspection-inline-cell inspection-year-cell"><input type="number" min="1" max="99" value={draft.fiscal_year} aria-label="年度" disabled={busy} onChange={(event) => changeDetailDraft(item, { fiscal_year: event.target.value })} onBlur={() => save()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></td>
      <td className="inspection-inline-cell inspection-date-cell"><input type="date" value={draft.purchase_date} aria-label="仕入日" disabled={busy} onChange={(event) => { const purchase_date = event.target.value; changeDetailDraft(item, { purchase_date }); save({ purchase_date }) }} /></td>
      <td className="inspection-inline-cell inspection-date-cell"><input type="date" value={draft.inspection_date} aria-label="検査日" disabled={busy} onChange={(event) => { const inspection_date = event.target.value; changeDetailDraft(item, { inspection_date }); save({ inspection_date }) }} /></td>
      <td className="inspection-inline-cell inspection-location-cell"><select value={draft.inspection_location} aria-label="検査場所" disabled={busy} onChange={(event) => { const inspection_location = event.target.value; changeDetailDraft(item, { inspection_location }); save({ inspection_location }) }}><option value="">未選択</option>{locationOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
    </>
  }
  const renderInlineResultFields = (detailKind: 'flexcon' | 'paper', item: FlexconInspection | PaperBagInspection) => {
    const draft = detailDraft(item)
    const reasonForbidden = draft.grade === '1等' || draft.grade === '合格'
    const save = (values: Partial<InlineDetailDraft> = {}) => void saveInlineDetail(detailKind, item, values)
    return <>
      <td className="inspection-inline-cell"><input className={isHighMoisture(draft.moisture) ? 'moisture-high' : ''} type="number" min="0" max="100" step="0.1" value={draft.moisture} aria-label="水分" disabled={busy} onChange={(event) => changeDetailDraft(item, { moisture: event.target.value })} onBlur={() => save()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></td>
      <td className="inspection-inline-cell"><select value={draft.grade} aria-label="等級" disabled={busy} onChange={(event) => { const grade = event.target.value; const reason = grade === '1等' || grade === '合格' ? '' : draft.reason; changeDetailDraft(item, { grade, reason }); save({ grade, reason }) }}><option value="">未選択</option>{gradeOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
      <td className="inspection-inline-cell inspection-inline-reason-cell"><select value={reasonForbidden ? '' : draft.reason} aria-label="理由" disabled={busy || reasonForbidden} title={reasonForbidden ? '1等と合格には理由を入力できません' : undefined} onChange={(event) => { const reason = event.target.value; changeDetailDraft(item, { reason }); save({ reason }) }}><option value="">未選択</option>{reasonOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
    </>
  }
  const renderInlineProductFields = (detailKind: 'flexcon' | 'paper', item: FlexconInspection | PaperBagInspection) => {
    const draft = detailDraft(item)
    const save = (values: Partial<InlineDetailDraft> = {}) => void saveInlineDetail(detailKind, item, values)
    return <>
      <td className="inspection-inline-cell inspection-brand-cell"><select value={draft.brand} aria-label="銘柄" disabled={busy} onChange={(event) => { const brand = event.target.value; changeDetailDraft(item, { brand }); save({ brand }) }}><option value="">未選択</option>{brandOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
      <td className="inspection-inline-cell inspection-quantity-cell"><input type="number" min="1" step="1" value={draft.quantity} aria-label={detailKind === 'flexcon' ? '数量（kg）' : '数量（袋）'} disabled={busy} onChange={(event) => changeDetailDraft(item, { quantity: event.target.value })} onBlur={() => save()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></td>
    </>
  }

  const deleteFlexcon = async (item: FlexconInspection) => {
    if (!window.confirm(`№${item.flexcon_no}を削除しますか？`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_inspection_flexcon', { p_worker_id: workerId, p_flexcon_id: item.id })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: 'フレコン検査記録を削除しました。' }); setVersion((value) => value + 1)
  }
  const deletePaperBags = async (item: PaperBagInspection) => {
    if (!window.confirm(`${item.brand ?? ''} ${item.bag_count}袋を削除しますか？`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_inspection_paper_bags', { p_worker_id: workerId, p_paper_bag_id: item.id })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: '紙袋検査記録を削除しました。' }); setVersion((value) => value + 1)
  }
  const beginSplitPaperBags = (item: PaperBagInspection) => {
    const first = Math.floor(item.bag_count / 2)
    setSplitPaper(item)
    setSplitCounts({ first: String(first), second: String(item.bag_count - first) })
    setNotice(null)
  }
  const splitPaperBags = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!splitPaper || busy) return
    const first = Number(splitCounts.first)
    const second = Number(splitCounts.second)
    if (!Number.isInteger(first) || !Number.isInteger(second) || first <= 0 || second <= 0) return setNotice({ type: 'error', text: '分割後の袋数はどちらも1以上の整数で入力してください。' })
    if (first + second !== splitPaper.bag_count) return setNotice({ type: 'error', text: `分割後の合計を元の${splitPaper.bag_count}袋に合わせてください。` })
    setBusy(true); setNotice(null)
    const { error } = await supabase.rpc('flexcon_split_inspection_paper_bags', {
      p_worker_id: workerId,
      p_paper_bag_id: splitPaper.id,
      p_first_bag_count: first,
      p_second_bag_count: second,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setSplitPaper(null)
    setNotice({ type: 'success', text: `紙袋${first + second}袋を${first}袋と${second}袋に分割しました。` })
    setVersion((value) => value + 1)
  }
  const createCertificateCsv = () => {
    if (!selectedAuthorization || selectedFlexcons.length === 0) return
    const brandCounts = Object.entries(selectedFlexcons.reduce<Record<string, number>>((counts, item) => {
      const brand = item.brand ?? '未設定'
      counts[brand] = (counts[brand] ?? 0) + 1
      return counts
    }, {}))
    const rows: (string | number)[][] = [['委任状№', '氏名', '県名', '銘柄', '推フレ本数'], ...brandCounts.map(([brand, count]) => [selectedAuthorization.authorization_no, selectedAuthorization.full_name, selectedAuthorization.prefecture ?? '', brand, count])]
    const csv = '\uFEFF' + rows.map((row) => row.map(csvValue).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `検査証明書取込_${selectedAuthorization.authorization_no}.csv`; anchor.click(); URL.revokeObjectURL(url)
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
    </div>
    <form className="inspection-group-add section-band" onSubmit={(event) => void addInspectionGroup(event)}>
      <label>年度<input type="number" min="1" max="99" value={addGroupForm.fiscal_year} onChange={(event) => setAddGroupForm((current) => ({ ...current, fiscal_year: event.target.value }))} required /></label>
      <label>仕入日<input type="date" value={addGroupForm.purchase_date} onChange={(event) => setAddGroupForm((current) => ({ ...current, purchase_date: event.target.value }))} required /></label>
      <label>検査日<input type="date" value={addGroupForm.inspection_date} onChange={(event) => setAddGroupForm((current) => ({ ...current, inspection_date: event.target.value }))} /></label>
      <label>検査場所<select value={addGroupForm.inspection_location} onChange={(event) => setAddGroupForm((current) => ({ ...current, inspection_location: event.target.value }))}><option value="">未選択</option>{locationOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
      <label>銘柄<select value={addGroupForm.brand} onChange={(event) => setAddGroupForm((current) => ({ ...current, brand: event.target.value }))} required><option value="">選択してください</option>{brandOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
      <label>フレコン本数<input type="number" min="0" max="999" value={addGroupForm.flexcon_count} onChange={(event) => setAddGroupForm((current) => ({ ...current, flexcon_count: event.target.value }))} placeholder="0" /></label>
      <label>紙袋数<input type="number" min="0" value={addGroupForm.paper_bag_count} onChange={(event) => setAddGroupForm((current) => ({ ...current, paper_bag_count: event.target.value }))} placeholder="0" /></label>
      <button className="primary-button" type="submit" disabled={busy}><Plus size={18} />{busy ? '追加中...' : '追加'}</button>
    </form>
    <section className="section-band inspection-detail-section">
      <div className="section-title"><div><h2>フレコン</h2><span>{selectedFlexcons.length}本</span></div><button className="secondary-button certificate-create-button" type="button" disabled={selectedFlexcons.length === 0} onClick={createCertificateCsv}><FileSpreadsheet size={18} />検査証明書作成</button></div>
      <div className="inspection-detail-table-wrap"><table className="inspection-detail-table">
        <thead><tr><th>№</th><th>年度</th><th>仕入日</th><th>検査日</th><th>検査場所</th><th>銘柄</th><th>数量（kg）</th><th>水分</th><th>等級</th><th>理由</th><th></th></tr></thead>
        <tbody>{selectedFlexcons.map((item) => <tr key={item.id}><td>{item.flexcon_no}</td>{renderInlineMetadataFields('flexcon', item)}{renderInlineProductFields('flexcon', item)}{renderInlineResultFields('flexcon', item)}<td className="inspection-row-actions"><button className="icon-button delete-icon" type="button" title="削除" aria-label={`№${item.flexcon_no}を削除`} onClick={() => void deleteFlexcon(item)}><Trash2 size={17} /></button></td></tr>)}
        {selectedFlexcons.length === 0 && <tr><td colSpan={11} className="empty-state">フレコンは登録されていません</td></tr>}</tbody>
      </table></div>
    </section>
    <section className="section-band inspection-detail-section">
      <div className="section-title"><div><h2>紙袋</h2><span>{selectedPaperBags.length}件</span></div></div>
      <div className="inspection-detail-table-wrap"><table className="inspection-detail-table paper-detail-table">
        <thead><tr><th>年度</th><th>仕入日</th><th>検査日</th><th>検査場所</th><th>銘柄</th><th>数量（袋）</th><th>総重量</th><th>水分</th><th>等級</th><th>理由</th><th></th></tr></thead>
        <tbody>{selectedPaperBags.map((item) => <tr key={item.id}>{renderInlineMetadataFields('paper', item)}{renderInlineProductFields('paper', item)}<td>{(Number(detailDraft(item).quantity || 0) * 30).toLocaleString()}kg</td>{renderInlineResultFields('paper', item)}<td className="inspection-row-actions inspection-row-actions-wide"><button className="icon-button" type="button" title="2行に分割" aria-label={`${item.brand ?? ''}の紙袋を2行に分割`} disabled={busy || item.bag_count < 2} onClick={() => beginSplitPaperBags(item)}><TableRowsSplit size={17} /></button><button className="icon-button delete-icon" type="button" title="削除" aria-label={`${item.brand ?? ''}の紙袋を削除`} onClick={() => void deletePaperBags(item)}><Trash2 size={17} /></button></td></tr>)}
        {selectedPaperBags.length === 0 && <tr><td colSpan={11} className="empty-state">紙袋は登録されていません</td></tr>}</tbody>
      </table></div>
    </section>
    {splitPaper && <div className="modal-backdrop"><section className="registration-modal paper-split-modal" role="dialog" aria-modal="true" aria-labelledby="paper-split-title">
      <div className="modal-header"><div><h2 id="paper-split-title">紙袋を2行に分割</h2><p>{splitPaper.brand}　元の数量 {splitPaper.bag_count}袋</p></div><button className="icon-button" type="button" title="閉じる" aria-label="閉じる" onClick={() => setSplitPaper(null)} disabled={busy}><X size={20} /></button></div>
      <form className="paper-split-form" onSubmit={(event) => void splitPaperBags(event)}>
        <label>1行目の数量（袋）<input type="number" min="1" step="1" value={splitCounts.first} onChange={(event) => setSplitCounts((current) => ({ ...current, first: event.target.value }))} required /></label>
        <label>2行目の数量（袋）<input type="number" min="1" step="1" value={splitCounts.second} onChange={(event) => setSplitCounts((current) => ({ ...current, second: event.target.value }))} required /></label>
        <div className="paper-split-total">合計 {(Number(splitCounts.first) || 0) + (Number(splitCounts.second) || 0)} / {splitPaper.bag_count}袋</div>
        <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy}><TableRowsSplit size={18} />{busy ? '分割中...' : '分割する'}</button><button className="secondary-button" type="button" onClick={() => setSplitPaper(null)} disabled={busy}>取り消し</button></div>
      </form>
    </section></div>}
    {notice && <div className={`notice operation-log ${notice.type}`}>{notice.text}</div>}
  </div>
}
