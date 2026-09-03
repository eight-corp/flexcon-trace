import { useEffect, useMemo, useState } from 'react'
import { FileSpreadsheet, Plus, Save, Search, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { AuthorizationRecord, InspectionOption, InspectionRecord } from '../types'

type Props = { workerId: string }
type Notice = { type: 'success' | 'error'; text: string } | null

type InspectionForm = {
  record_no: string
  fiscal_year: string
  purchase_date: string
  inspection_date: string
  full_name: string
  prefecture: string
  municipality: string
  inspection_location: string
  authorization_no: string
  brand: string
  recommended_flexcon: string
  paper_bags: string
  bulk_quantity: string
  grade: string
  reason: string
  moisture_values: string[]
}

type TextFormField = Exclude<keyof InspectionForm, 'moisture_values'>

const MOISTURE_COUNT = 100

function currentFiscalYear(): number {
  return new Date().getFullYear() - 2018
}

function emptyMoistureValues(): string[] {
  return Array.from({ length: MOISTURE_COUNT }, () => '')
}

function emptyForm(recordNo = 1): InspectionForm {
  return {
    record_no: String(recordNo),
    fiscal_year: String(currentFiscalYear()),
    purchase_date: '',
    inspection_date: '',
    full_name: '',
    prefecture: '',
    municipality: '',
    inspection_location: '',
    authorization_no: '',
    brand: '',
    recommended_flexcon: '',
    paper_bags: '',
    bulk_quantity: '',
    grade: '',
    reason: '',
    moisture_values: emptyMoistureValues(),
  }
}

function normalizeAuthorizationNo(value: string): string {
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed
}

function nextRecordNo(items: InspectionRecord[], fiscalYear: number): number {
  const numbers = items
    .filter((item) => item.fiscal_year === fiscalYear)
    .map((item) => item.record_no)
  return (numbers.length > 0 ? Math.max(...numbers) : 0) + 1
}

function formFromRecord(record: InspectionRecord): InspectionForm {
  const moistureValues = Array.from({ length: MOISTURE_COUNT }, (_, index) => {
    const value = record.moisture_values[index]
    return value === null || value === undefined ? '' : String(value)
  })

  return {
    record_no: String(record.record_no),
    fiscal_year: String(record.fiscal_year),
    purchase_date: record.purchase_date ?? '',
    inspection_date: record.inspection_date ?? '',
    full_name: record.full_name,
    prefecture: record.prefecture ?? '',
    municipality: record.municipality ?? '',
    inspection_location: record.inspection_location ?? '',
    authorization_no: record.authorization_no ?? '',
    brand: record.brand ?? '',
    recommended_flexcon: record.recommended_flexcon === null ? '' : String(record.recommended_flexcon),
    paper_bags: record.paper_bags === null ? '' : String(record.paper_bags),
    bulk_quantity: record.bulk_quantity === null ? '' : String(record.bulk_quantity),
    grade: record.grade ?? '',
    reason: record.reason ?? '',
    moisture_values: moistureValues,
  }
}

function displayDate(value: string | null): string {
  return value ? value.replaceAll('-', '/') : ''
}

function displayNumber(value: number | null): string {
  return value === null ? '' : String(value)
}

function displayAverageMoisture(value: number | null): string {
  return value === null ? '' : Number(value).toFixed(1)
}

function optionalNumber(value: string): number | null {
  return value.trim() === '' ? null : Number(value)
}

function csvValue(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, '_') || '未設定'
}

function normalizeName(value: string): string {
  return value.trim().replace(/[\s　]+/g, '').toLocaleLowerCase('ja')
}

function averageMoisture(values: string[]): string {
  const measured = values
    .filter((value) => value.trim() !== '')
    .map(Number)
    .filter(Number.isFinite)
  if (measured.length === 0) return ''
  const average = measured.reduce((total, value) => total + value, 0) / measured.length
  return (Math.round(average * 10) / 10).toFixed(1)
}

function isHighMoisture(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false
  return Number(value) > 16
}

