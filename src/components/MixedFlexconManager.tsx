import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, FileText, Plus, Search, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatPrefectureName } from '../lib/prefecture'
import type { AuthorizationRecord, InspectionOption, InspectionWeight, MixedFlexcon } from '../types'

type Props = { workerId: string }
type Notice = { type: 'success' | 'error'; text: string } | null
type MemberDraft = { authorization: AuthorizationRecord; quantity: string }
type AddForm = {
  fiscalYear: string
  origin: string
  brand: string
  candidateSearch: string
  notes: string
}
type InspectionDraft = {
  purchaseDate: string
  inspectionDate: string
  inspectorName: string
  inspectionLocation: string
  moisture: string
  grade: string
  reason: string
  notes: string
}

const DEFAULT_BRANDED_RICE_WEIGHT = 1020
const DEFAULT_FEED_RICE_WEIGHT = 1000

function currentFiscalYear() { return new Date().getFullYear() - 2018 }
function emptyAddForm(): AddForm {
  return { fiscalYear: String(currentFiscalYear()), origin: '', brand: '', candidateSearch: '', notes: '' }
}
function normalizedOrigin(value: string | null | undefined) {
  return (value ?? '').trim().replace(/[都道府県]$/, '')
}
function isFeedRice(brand: string) { return brand.trim() === '飼料用玄米' }
function memberLabel(item: MixedFlexcon) {
  const members = [...item.flexcon_mixed_flexcon_members].sort((left, right) => left.sort_order - right.sort_order)
  const firstName = members[0]?.flexcon_authorizations?.full_name ?? '生産者未登録'
  return members.length > 1 ? `${firstName}＋他${members.length - 1}名` : firstName
}
function fullMemberNames(item: MixedFlexcon) {
  return [...item.flexcon_mixed_flexcon_members]
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((member) => member.flexcon_authorizations?.full_name)
    .filter((name): name is string => Boolean(name))
    .join('、')
}
function inspectionDraft(item: MixedFlexcon): InspectionDraft {
  return {
    purchaseDate: item.purchase_date ?? '',
    inspectionDate: item.inspection_date ?? '',
    inspectorName: item.inspector_name ?? '',
    inspectionLocation: item.inspection_location ?? '',
    moisture: item.moisture === null ? '' : String(item.moisture),
    grade: item.grade ?? '',
    reason: item.reason ?? '',
    notes: item.notes ?? '',
  }
}
function brandTypeForOrigin(origin: string): 'brand_aomori' | 'brand_iwate' | null {
  const normalized = normalizedOrigin(origin)
  if (normalized === '青森') return 'brand_aomori'
  if (normalized === '岩手') return 'brand_iwate'
  return null
}

