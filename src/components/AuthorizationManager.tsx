import { useEffect, useMemo, useRef, useState } from 'react'
import { FileUp, Plus, Save, Search, X } from 'lucide-react'
import type { CellValue } from 'read-excel-file/browser'
import { supabase } from '../lib/supabase'
import type { AuthorizationRecord } from '../types'
import { ToggleSwitch } from './ToggleSwitch'

type Props = {
  workerId: string
  onOpenInspections: (authorizationId: string) => void
}
type Notice = { type: 'success' | 'error'; text: string } | null

type ImportRecord = {
  authorization_no: string
  full_name: string
  seed_purchase_slip: boolean | null
  farming_plan: boolean | null
  address: string | null
  prefecture: string | null
  municipality: string | null
  phone: string | null
  crop_type: string | null
  feed_rice_variety: string | null
  notes: string | null
}

type FormState = {
  authorization_no: string
  full_name: string
  seed_purchase_slip: boolean
  farming_plan: boolean
  address: string
  prefecture: string
  municipality: string
  phone: string
  crop_type: string
  feed_rice_variety: string
  notes: string
}

type EditableTextField = Exclude<keyof FormState, 'seed_purchase_slip' | 'farming_plan'>
type EditableFlagField = 'seed_purchase_slip' | 'farming_plan'
type EditingCell = {
  recordId: string
  field: EditableTextField
  value: string
}

const EMPTY_FORM: FormState = {
  authorization_no: '',
  full_name: '',
  seed_purchase_slip: false,
  farming_plan: false,
  address: '',
  prefecture: '',
  municipality: '',
  phone: '',
  crop_type: '',
  feed_rice_variety: '',
  notes: '',
}

const AUTHORIZATION_NO_COLLATOR = new Intl.Collator('ja', {
  numeric: true,
  sensitivity: 'base',
})

const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
] as const

const REQUIRED_IMPORT_HEADERS = [
  [0, '№'],
  [1, '氏名'],
  [2, '種子購入伝票'],
  [3, '営農計画書'],
  [5, '住所'],
  [6, '産地'],
  [7, '市町村'],
  [8, '電話番号'],
  [9, '農作物の種類'],
  [11, '飼料用米の銘柄'],
  [36, '備考'],
] as const

