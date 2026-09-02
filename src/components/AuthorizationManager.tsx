import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FileUp, Plus, Save, Search, Trash2, X } from 'lucide-react'
import type { CellValue } from 'read-excel-file/browser'
import { supabase } from '../lib/supabase'
import type { AuthorizationRecord } from '../types'
import { ToggleSwitch } from './ToggleSwitch'

type Props = { workerId: string }
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

const REQUIRED_IMPORT_HEADERS = [
  [0, '№'],
  [1, '氏名'],
  [2, '種子購入伝票'],
  [3, '営農計画書'],
  [5, '住所'],
  [6, '県名'],
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

function recordToForm(record: AuthorizationRecord): FormState {
  return {
    authorization_no: record.authorization_no,
    full_name: record.full_name,
    seed_purchase_slip: record.seed_purchase_slip,
    farming_plan: record.farming_plan,
    address: record.address ?? '',
    prefecture: record.prefecture ?? '',
    municipality: record.municipality ?? '',
    phone: record.phone ?? '',
    crop_type: record.crop_type ?? '',
    feed_rice_variety: record.feed_rice_variety ?? '',
    notes: record.notes ?? '',
  }
}

export function AuthorizationManager({ workerId }: Props) {
  const [items, setItems] = useState<AuthorizationRecord[]>([])
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [version, setVersion] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importFileName, setImportFileName] = useState('')
  const [importRecords, setImportRecords] = useState<ImportRecord[]>([])
  const [importError, setImportError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void supabase.from('flexcon_authorizations').select('*').order('authorization_no')
      .then(({ data, error }) => {
        if (error) setNotice({ type: 'error', text: error.message })
        else setItems(
          ((data ?? []) as AuthorizationRecord[]).sort((left, right) => (
            AUTHORIZATION_NO_COLLATOR.compare(left.authorization_no, right.authorization_no)
          )),
        )
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
    setEditingId(null)
    setForm(EMPTY_FORM)
    setNotice(null)
    setModalOpen(true)
  }

  const beginEdit = (record: AuthorizationRecord) => {
    setEditingId(record.id)
    setForm(recordToForm(record))
    setNotice(null)
    setModalOpen(true)
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    const args = {
      p_worker_id: workerId,
      p_authorization_no: form.authorization_no.trim(),
      p_full_name: form.full_name.trim(),
      p_seed_purchase_slip: form.seed_purchase_slip,
      p_farming_plan: form.farming_plan,
      p_address: form.address.trim() || null,
      p_prefecture: form.prefecture.trim() || null,
      p_municipality: form.municipality.trim() || null,
      p_phone: form.phone.trim() || null,
      p_crop_type: form.crop_type.trim() || null,
      p_feed_rice_variety: form.feed_rice_variety.trim() || null,
      p_notes: form.notes.trim() || null,
    }
    const { error } = editingId
      ? await supabase.rpc('flexcon_update_authorization', { ...args, p_authorization_id: editingId })
      : await supabase.rpc('flexcon_add_authorization', args)

    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setModalOpen(false)
      setNotice({ type: 'success', text: editingId ? '委任状情報を更新しました。' : '委任状情報を追加しました。' })
      setVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const deleteRecord = async (record: AuthorizationRecord) => {
    if (!window.confirm(`ナンバー「${record.authorization_no}」 ${record.full_name} の委任状情報を削除しますか？`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_authorization', {
      p_worker_id: workerId,
      p_authorization_id: record.id,
    })
    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setNotice({ type: 'success', text: '委任状情報を削除しました。' })
      setVersion((value) => value + 1)
    }
    setBusy(false)
  }

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
      const missingHeader = REQUIRED_IMPORT_HEADERS.find(([index, expected]) => (
        !normalizedHeader(headers[index]).includes(normalizedHeader(expected))
      ))
      if (missingHeader) {
        throw new Error(`「委任状一覧」シートの${missingHeader[1]}列を確認できません。指定の検査記録ファイルを選択してください。`)
      }

      const parsed = rows.slice(1).flatMap((row) => {
        const authorizationNo = cellText(row[0])
        const fullName = cellText(row[1])
        if (!authorizationNo || !fullName) return []
        return [{
          authorization_no: authorizationNo,
          full_name: fullName,
          seed_purchase_slip: optionalFlag(row[2]),
          farming_plan: optionalFlag(row[3]),
          address: nullableText(row[5]),
          prefecture: nullableText(row[6]),
          municipality: nullableText(row[7]),
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
        throw new Error(`同じナンバーが複数あります: ${[...new Set(duplicateNos)].slice(0, 10).join(', ')}`)
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

      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}

      <div className="search-row">
        <div style={{ position: 'relative', flex: 1 }}><Search size={18} style={{ position: 'absolute', left: 12, top: 13, color: '#6b756d' }} /><input style={{ paddingLeft: 38 }} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ナンバー・氏名・住所などで検索" /></div>
      </div>

      <div className="authorization-table-wrap">
        <table className="authorization-table">
          <thead>
            <tr>
              <th>ナンバー</th>
              <th>氏名</th>
              <th>種子購入伝票フラグ</th>
              <th>営農計画書フラグ</th>
              <th>住所</th>
              <th>県名</th>
              <th>市町村</th>
              <th>電話番号</th>
              <th>農作物の種類</th>
              <th>飼料用米の品種</th>
              <th>備考</th>
              <th aria-label="削除" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((record) => (
              <tr
                key={record.id}
                tabIndex={0}
                title="タップして編集"
                onClick={() => beginEdit(record)}
                onKeyDown={(event) => { if (event.key === 'Enter') beginEdit(record) }}
              >
                <td className="authorization-no">{record.authorization_no}</td>
                <td className="authorization-name">{record.full_name}</td>
                <td className="flag-cell">{record.seed_purchase_slip ? <Check size={18} aria-label="あり" /> : <span aria-label="なし">-</span>}</td>
                <td className="flag-cell">{record.farming_plan ? <Check size={18} aria-label="あり" /> : <span aria-label="なし">-</span>}</td>
                <td>{record.address ?? ''}</td>
                <td>{record.prefecture ?? ''}</td>
                <td>{record.municipality ?? ''}</td>
                <td>{record.phone ?? ''}</td>
                <td>{record.crop_type ?? ''}</td>
                <td>{record.feed_rice_variety ?? ''}</td>
                <td>{record.notes ?? ''}</td>
                <td className="authorization-delete-cell">
                  <button
                    className="icon-button delete-icon"
                    type="button"
                    title="削除"
                    aria-label={`${record.authorization_no}を削除`}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation()
                      void deleteRecord(record)
                    }}
                  >
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty-state">委任状情報がありません</div>}
      </div>

      {modalOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="registration-modal authorization-modal" role="dialog" aria-modal="true" aria-labelledby="authorization-modal-title">
            <div className="modal-header">
              <div><h2 id="authorization-modal-title">{editingId ? '委任状情報を編集' : '委任状情報を追加'}</h2></div>
              <button className="icon-button" type="button" title="閉じる" aria-label="入力画面を閉じる" onClick={() => setModalOpen(false)} disabled={busy}><X size={21} /></button>
            </div>

            {notice?.type === 'error' && <div className="notice error">{notice.text}</div>}

            <form className="form-grid" onSubmit={(event) => void save(event)}>
              <div className="form-grid two">
                <label>ナンバー<input value={form.authorization_no} onChange={(event) => setText('authorization_no', event.target.value)} required /></label>
                <label>氏名<input value={form.full_name} onChange={(event) => setText('full_name', event.target.value)} required /></label>
              </div>

              <div className="authorization-flags">
                <div className="switch-field"><span>種子購入伝票フラグ</span><ToggleSwitch checked={form.seed_purchase_slip} label="種子購入伝票フラグ" onChange={() => setForm((current) => ({ ...current, seed_purchase_slip: !current.seed_purchase_slip }))} /></div>
                <div className="switch-field"><span>営農計画書フラグ</span><ToggleSwitch checked={form.farming_plan} label="営農計画書フラグ" onChange={() => setForm((current) => ({ ...current, farming_plan: !current.farming_plan }))} /></div>
              </div>

              <label>住所<input value={form.address} onChange={(event) => setText('address', event.target.value)} /></label>
              <div className="form-grid two">
                <label>県名<input value={form.prefecture} onChange={(event) => setText('prefecture', event.target.value)} /></label>
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
            <div className="import-summary"><strong>{importRecords.length}件</strong><span>同じナンバーは更新、新しいナンバーは追加されます。</span></div>
            <p className="import-note">Excelで空欄のフラグは、登録済みの値を変更しません。</p>

            <div className="import-preview">
              <table>
                <thead><tr><th>ナンバー</th><th>氏名</th><th>市町村</th><th>農作物の種類</th></tr></thead>
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
    </div>
  )
}