export function MixedFlexconManager({ workerId }: Props) {
  const [items, setItems] = useState<MixedFlexcon[]>([])
  const [authorizations, setAuthorizations] = useState<AuthorizationRecord[]>([])
  const [options, setOptions] = useState<InspectionOption[]>([])
  const [weights, setWeights] = useState<Record<InspectionWeight['weight_type'], number>>({ branded_rice: DEFAULT_BRANDED_RICE_WEIGHT, feed_rice: DEFAULT_FEED_RICE_WEIGHT })
  const [authorizationBrands, setAuthorizationBrands] = useState<Record<string, string[]>>({})
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState<AddForm>(emptyAddForm)
  const [members, setMembers] = useState<MemberDraft[]>([])
  const [draft, setDraft] = useState<InspectionDraft | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const load = async () => {
      const [mixedResult, authorizationResult, optionResult, weightResult, flexconResult, paperResult] = await Promise.all([
        supabase.from('flexcon_mixed_flexcons').select('*, flexcon_mixed_flexcon_members(*, flexcon_authorizations(*))').order('mixed_no'),
        supabase.from('flexcon_authorizations').select('*').order('authorization_no'),
        supabase.from('flexcon_inspection_options').select('*').eq('active', true).order('sort_order').order('name'),
        supabase.from('flexcon_inspection_weights').select('*'),
        supabase.from('flexcon_inspection_flexcons').select('authorization_id, brand'),
        supabase.from('flexcon_inspection_paper_bags').select('authorization_id, brand'),
      ])
      if (mixedResult.error) {
        setNotice({ type: 'error', text: '混在フレコン用SQLを実行してください。' })
      } else {
        setItems((mixedResult.data ?? []) as MixedFlexcon[])
      }
      if (!authorizationResult.error) setAuthorizations((authorizationResult.data ?? []) as AuthorizationRecord[])
      if (!optionResult.error) setOptions((optionResult.data ?? []) as InspectionOption[])
      if (!weightResult.error) {
        const loaded = weightResult.data as InspectionWeight[]
        setWeights({
          branded_rice: loaded.find((item) => item.weight_type === 'branded_rice')?.weight_kg ?? DEFAULT_BRANDED_RICE_WEIGHT,
          feed_rice: loaded.find((item) => item.weight_type === 'feed_rice')?.weight_kg ?? DEFAULT_FEED_RICE_WEIGHT,
        })
      }
      const brands: Record<string, Set<string>> = {}
      for (const record of [...(flexconResult.data ?? []), ...(paperResult.data ?? [])]) {
        const authorizationId = String(record.authorization_id)
        const brand = String(record.brand ?? '').trim()
        if (!brand) continue
        brands[authorizationId] ??= new Set<string>()
        brands[authorizationId].add(brand)
      }
      setAuthorizationBrands(Object.fromEntries(Object.entries(brands).map(([id, names]) => [id, [...names]])))
    }
    void load()
  }, [version])

  const selected = items.find((item) => item.id === selectedId) ?? null

  const originOptions = useMemo(() => [...new Set(authorizations
    .map((item) => formatPrefectureName(item.prefecture))
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'ja')), [authorizations])
  const selectedBrandType = brandTypeForOrigin(addForm.origin)
  const brandOptions = options.filter((item) => item.option_type === 'brand' || item.option_type === selectedBrandType)
  const targetWeight = isFeedRice(addForm.brand) ? weights.feed_rice : weights.branded_rice
  const totalWeight = members.reduce((total, member) => total + (Number(member.quantity) || 0), 0)
  const gradeOptions = options.filter((item) => item.option_type === 'grade' && (selected ? (isFeedRice(selected.brand) ? item.name === '合格' : item.name !== '合格') : true))
  const reasonOptions = options.filter((item) => item.option_type === 'grade_reason')
  const inspectorOptions = options.filter((item) => item.option_type === 'inspector')
  const locationOptions = options.filter((item) => item.option_type === 'location')

  const candidateAuthorizations = useMemo(() => {
    if (!addForm.origin || !addForm.brand) return []
    const term = addForm.candidateSearch.trim().toLowerCase()
    return authorizations.filter((authorization) => {
      if (normalizedOrigin(authorization.prefecture) !== normalizedOrigin(addForm.origin)) return false
      if (members.some((member) => member.authorization.id === authorization.id)) return false
      const knownBrands = authorizationBrands[authorization.id] ?? []
      const brandMatches = knownBrands.length === 0
        || knownBrands.includes(addForm.brand)
        || (isFeedRice(addForm.brand) && Boolean(authorization.feed_rice_variety))
      if (!brandMatches) return false
      return !term || authorization.authorization_no.toLowerCase().includes(term) || authorization.full_name.toLowerCase().includes(term)
    }).slice(0, 30)
  }, [addForm.brand, addForm.candidateSearch, addForm.origin, authorizationBrands, authorizations, members])

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return items
    return items.filter((item) => [item.mixed_no, memberLabel(item), item.origin_prefecture, item.brand, item.notes, item.lot_number]
      .some((value) => String(value ?? '').toLowerCase().includes(term)))
  }, [items, search])

  const beginAdd = () => {
    setAddForm(emptyAddForm())
    setMembers([])
    setNotice(null)
    setAddOpen(true)
  }
  const openMixedFlexcon = (item: MixedFlexcon) => {
    setSelectedId(item.id)
    setDraft(inspectionDraft(item))
    setNotice(null)
  }
  const addMember = (authorization: AuthorizationRecord) => {
    setMembers((current) => [...current, { authorization, quantity: '' }])
    setAddForm((current) => ({ ...current, candidateSearch: '' }))
  }
  const registerMixedFlexcon = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!addForm.origin || !addForm.brand) return setNotice({ type: 'error', text: '産地と銘柄を選択してください。' })
    if (members.length < 2) return setNotice({ type: 'error', text: '生産者を2名以上追加してください。' })
    if (members.some((member) => !Number.isInteger(Number(member.quantity)) || Number(member.quantity) <= 0)) return setNotice({ type: 'error', text: '生産者ごとの数量を1kg以上の整数で入力してください。' })
    if (totalWeight !== targetWeight) return setNotice({ type: 'error', text: `合計を量目${targetWeight.toLocaleString()}kgに合わせてください。` })
    setBusy(true); setNotice(null)
    const { data, error } = await supabase.rpc('flexcon_add_mixed_flexcon', {
      p_worker_id: workerId,
      p_fiscal_year: Number(addForm.fiscalYear),
      p_origin_prefecture: addForm.origin,
      p_brand: addForm.brand,
      p_quantity_kg: targetWeight,
      p_notes: addForm.notes.trim() || null,
      p_members: members.map((member) => ({ authorization_id: member.authorization.id, quantity_kg: Number(member.quantity) })),
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    const result = data as { mixed_no?: number } | null
    setAddOpen(false)
    setNotice({ type: 'success', text: `混在フレコン№${result?.mixed_no ?? ''}を登録しました。` })
    setVersion((value) => value + 1)
  }

  const saveInspection = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selected || !draft || busy) return
    const moisture = draft.moisture.trim() === '' ? null : Number(draft.moisture)
    if (moisture !== null && (!Number.isFinite(moisture) || moisture < 0 || moisture > 100)) return setNotice({ type: 'error', text: '水分は0から100の範囲で入力してください。' })
    setBusy(true); setNotice(null)
    const { error } = await supabase.rpc('flexcon_save_mixed_flexcon_inspection', {
      p_worker_id: workerId,
      p_mixed_flexcon_id: selected.id,
      p_purchase_date: draft.purchaseDate || null,
      p_inspection_date: draft.inspectionDate || null,
      p_inspector_name: draft.inspectorName || null,
      p_inspection_location: draft.inspectionLocation || null,
      p_grade: draft.grade || null,
      p_reason: draft.reason || null,
      p_moisture: moisture,
      p_notes: draft.notes.trim() || null,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: '混在フレコンの検査記録を保存しました。' })
    setVersion((value) => value + 1)
  }

  const createCertificate = async () => {
    if (!selected || !draft || busy) return
    const reasonOptional = draft.grade === '1等' || draft.grade === '合格'
    const missing = [
      !draft.purchaseDate && '仕入日', !draft.inspectionDate && '検査日', !draft.inspectorName && '検査員',
      !draft.inspectionLocation && '検査場所', !draft.moisture && '水分', !draft.grade && '等級',
      !reasonOptional && !draft.reason && '理由',
    ].filter((value): value is string => Boolean(value))
    if (missing.length > 0) return setNotice({ type: 'error', text: `検査証明書を作成するには${missing.join('・')}を入力して保存してください。` })

    const pdfWindow = window.open('', '_blank')
    if (pdfWindow) pdfWindow.document.body.textContent = '検査証明書PDFを作成しています...'
    setBusy(true); setNotice(null)
    try {
      const { generateInspectionCertificatePdf } = await import('../lib/certificatePdf')
      const feedVarieties = [...new Set(selected.flexcon_mixed_flexcon_members
        .map((member) => member.flexcon_authorizations?.feed_rice_variety?.trim())
        .filter((value): value is string => Boolean(value)))].join('、')
      const blob = await generateInspectionCertificatePdf({
        authorization: {
          authorizationNo: String(selected.mixed_no + 5000),
          fullName: fullMemberNames(selected),
          address: '各委任状記載のとおり',
          prefecture: selected.origin_prefecture,
          feedRiceVariety: feedVarieties,
        },
        flexcons: [{
          flexconNo: 1,
          lotNumber: selected.lot_number,
          fiscalYear: selected.fiscal_year,
          inspectionDate: draft.inspectionDate,
          inspectorName: draft.inspectorName,
          brand: selected.brand,
          quantityKg: selected.quantity_kg,
          grade: draft.grade,
          reason: draft.reason,
        }],
      })
      const url = URL.createObjectURL(blob)
      if (pdfWindow) pdfWindow.location.href = url
      else {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `混在フレコン検査証明書_${selected.mixed_no}.pdf`
        anchor.click()
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 300_000)
      setNotice({ type: 'success', text: '混在フレコンの検査証明書PDFを作成しました。' })
    } catch (error) {
      if (pdfWindow) pdfWindow.close()
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '検査証明書PDFを作成できませんでした。' })
    } finally {
      setBusy(false)
    }
  }

  if (selected && draft) {
    const reasonForbidden = draft.grade === '1等' || draft.grade === '合格'
    return <div className="mixed-detail-page">
      <div className="producer-inspection-heading">
        <button className="icon-button" type="button" title="一覧へ戻る" aria-label="一覧へ戻る" onClick={() => { setSelectedId(null); setDraft(null); setNotice(null) }}><ArrowLeft size={21} /></button>
        <div><h1>混在フレコン №{selected.mixed_no}</h1><p>{memberLabel(selected)}　{selected.origin_prefecture}　{selected.brand}　{selected.lot_number}</p></div>
        <button className="secondary-button" type="button" onClick={() => void createCertificate()} disabled={busy}><FileText size={18} />検査証明書作成</button>
      </div>
      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
      <section className="section-band mixed-members-summary">
        <div className="section-title"><h2>生産者別内訳</h2><strong>合計 {selected.quantity_kg.toLocaleString()}kg</strong></div>
        <div className="mixed-member-summary-list">{[...selected.flexcon_mixed_flexcon_members].sort((a, b) => a.sort_order - b.sort_order).map((member) => <div key={member.id}><span>委任状№ {member.flexcon_authorizations?.authorization_no}　{member.flexcon_authorizations?.full_name}</span><strong>{member.quantity_kg.toLocaleString()}kg</strong></div>)}</div>
      </section>
      <form className="section-band mixed-inspection-form" onSubmit={(event) => void saveInspection(event)}>
        <div className="mixed-inspection-grid">
          <label>年度<input value={selected.fiscal_year} readOnly /></label>
          <label>仕入日<input type="date" value={draft.purchaseDate} onChange={(event) => setDraft((current) => current ? { ...current, purchaseDate: event.target.value } : current)} /></label>
          <label>検査日<input type="date" value={draft.inspectionDate} onChange={(event) => setDraft((current) => current ? { ...current, inspectionDate: event.target.value } : current)} /></label>
          <label>検査員<select value={draft.inspectorName} onChange={(event) => setDraft((current) => current ? { ...current, inspectorName: event.target.value } : current)}><option value="">未選択</option>{inspectorOptions.map((option) => <option key={option.id}>{option.name}</option>)}</select></label>
          <label>検査場所<select value={draft.inspectionLocation} onChange={(event) => setDraft((current) => current ? { ...current, inspectionLocation: event.target.value } : current)}><option value="">未選択</option>{locationOptions.map((option) => <option key={option.id}>{option.name}</option>)}</select></label>
          <label>産地<input value={selected.origin_prefecture} readOnly /></label>
          <label>銘柄<input value={selected.brand} readOnly /></label>
          <label>数量<input value={`${selected.quantity_kg.toLocaleString()}kg`} readOnly /></label>
          <label>水分<input className={Number(draft.moisture) > 16 ? 'moisture-high' : ''} type="number" min="0" max="100" step="0.1" value={draft.moisture} onChange={(event) => setDraft((current) => current ? { ...current, moisture: event.target.value } : current)} /></label>
          <label>等級<select value={draft.grade} onChange={(event) => { const grade = event.target.value; setDraft((current) => current ? { ...current, grade, reason: grade === '1等' || grade === '合格' ? '' : current.reason } : current) }}><option value="">未選択</option>{gradeOptions.map((option) => <option key={option.id}>{option.name}</option>)}</select></label>
          <label>理由<select value={draft.reason} disabled={reasonForbidden || !draft.grade} onChange={(event) => setDraft((current) => current ? { ...current, reason: event.target.value } : current)}><option value="">未選択</option>{reasonOptions.map((option) => <option key={option.id}>{option.name}</option>)}</select></label>
          <label className="mixed-notes-field">備考<textarea rows={2} value={draft.notes} onChange={(event) => setDraft((current) => current ? { ...current, notes: event.target.value } : current)} /></label>
        </div>
        <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? '保存中...' : '保存'}</button></div>
      </form>
    </div>
  }

  return <div className="mixed-page">
    <div className="page-heading authorization-heading"><div><h1>混在フレコン</h1><p>複数生産者の玄米を1本のフレコンとして登録します。</p></div><button className="primary-button" type="button" onClick={beginAdd}><Plus size={18} />追加</button></div>
    {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
    <div className="search-row"><div className="search-input-wrap"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="№・氏名・産地・銘柄・備考で検索" /></div></div>
    <div className="mixed-table-wrap"><table className="mixed-table"><thead><tr><th>№</th><th>氏名</th><th>産地</th><th>銘柄名</th><th>備考</th></tr></thead><tbody>
      {filteredItems.map((item) => <tr key={item.id} tabIndex={0} onClick={() => openMixedFlexcon(item)} onKeyDown={(event) => { if (event.key === 'Enter') openMixedFlexcon(item) }}><td>{item.mixed_no}</td><td><strong>{memberLabel(item)}</strong></td><td>{item.origin_prefecture}</td><td>{item.brand}</td><td>{item.notes ?? ''}</td></tr>)}
      {filteredItems.length === 0 && <tr><td className="empty-state" colSpan={5}>登録された混在フレコンはありません</td></tr>}
    </tbody></table></div>

    {addOpen && <div className="modal-backdrop"><section className="registration-modal mixed-add-modal" role="dialog" aria-modal="true" aria-labelledby="mixed-add-title">
      <div className="modal-header"><div><h2 id="mixed-add-title">混在フレコンを追加</h2><p>産地と銘柄を選び、生産者別の数量を入力します。</p></div><button className="icon-button" type="button" title="閉じる" aria-label="閉じる" onClick={() => setAddOpen(false)} disabled={busy}><X size={20} /></button></div>
      <div className={`mixed-total-panel ${totalWeight === targetWeight && members.length >= 2 ? 'complete' : ''}`}><span>合計</span><strong>{totalWeight.toLocaleString()}kg</strong><span>/ 量目 {targetWeight.toLocaleString()}kg</span></div>
      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
      <form className="mixed-add-form" onSubmit={(event) => void registerMixedFlexcon(event)}>
        <div className="mixed-base-fields">
          <label>年度<input type="number" min="1" max="99" value={addForm.fiscalYear} onChange={(event) => setAddForm((current) => ({ ...current, fiscalYear: event.target.value }))} required /></label>
          <label>産地<select value={addForm.origin} onChange={(event) => { const origin = event.target.value; setAddForm((current) => ({ ...current, origin, brand: '', candidateSearch: '' })); setMembers([]) }} required><option value="">選択してください</option>{originOptions.map((origin) => <option key={origin}>{origin}</option>)}</select></label>
          <label>銘柄名<select value={addForm.brand} disabled={!addForm.origin} onChange={(event) => { const brand = event.target.value; setAddForm((current) => ({ ...current, brand, candidateSearch: '' })); setMembers([]) }} required><option value="">選択してください</option>{brandOptions.map((option) => <option key={option.id}>{option.name}</option>)}</select></label>
        </div>
        <div className="mixed-candidate-picker">
          <label>委任状№または氏名<input value={addForm.candidateSearch} disabled={!addForm.brand} onChange={(event) => setAddForm((current) => ({ ...current, candidateSearch: event.target.value }))} placeholder="入力して候補を絞り込み" /></label>
          {addForm.brand && <div className="mixed-candidate-list">{candidateAuthorizations.map((authorization) => <button type="button" key={authorization.id} onClick={() => addMember(authorization)}><span>№{authorization.authorization_no}</span><strong>{authorization.full_name}</strong></button>)}{candidateAuthorizations.length === 0 && <span className="empty-state">候補がありません</span>}</div>}
        </div>
        <div className="mixed-member-editor"><div className="mixed-member-editor-head"><span>登録する生産者</span><strong>{members.length}名</strong></div>{members.map((member) => <div className="mixed-member-row" key={member.authorization.id}><span>№{member.authorization.authorization_no}</span><strong>{member.authorization.full_name}</strong><label><input type="number" min="1" step="1" inputMode="numeric" value={member.quantity} onChange={(event) => setMembers((current) => current.map((item) => item.authorization.id === member.authorization.id ? { ...item, quantity: event.target.value } : item))} /><span>kg</span></label><button className="icon-button delete-icon" type="button" title="取り消し" aria-label={`${member.authorization.full_name}を取り消す`} onClick={() => setMembers((current) => current.filter((item) => item.authorization.id !== member.authorization.id))}><Trash2 size={17} /></button></div>)}</div>
        <label>備考（任意）<textarea rows={2} value={addForm.notes} onChange={(event) => setAddForm((current) => ({ ...current, notes: event.target.value }))} /></label>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setAddOpen(false)} disabled={busy}>取り消し</button><button className="primary-button" type="submit" disabled={busy || members.length < 2 || totalWeight !== targetWeight}>{busy ? '登録中...' : '登録'}</button></div>
      </form>
    </section></div>}
  </div>
}
