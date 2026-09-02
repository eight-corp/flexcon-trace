import { useEffect, useMemo, useState } from 'react'
import { Check, Plus, Save, Search, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { AuthorizationRecord } from '../types'
import { ToggleSwitch } from './ToggleSwitch'

type Props = { workerId: string }
type Notice = { type: 'success' | 'error'; text: string } | null

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

  useEffect(() => {
    void supabase.from('flexcon_authorizations').select('*').order('authorization_no')
      .then(({ data, error }) => {
        if (error) setNotice({ type: 'error', text: error.message })
        else setItems((data ?? []) as AuthorizationRecord[])
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

  return (
    <div>
      <div className="page-heading authorization-heading">
        <div><h1>委任状一覧</h1><p>登録済みの委任状情報を確認・更新します。</p></div>
        <button className="primary-button" type="button" onClick={beginAdd}><Plus size={18} />追加</button>
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
    </div>
  )
}