function cellText(value: CellValue | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function nullableText(value: CellValue | null | undefined): string | null {
  return cellText(value) || null
}

function normalizedHeader(value: CellValue | null | undefined): string {
  return cellText(value).replace(/[\s　]/g, '')
}

function optionalFlag(value: CellValue | null | undefined): boolean | null {
  if (value === null || value === undefined || cellText(value) === '') return null
  if (typeof value === 'boolean') return value
  const normalized = cellText(value).toLowerCase()
  if (['0', 'false', 'なし', '無', '×', '未'].includes(normalized)) return false
  return true
}

function normalizeName(value: string): string {
  return value.trim().replace(/[\s　]+/g, '').toLocaleLowerCase('ja')
}

function extractAddressParts(address: string): { prefecture: string | null; municipality: string | null } {
  const normalized = address.trim().replace(/^[\s　]+/, '')
  const prefectureWithSuffix = PREFECTURES.find((value) => normalized.startsWith(value)) ?? null
  const prefecture = prefectureWithSuffix === '北海道'
    ? prefectureWithSuffix
    : prefectureWithSuffix?.replace(/[都道府県]$/, '') ?? null
  const localityText = (prefectureWithSuffix ? normalized.slice(prefectureWithSuffix.length) : normalized)
    .replace(/^[\s　]+/, '')

  const countyMunicipality = localityText.match(/^[^0-9０-９\s　]+?郡([^0-9０-９\s　]+?(?:町|村))/)?.[1]
  if (countyMunicipality) return { prefecture, municipality: countyMunicipality }

  const municipality = localityText.match(/^([^0-9０-９\s　]+?(?:市|区|町|村))/)?.[1] ?? null
  return { prefecture, municipality }
}

function nextAuthorizationNo(items: AuthorizationRecord[]): string {
  const numericNos = items
    .map((item) => item.authorization_no.trim())
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
    .filter(Number.isSafeInteger)

  return String((numericNos.length > 0 ? Math.max(...numericNos) : 0) + 1)
}

export function AuthorizationManager({ workerId, onOpenInspections }: Props) {
  const [items, setItems] = useState<AuthorizationRecord[]>([])
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [version, setVersion] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [rowForm, setRowForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importFileName, setImportFileName] = useState('')
  const [importRecords, setImportRecords] = useState<ImportRecord[]>([])
  const [importError, setImportError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const openInspectionTimerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (openInspectionTimerRef.current !== null) window.clearTimeout(openInspectionTimerRef.current)
  }, [])

  useEffect(() => {
    void supabase.from('flexcon_authorizations').select('*').order('authorization_no')
      .then(({ data, error }) => {
        if (error) setNotice({ type: 'error', text: error.message })
        else {
          const loadedItems = ((data ?? []) as AuthorizationRecord[]).sort((left, right) => (
            AUTHORIZATION_NO_COLLATOR.compare(left.authorization_no, right.authorization_no)
          ))
          setItems(loadedItems)
          setRowForm({ ...EMPTY_FORM, authorization_no: nextAuthorizationNo(loadedItems) })
        }
      })
  }, [version])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return items
    return items.filter((item) => [
      item.authorization_no,
      item.full_name,
      item.address,
      item.prefecture,
      item.municipality,
      item.phone,
      item.crop_type,
      item.feed_rice_variety,
      item.notes,
    ].some((value) => value?.toLowerCase().includes(term)))
  }, [items, search])

  const setText = (field: keyof FormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const beginAdd = () => {
    setForm({ ...EMPTY_FORM, authorization_no: nextAuthorizationNo(items) })
    setNotice(null)
    setModalOpen(true)
  }

  const applyAddressPartsToForm = () => {
    const parts = extractAddressParts(form.address)
    setForm((current) => ({
      ...current,
      prefecture: parts.prefecture ?? current.prefecture,
      municipality: parts.municipality ?? current.municipality,
    }))
  }

  const applyAddressPartsToRowForm = () => {
    const parts = extractAddressParts(rowForm.address)
    setRowForm((current) => ({
      ...current,
      prefecture: parts.prefecture ?? current.prefecture,
      municipality: parts.municipality ?? current.municipality,
    }))
  }

  const authorizationArgs = (record: AuthorizationRecord) => ({
    p_worker_id: workerId,
    p_authorization_no: record.authorization_no.trim(),
    p_full_name: record.full_name.trim(),
    p_seed_purchase_slip: record.seed_purchase_slip,
    p_farming_plan: record.farming_plan,
    p_address: record.address?.trim() || null,
    p_prefecture: record.prefecture?.trim() || null,
    p_municipality: record.municipality?.trim() || null,
    p_phone: record.phone?.trim() || null,
    p_crop_type: record.crop_type?.trim() || null,
    p_feed_rice_variety: record.feed_rice_variety?.trim() || null,
    p_notes: record.notes?.trim() || null,
  })

  const beginInlineEdit = (record: AuthorizationRecord, field: EditableTextField) => {
    if (busy) return
    if (openInspectionTimerRef.current !== null) {
      window.clearTimeout(openInspectionTimerRef.current)
      openInspectionTimerRef.current = null
    }
    setNotice(null)
    setEditingCell({ recordId: record.id, field, value: record[field] ?? '' })
  }

  const scheduleOpenInspections = (record: AuthorizationRecord, event: React.MouseEvent<HTMLTableRowElement>) => {
    if ((event.target as HTMLElement).closest('button, input, select, textarea')) return
    if (openInspectionTimerRef.current !== null) window.clearTimeout(openInspectionTimerRef.current)
    openInspectionTimerRef.current = window.setTimeout(() => {
      onOpenInspections(record.id)
      openInspectionTimerRef.current = null
    }, 240)
  }

  const saveInlineEdit = async () => {
    if (!editingCell || busy) return
    const record = items.find((item) => item.id === editingCell.recordId)
    if (!record) {
      setEditingCell(null)
      return
    }

    const value = editingCell.value.trim()
    if ((editingCell.field === 'authorization_no' || editingCell.field === 'full_name') && !value) {
      setNotice({ type: 'error', text: editingCell.field === 'authorization_no' ? '№を入力してください。' : '氏名を入力してください。' })
      return
    }

    const updatedRecord = {
      ...record,
      [editingCell.field]: value || null,
    }

    if (editingCell.field === 'full_name') {
      const duplicate = items.some((item) => (
        item.id !== record.id && normalizeName(item.full_name) === normalizeName(value)
      ))
      if (duplicate) {
        setNotice({ type: 'error', text: `氏名「${value}」はすでに登録されています。` })
        return
      }
    }

    if (editingCell.field === 'address') {
      const parts = extractAddressParts(value)
      updatedRecord.prefecture = parts.prefecture ?? record.prefecture
      updatedRecord.municipality = parts.municipality ?? record.municipality
    }

    setBusy(true)
    setNotice(null)
    const { error } = await supabase.rpc('flexcon_update_authorization', {
      ...authorizationArgs(updatedRecord),
      p_authorization_id: record.id,
    })

    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setEditingCell(null)
      setNotice({ type: 'success', text: '委任状情報を更新しました。' })
      setVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const toggleInlineFlag = async (record: AuthorizationRecord, field: EditableFlagField) => {
    if (busy) return
    const updatedRecord = { ...record, [field]: !record[field] }
    setBusy(true)
    setNotice(null)
    const { error } = await supabase.rpc('flexcon_update_authorization', {
      ...authorizationArgs(updatedRecord),
      p_authorization_id: record.id,
    })

    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setNotice({ type: 'success', text: '委任状情報を更新しました。' })
      setVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    const fullName = form.full_name.trim()
    if (items.some((item) => normalizeName(item.full_name) === normalizeName(fullName))) {
      setNotice({ type: 'error', text: `氏名「${fullName}」はすでに登録されています。` })
      return
    }

    const addressParts = extractAddressParts(form.address)
    setBusy(true)
    setNotice(null)
    const args = {
      p_worker_id: workerId,
      p_authorization_no: form.authorization_no.trim(),
      p_full_name: fullName,
      p_seed_purchase_slip: form.seed_purchase_slip,
      p_farming_plan: form.farming_plan,
      p_address: form.address.trim() || null,
      p_prefecture: addressParts.prefecture ?? (form.prefecture.trim() || null),
      p_municipality: addressParts.municipality ?? (form.municipality.trim() || null),
      p_phone: form.phone.trim() || null,
      p_crop_type: form.crop_type.trim() || null,
      p_feed_rice_variety: form.feed_rice_variety.trim() || null,
      p_notes: form.notes.trim() || null,
    }
    const { error } = await supabase.rpc('flexcon_add_authorization', args)

    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setModalOpen(false)
      setNotice({ type: 'success', text: '委任状情報を追加しました。' })
      setVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const saveRow = async (event: React.SyntheticEvent) => {
    event.preventDefault()
    if (busy) return

    const fullName = rowForm.full_name.trim()
    if (!fullName) {
      setNotice({ type: 'error', text: '氏名を入力してください。' })
      return
    }
    if (items.some((item) => normalizeName(item.full_name) === normalizeName(fullName))) {
      setNotice({ type: 'error', text: `氏名「${fullName}」はすでに登録されています。` })
      return
    }

    const addressParts = extractAddressParts(rowForm.address)
    setBusy(true)
    setNotice(null)
    const { error } = await supabase.rpc('flexcon_add_authorization', {
      p_worker_id: workerId,
      p_authorization_no: rowForm.authorization_no.trim(),
      p_full_name: fullName,
      p_seed_purchase_slip: rowForm.seed_purchase_slip,
      p_farming_plan: rowForm.farming_plan,
      p_address: rowForm.address.trim() || null,
      p_prefecture: addressParts.prefecture ?? (rowForm.prefecture.trim() || null),
      p_municipality: addressParts.municipality ?? (rowForm.municipality.trim() || null),
      p_phone: rowForm.phone.trim() || null,
      p_crop_type: rowForm.crop_type.trim() || null,
      p_feed_rice_variety: rowForm.feed_rice_variety.trim() || null,
      p_notes: rowForm.notes.trim() || null,
    })

    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setNotice({ type: 'success', text: '委任状情報を追加しました。' })
      setVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const rowInput = (field: EditableTextField, type: 'text' | 'tel' = 'text') => (
    <input
      className="authorization-new-row-input"
      type={type}
      value={rowForm[field]}
      readOnly={field === 'authorization_no'}
      aria-label={`新規委任状 ${field}`}
      onChange={(event) => setRowForm((current) => ({ ...current, [field]: event.target.value }))}
      onBlur={field === 'address' ? applyAddressPartsToRowForm : undefined}
    />
  )

  const chooseImportFile = () => {
    setNotice(null)
    fileInputRef.current?.click()
  }

  const prepareImport = async (file: File) => {
    setBusy(true)
    setImportError('')
    try {
      const { readSheet } = await import('read-excel-file/browser')
      const rows = await readSheet(file, '委任状一覧')
      const headers = rows[0] ?? []
      const missingHeader = REQUIRED_IMPORT_HEADERS.find(([index, expected]) => {
        const actual = normalizedHeader(headers[index])
        const acceptedHeaders = expected === '産地' ? ['産地', '県名'] : [expected]
        return !acceptedHeaders.some((accepted) => actual.includes(normalizedHeader(accepted)))
      })
      if (missingHeader) {
        throw new Error(`「委任状一覧」シートの${missingHeader[1]}列を確認できません。指定の検査記録ファイルを選択してください。`)
      }

      const parsed = rows.slice(1).flatMap((row) => {
        const authorizationNo = cellText(row[0])
        const fullName = cellText(row[1])
        if (!authorizationNo || !fullName) return []
        const address = cellText(row[5])
        const addressParts = extractAddressParts(address)
        return [{
          authorization_no: authorizationNo,
          full_name: fullName,
          seed_purchase_slip: optionalFlag(row[2]),
          farming_plan: optionalFlag(row[3]),
          address: address || null,
          prefecture: addressParts.prefecture ?? nullableText(row[6]),
          municipality: addressParts.municipality ?? nullableText(row[7]),
          phone: nullableText(row[8]),
          crop_type: nullableText(row[9]),
          feed_rice_variety: nullableText(row[11]),
          notes: nullableText(row[36]),
        } satisfies ImportRecord]
      })

      const duplicateNos = parsed
        .map((record) => record.authorization_no)
        .filter((value, index, all) => all.indexOf(value) !== index)
      if (duplicateNos.length > 0) {
        throw new Error(`同じ№が複数あります: ${[...new Set(duplicateNos)].slice(0, 10).join(', ')}`)
      }

      const duplicateNames = parsed
        .map((record) => normalizeName(record.full_name))
        .filter((value, index, all) => all.indexOf(value) !== index)
      if (duplicateNames.length > 0) {
        const duplicateName = parsed.find((record) => normalizeName(record.full_name) === duplicateNames[0])?.full_name
        throw new Error(`氏名「${duplicateName}」がExcel内に複数あります。`)
      }

      const existingNameConflict = parsed.find((record) => items.some((item) => (
        item.authorization_no !== record.authorization_no
        && normalizeName(item.full_name) === normalizeName(record.full_name)
      )))
      if (existingNameConflict) {
        throw new Error(`氏名「${existingNameConflict.full_name}」は別の№で登録済みです。`)
      }
      if (parsed.length === 0) throw new Error('取込可能な委任状情報がありません。')

      setImportFileName(file.name)
      setImportRecords(parsed)
      setImportOpen(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Excelファイルを読み込めませんでした。'
      setNotice({ type: 'error', text: message })
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const executeImport = async () => {
    setBusy(true)
    setImportError('')
    const { data, error } = await supabase.rpc('flexcon_import_authorizations', {
      p_worker_id: workerId,
      p_records: importRecords,
    })
    if (error) {
      setImportError(error.message)
    } else {
      const result = data as { inserted?: number; updated?: number } | null
      setImportOpen(false)
      setNotice({
        type: 'success',
        text: `Excelから${importRecords.length}件を取り込みました（追加${result?.inserted ?? 0}件・更新${result?.updated ?? 0}件）。`,
      })
      setVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const editableCell = (
    record: AuthorizationRecord,
    field: EditableTextField,
    className?: string,
  ) => {
    const isEditing = editingCell?.recordId === record.id && editingCell.field === field
    const value = record[field] ?? ''

    return (
      <td
        className={`${className ?? ''} ${isEditing ? 'authorization-cell-editing' : 'authorization-editable-cell'}`.trim()}
        tabIndex={0}
        title="ダブルクリックして編集"
        onDoubleClick={() => beginInlineEdit(record, field)}
        onKeyDown={(event) => {
          if (!isEditing && event.key === 'Enter') beginInlineEdit(record, field)
        }}
      >
        {isEditing ? (
          <input
            className="authorization-cell-editor"
            type={field === 'phone' ? 'tel' : 'text'}
            value={editingCell.value}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setEditingCell((current) => (
              current ? { ...current, value: event.target.value } : current
            ))}
            onBlur={() => setEditingCell(null)}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                void saveInlineEdit()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setEditingCell(null)
              }
            }}
          />
        ) : value}
      </td>
    )
  }

  return (
    <div className="authorization-page">
      <div className="page-heading authorization-heading">
        <div><h1>委任状一覧</h1><p>登録済みの委任状情報を確認・更新します。</p></div>
        <div className="authorization-heading-actions">
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void prepareImport(file)
            }}
          />
          <button className="secondary-button" type="button" onClick={chooseImportFile} disabled={busy}><FileUp size={18} />Excel取込</button>
          <button className="primary-button" type="button" onClick={beginAdd} disabled={busy}><Plus size={18} />追加</button>
        </div>
      </div>

      <div className="search-row">
        <div style={{ position: 'relative', flex: 1 }}><Search size={18} style={{ position: 'absolute', left: 12, top: 13, color: '#6b756d' }} /><input style={{ paddingLeft: 38 }} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="№・氏名・住所などで検索" /></div>
      </div>

      <div className="authorization-table-wrap">
        <table className="authorization-table">
          <thead>
            <tr>
              <th>№</th>
              <th>氏名</th>
              <th>種子購入伝票</th>
              <th>営農計画書</th>
              <th>住所</th>
              <th>産地</th>
              <th>市町村</th>
              <th>電話番号</th>
              <th>農作物の種類</th>
              <th>飼料用米の品種</th>
              <th>備考</th>
              <th className="authorization-register-header">登録</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((record) => (
              <tr className="authorization-data-row" key={record.id} onClick={(event) => scheduleOpenInspections(record, event)}>
                {editableCell(record, 'authorization_no', 'authorization-no')}
                {editableCell(record, 'full_name', 'authorization-name')}
                <td className="flag-cell">
                  <ToggleSwitch
                    checked={record.seed_purchase_slip}
                    label={`${record.authorization_no} 種子購入伝票`}
                    onChange={() => void toggleInlineFlag(record, 'seed_purchase_slip')}
                  />
                </td>
                <td className="flag-cell">
                  <ToggleSwitch
                    checked={record.farming_plan}
                    label={`${record.authorization_no} 営農計画書`}
                    onChange={() => void toggleInlineFlag(record, 'farming_plan')}
                  />
                </td>
                {editableCell(record, 'address')}
                {editableCell(record, 'prefecture')}
                {editableCell(record, 'municipality')}
                {editableCell(record, 'phone')}
                {editableCell(record, 'crop_type')}
                {editableCell(record, 'feed_rice_variety')}
                {editableCell(record, 'notes')}
                <td className="authorization-register-cell" />
              </tr>
            ))}
            <tr className="authorization-new-row">
              <td className="authorization-no">{rowInput('authorization_no')}</td>
              <td className="authorization-name">{rowInput('full_name')}</td>
              <td className="flag-cell">
                <ToggleSwitch
                  checked={rowForm.seed_purchase_slip}
                  label="新規委任状 種子購入伝票"
                  onChange={() => setRowForm((current) => ({ ...current, seed_purchase_slip: !current.seed_purchase_slip }))}
                />
              </td>
              <td className="flag-cell">
                <ToggleSwitch
                  checked={rowForm.farming_plan}
                  label="新規委任状 営農計画書"
                  onChange={() => setRowForm((current) => ({ ...current, farming_plan: !current.farming_plan }))}
                />
              </td>
              <td>{rowInput('address')}</td>
              <td>{rowInput('prefecture')}</td>
              <td>{rowInput('municipality')}</td>
              <td>{rowInput('phone', 'tel')}</td>
              <td>{rowInput('crop_type')}</td>
              <td>{rowInput('feed_rice_variety')}</td>
              <td>{rowInput('notes')}</td>
              <td className="authorization-register-cell">
                <button
                  className="icon-button authorization-row-save"
                  type="button"
                  title="この行を登録"
                  aria-label="この行を登録"
                  disabled={busy}
                  onClick={(event) => void saveRow(event)}
                >
                  <Save size={18} />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty-state">委任状情報がありません</div>}
      </div>

      {modalOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="registration-modal authorization-modal" role="dialog" aria-modal="true" aria-labelledby="authorization-modal-title">
            <div className="modal-header">
              <div><h2 id="authorization-modal-title">委任状情報を追加</h2></div>
              <button className="icon-button" type="button" title="閉じる" aria-label="入力画面を閉じる" onClick={() => setModalOpen(false)} disabled={busy}><X size={21} /></button>
            </div>

            <form className="form-grid" onSubmit={(event) => void save(event)}>
              <div className="form-grid two">
                <label>№<input value={form.authorization_no} onChange={(event) => setText('authorization_no', event.target.value)} required /></label>
                <label>氏名<input value={form.full_name} onChange={(event) => setText('full_name', event.target.value)} required /></label>
              </div>

              <div className="authorization-flags">
                <div className="switch-field"><span>種子購入伝票</span><ToggleSwitch checked={form.seed_purchase_slip} label="種子購入伝票" onChange={() => setForm((current) => ({ ...current, seed_purchase_slip: !current.seed_purchase_slip }))} /></div>
                <div className="switch-field"><span>営農計画書</span><ToggleSwitch checked={form.farming_plan} label="営農計画書" onChange={() => setForm((current) => ({ ...current, farming_plan: !current.farming_plan }))} /></div>
              </div>

              <label>住所<input value={form.address} onChange={(event) => setText('address', event.target.value)} onBlur={applyAddressPartsToForm} /></label>
              <div className="form-grid two">
                <label>産地<input value={form.prefecture} onChange={(event) => setText('prefecture', event.target.value)} /></label>
                <label>市町村<input value={form.municipality} onChange={(event) => setText('municipality', event.target.value)} /></label>
                <label>電話番号<input type="tel" value={form.phone} onChange={(event) => setText('phone', event.target.value)} /></label>
                <label>農作物の種類<input value={form.crop_type} onChange={(event) => setText('crop_type', event.target.value)} /></label>
                <label>飼料用米の品種<input value={form.feed_rice_variety} onChange={(event) => setText('feed_rice_variety', event.target.value)} /></label>
              </div>
              <label>備考<textarea rows={3} value={form.notes} onChange={(event) => setText('notes', event.target.value)} /></label>

              <div className="modal-actions">
                <button className="secondary-button" type="button" onClick={() => setModalOpen(false)} disabled={busy}>取消</button>
                <button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : '保存'}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {importOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="registration-modal authorization-import-modal" role="dialog" aria-modal="true" aria-labelledby="authorization-import-title">
            <div className="modal-header">
              <div><h2 id="authorization-import-title">Excel取込の確認</h2><p>{importFileName}</p></div>
              <button className="icon-button" type="button" title="閉じる" aria-label="取込画面を閉じる" onClick={() => setImportOpen(false)} disabled={busy}><X size={21} /></button>
            </div>

            {importError && <div className="notice error">{importError}</div>}
            <div className="import-summary"><strong>{importRecords.length}件</strong><span>同じ№は更新、新しい№は追加されます。</span></div>
            <p className="import-note">Excelで空欄のフラグは、登録済みの値を変更しません。</p>

            <div className="import-preview">
              <table>
                <thead><tr><th>№</th><th>氏名</th><th>市町村</th><th>農作物の種類</th></tr></thead>
                <tbody>
                  {importRecords.slice(0, 5).map((record) => (
                    <tr key={record.authorization_no}><td>{record.authorization_no}</td><td>{record.full_name}</td><td>{record.municipality ?? ''}</td><td>{record.crop_type ?? ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {importRecords.length > 5 && <p className="import-preview-more">ほか {importRecords.length - 5}件</p>}

            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setImportOpen(false)} disabled={busy}>取消</button>
              <button className="primary-button" type="button" onClick={() => void executeImport()} disabled={busy}><FileUp size={18} />{busy ? '取込中...' : '取込を実行'}</button>
            </div>
          </section>
        </div>
      )}

      {notice && (
        <div className={`notice operation-log ${notice.type}`} role="status" aria-live="polite">
          {notice.text}
        </div>
      )}
    </div>
  )
}