function brandTypeForPrefecture(prefecture: string): 'brand_aomori' | 'brand_iwate' | null {
  const normalized = prefecture.trim().replace(/県$/, '')
  if (normalized === '青森') return 'brand_aomori'
  if (normalized === '岩手') return 'brand_iwate'
  return null
}

export function InspectionRecordManager({ workerId }: Props) {
  const [items, setItems] = useState<InspectionRecord[]>([])
  const [authorizations, setAuthorizations] = useState<AuthorizationRecord[]>([])
  const [inspectionOptions, setInspectionOptions] = useState<InspectionOption[]>([])
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [version, setVersion] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<InspectionForm>(() => emptyForm())
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const load = async () => {
      const inspectionRequest = supabase
        .from('flexcon_inspection_records')
        .select('*')
        .order('fiscal_year', { ascending: false })
        .order('record_no', { ascending: false })
        .limit(1000)
      const authorizationRequest = supabase
        .from('flexcon_authorizations')
        .select('*')
        .order('authorization_no')

      let optionResult = await supabase
        .from('flexcon_inspection_options')
        .select('*')
        .eq('active', true)
        .order('sort_order')
        .order('name')

      if (optionResult.error?.code === '42703' && optionResult.error.message.includes('sort_order')) {
        optionResult = await supabase
          .from('flexcon_inspection_options')
          .select('*')
          .eq('active', true)
          .order('name')
      }

      const [inspectionResult, authorizationResult] = await Promise.all([
        inspectionRequest,
        authorizationRequest,
      ])

      if (inspectionResult.error) {
        setNotice({ type: 'error', text: '検査記録を取得できません。追加SQLを実行してください。' })
      } else {
        setItems((inspectionResult.data ?? []) as InspectionRecord[])
      }

      if (authorizationResult.error) {
        setNotice({ type: 'error', text: authorizationResult.error.message })
      } else {
        setAuthorizations((authorizationResult.data ?? []) as AuthorizationRecord[])
      }

      if (optionResult.error) {
        setNotice({ type: 'error', text: `検査場所と銘柄を取得できません。${optionResult.error.message}` })
      } else {
        setInspectionOptions((optionResult.data ?? []) as InspectionOption[])
      }
    }

    void load()
  }, [version])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return items
    return items.filter((item) => [
      item.record_no,
      item.fiscal_year,
      item.full_name,
      item.prefecture,
      item.municipality,
      item.inspection_location,
      item.authorization_no,
      item.brand,
      item.grade,
      item.reason,
    ].some((value) => String(value ?? '').toLowerCase().includes(term)))
  }, [items, search])

  const beginAdd = () => {
    const fiscalYear = currentFiscalYear()
    setEditingId(null)
    setForm(emptyForm(nextRecordNo(items, fiscalYear)))
    setNotice(null)
    setModalOpen(true)
  }

  const beginEdit = (record: InspectionRecord) => {
    setEditingId(record.id)
    setForm(formFromRecord(record))
    setNotice(null)
    setModalOpen(true)
  }

  const setText = (field: TextFormField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const setPrefecture = (value: string) => {
    const brandType = brandTypeForPrefecture(value)
    setForm((current) => {
      const brandIsAvailable = inspectionOptions.some((item) => (
        item.active
        && item.name === current.brand
        && (item.option_type === brandType || item.option_type === 'brand')
      ))
      return {
        ...current,
        prefecture: value,
        brand: current.brand && !brandIsAvailable ? '' : current.brand,
      }
    })
  }

  const applyAuthorizationRecord = (authorization: AuthorizationRecord) => {
    const prefecture = authorization.prefecture ?? ''
    const brandType = brandTypeForPrefecture(prefecture)
    setForm((current) => {
      const brandIsAvailable = inspectionOptions.some((item) => (
        item.active
        && item.name === current.brand
        && (item.option_type === brandType || item.option_type === 'brand')
      ))
      return {
        ...current,
        authorization_no: authorization.authorization_no,
        full_name: authorization.full_name,
        prefecture,
        municipality: authorization.municipality ?? '',
        brand: current.brand && !brandIsAvailable ? '' : current.brand,
      }
    })
  }

  const applyAuthorizationNo = (authorizationNo: string) => {
    const normalized = normalizeAuthorizationNo(authorizationNo)
    const authorization = authorizations.find((item) => (
      normalizeAuthorizationNo(item.authorization_no) === normalized
    ))
    if (authorization) applyAuthorizationRecord(authorization)
  }

  const applyAuthorizationName = (fullName: string) => {
    const normalized = normalizeName(fullName)
    const authorization = authorizations.find((item) => normalizeName(item.full_name) === normalized)
    if (authorization) applyAuthorizationRecord(authorization)
  }

  const setMoistureValue = (index: number, value: string) => {
    setForm((current) => {
      const values = [...current.moisture_values]
      values[index] = value
      return { ...current, moisture_values: values }
    })
  }

  const recommendedFlexconCount = Number(form.recommended_flexcon)
  const canCreateCertificate = editingId !== null
    && Number.isInteger(recommendedFlexconCount)
    && recommendedFlexconCount > 0

  const createCertificateCsv = () => {
    if (!canCreateCertificate) return

    const rows: (string | number)[][] = [
      ['委任状ナンバー', '氏名', '県名', '銘柄', '推フレ本数'],
      [
        form.authorization_no.trim(),
        form.full_name.trim(),
        form.prefecture.trim(),
        form.brand.trim(),
        recommendedFlexconCount,
      ],
    ]
    const csv = '\uFEFF' + rows.map((row) => row.map(csvValue).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    anchor.href = url
    anchor.download = `検査証明書取込_${safeFilePart(form.authorization_no)}_${timestamp}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return

    if (!form.record_no || Number(form.record_no) <= 0) {
      setNotice({ type: 'error', text: 'ナンバーを入力してください。' })
      return
    }
    if (!form.fiscal_year || Number(form.fiscal_year) <= 0) {
      setNotice({ type: 'error', text: '年度を入力してください。' })
      return
    }
    if (!form.full_name.trim()) {
      setNotice({ type: 'error', text: '氏名を入力してください。' })
      return
    }

    setBusy(true)
    setNotice(null)
    const { error } = await supabase.rpc('flexcon_save_inspection_record', {
      p_worker_id: workerId,
      p_record_id: editingId,
      p_record: {
        record_no: Number(form.record_no),
        fiscal_year: Number(form.fiscal_year),
        purchase_date: form.purchase_date || null,
        inspection_date: form.inspection_date || null,
        full_name: form.full_name.trim(),
        prefecture: form.prefecture.trim() || null,
        municipality: form.municipality.trim() || null,
        inspection_location: form.inspection_location.trim() || null,
        authorization_no: form.authorization_no.trim() || null,
        brand: form.brand.trim() || null,
        recommended_flexcon: optionalNumber(form.recommended_flexcon),
        paper_bags: optionalNumber(form.paper_bags),
        bulk_quantity: optionalNumber(form.bulk_quantity),
        grade: form.grade.trim() || null,
        reason: form.reason.trim() || null,
        moisture_values: form.moisture_values.map(optionalNumber),
      },
    })

    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setModalOpen(false)
      setNotice({ type: 'success', text: editingId ? '検査記録を更新しました。' : '検査記録を追加しました。' })
      setVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const moistureHeaders = Array.from({ length: MOISTURE_COUNT }, (_, index) => `水分${index + 1}`)
  const locationOptions = inspectionOptions.filter((item) => item.option_type === 'location')
  const selectedBrandType = brandTypeForPrefecture(form.prefecture)
  const brandOptions = inspectionOptions.filter((item) => (
    item.option_type === selectedBrandType || item.option_type === 'brand'
  ))
  const gradeOptions = inspectionOptions.filter((item) => item.option_type === 'grade')

  return (
    <div className="inspection-page">
      <div className="page-heading inspection-heading">
        <div><h1>検査記録</h1><p>検査情報と水分測定値を入力・確認します。</p></div>
        <button className="primary-button" type="button" onClick={beginAdd} disabled={busy}><Plus size={18} />追加</button>
      </div>

      <div className="search-row">
        <div className="search-input-wrap"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ナンバー・氏名・場所・銘柄などで検索" /></div>
      </div>

      <div className="inspection-table-wrap">
        <table className="inspection-table">
          <thead>
            <tr>
              <th>ナンバー</th>
              <th>年度</th>
              <th>仕入日</th>
              <th>検査日</th>
              <th>氏名</th>
              <th>県名</th>
              <th>市町村名</th>
              <th>検査場所</th>
              <th>委任状ナンバー</th>
              <th>銘柄</th>
              <th>推フレ</th>
              <th>紙袋</th>
              <th>バラ</th>
              <th>等級</th>
              <th>水分</th>
              <th>理由</th>
              {moistureHeaders.map((header) => <th key={header}>{header}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.map((record) => (
              <tr
                key={record.id}
                tabIndex={0}
                title="クリックして編集"
                onClick={() => beginEdit(record)}
                onKeyDown={(event) => { if (event.key === 'Enter') beginEdit(record) }}
              >
                <td>{record.record_no}</td>
                <td>{record.fiscal_year}</td>
                <td>{displayDate(record.purchase_date)}</td>
                <td>{displayDate(record.inspection_date)}</td>
                <td>{record.full_name}</td>
                <td>{record.prefecture ?? ''}</td>
                <td>{record.municipality ?? ''}</td>
                <td>{record.inspection_location ?? ''}</td>
                <td>{record.authorization_no ?? ''}</td>
                <td>{record.brand ?? ''}</td>
                <td>{displayNumber(record.recommended_flexcon)}</td>
                <td>{displayNumber(record.paper_bags)}</td>
                <td>{displayNumber(record.bulk_quantity)}</td>
                <td>{record.grade ?? ''}</td>
                <td className={isHighMoisture(record.moisture) ? 'moisture-high' : ''}>{displayAverageMoisture(record.moisture)}</td>
                <td>{record.reason ?? ''}</td>
                {Array.from({ length: MOISTURE_COUNT }, (_, index) => (
                  <td
                    className={isHighMoisture(record.moisture_values[index]) ? 'moisture-high' : ''}
                    key={`${record.id}-moisture-${index + 1}`}
                  >
                    {displayNumber(record.moisture_values[index] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty-state">該当する検査記録がありません</div>}
      </div>

      {modalOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="registration-modal inspection-modal" role="dialog" aria-modal="true" aria-labelledby="inspection-modal-title">
            <div className="modal-header">
              <div><h2 id="inspection-modal-title">{editingId ? '検査記録を編集' : '検査記録を追加'}</h2></div>
              <button className="icon-button" type="button" title="閉じる" aria-label="入力画面を閉じる" onClick={() => setModalOpen(false)} disabled={busy}><X size={21} /></button>
            </div>

            {notice?.type === 'error' && <div className="notice error">{notice.text}</div>}

            <form className="inspection-form" onSubmit={(event) => void save(event)}>
              <fieldset className="inspection-fieldset">
                <legend>基本情報</legend>
                <div className="inspection-form-grid inspection-form-row-one">
                  <label>ナンバー<input type="number" min="1" step="1" value={form.record_no} onChange={(event) => setText('record_no', event.target.value)} required /></label>
                  <label>年度<input type="number" min="1" max="99" step="1" value={form.fiscal_year} onChange={(event) => setText('fiscal_year', event.target.value)} required /></label>
                  <label>仕入日<input type="date" value={form.purchase_date} onChange={(event) => setText('purchase_date', event.target.value)} /></label>
                  <label>検査日<input type="date" value={form.inspection_date} onChange={(event) => setText('inspection_date', event.target.value)} /></label>
                </div>

                <div className="inspection-form-grid inspection-form-row-two">
                  <label>委任状ナンバー
                    <input
                      list="inspection-authorization-options"
                      value={form.authorization_no}
                      onChange={(event) => {
                        setText('authorization_no', event.target.value)
                        applyAuthorizationNo(event.target.value)
                      }}
                      onBlur={(event) => applyAuthorizationNo(event.target.value)}
                    />
                  </label>
                  <label>氏名
                    <input
                      list="inspection-name-options"
                      value={form.full_name}
                      onChange={(event) => {
                        setText('full_name', event.target.value)
                        applyAuthorizationName(event.target.value)
                      }}
                      onBlur={(event) => applyAuthorizationName(event.target.value)}
                      required
                    />
                  </label>
                  <label>県名<input value={form.prefecture} onChange={(event) => setPrefecture(event.target.value)} /></label>
                  <label>市町村名<input value={form.municipality} onChange={(event) => setText('municipality', event.target.value)} /></label>
                  <label>検査場所
                    <select value={form.inspection_location} onChange={(event) => setText('inspection_location', event.target.value)}>
                      <option value="">選択してください</option>
                      {form.inspection_location && !locationOptions.some((item) => item.name === form.inspection_location) && (
                        <option value={form.inspection_location}>{form.inspection_location}</option>
                      )}
                      {locationOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
                    </select>
                  </label>
                </div>

                <datalist id="inspection-authorization-options">
                  {authorizations.map((item) => <option key={item.id} value={item.authorization_no}>{item.full_name}</option>)}
                </datalist>
                <datalist id="inspection-name-options">
                  {authorizations.map((item) => <option key={item.id} value={item.full_name}>{item.authorization_no}</option>)}
                </datalist>

                <div className="inspection-form-grid inspection-form-row-three">
                  <label>銘柄
                    <select value={form.brand} onChange={(event) => setText('brand', event.target.value)} disabled={selectedBrandType === null}>
                      <option value="">{selectedBrandType === null ? '県名を入力してください' : '選択してください'}</option>
                      {form.brand && !brandOptions.some((item) => item.name === form.brand) && (
                        <option value={form.brand}>{form.brand}</option>
                      )}
                      {brandOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
                    </select>
                  </label>
                  <label>推フレ<input type="number" min="0" step="1" value={form.recommended_flexcon} onChange={(event) => setText('recommended_flexcon', event.target.value)} /></label>
                  <label>紙袋<input type="number" min="0" step="1" value={form.paper_bags} onChange={(event) => setText('paper_bags', event.target.value)} /></label>
                  <label>バラ<input type="number" min="0" step="1" value={form.bulk_quantity} onChange={(event) => setText('bulk_quantity', event.target.value)} /></label>
                  <label>等級
                    <select value={form.grade} onChange={(event) => setText('grade', event.target.value)}>
                      <option value="">選択してください</option>
                      {form.grade && !gradeOptions.some((item) => item.name === form.grade) && (
                        <option value={form.grade}>{form.grade}</option>
                      )}
                      {gradeOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
                    </select>
                  </label>
                  <label>理由<input value={form.reason} onChange={(event) => setText('reason', event.target.value)} /></label>
                  <label>水分
                    <input
                      className={`inspection-average-input ${isHighMoisture(averageMoisture(form.moisture_values)) ? 'moisture-high' : ''}`.trim()}
                      value={averageMoisture(form.moisture_values)}
                      readOnly
                    />
                  </label>
                </div>

                <div className="modal-actions inspection-form-actions">
                  {editingId && (
                    <button
                      className="secondary-button certificate-create-button"
                      type="button"
                      title={canCreateCertificate ? '検査証明書取込用CSVを作成' : '推フレ本数を入力してください'}
                      disabled={busy || !canCreateCertificate}
                      onClick={createCertificateCsv}
                    >
                      <FileSpreadsheet size={18} />検査証明書作成
                    </button>
                  )}
                  <button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : '保存'}</button>
                  <button className="secondary-button" type="button" onClick={() => setModalOpen(false)} disabled={busy}>取り消し</button>
                </div>
              </fieldset>

              <fieldset className="inspection-fieldset">
                <legend>水分測定値</legend>
                <div className="moisture-input-grid">
                  {form.moisture_values.map((value, index) => (
                    <label key={`moisture-input-${index + 1}`}>水分{index + 1}
                      <input
                        className={isHighMoisture(value) ? 'moisture-high' : ''}
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={value}
                        onChange={(event) => setMoistureValue(index, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </fieldset>

            </form>
          </section>
        </div>
      )}

      {notice && !modalOpen && (
        <div className={`notice operation-log ${notice.type}`} role="status" aria-live="polite">{notice.text}</div>
      )}
    </div>
  )
}
