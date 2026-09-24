import { useEffect, useState, type FormEvent } from 'react'
import { Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useCalendarMode } from '../lib/calendarMode'
import { ToggleSwitch } from './ToggleSwitch'

type Memo = {
  memo_no: number
  body: string
  created_by_worker_id: string
  created_by_worker_name: string
  created_at: string
  updated_at: string
  is_public: boolean
}

type Dialog = { mode: 'new' | 'view' | 'edit'; memo: Memo | null }

export function MemoManager({ workerId }: { workerId: string }) {
  const { formatDateTime } = useCalendarMode()
  const [memos, setMemos] = useState<Memo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [draft, setDraft] = useState('')
  const [isPublic, setIsPublic] = useState(false)
  const [visibilityBusyNo, setVisibilityBusyNo] = useState<number | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let active = true
    void supabase.rpc('flexcon_list_memos', { p_worker_id: workerId }).then(({ data, error: loadError }) => {
      if (!active) return
      if (loadError || ((data ?? []) as Memo[]).some((memo) => typeof memo.is_public !== 'boolean')) {
        setMemos([])
        setError(loadError
          ? (loadError.code === 'PGRST202' ? 'メモ書き用のSQLを実行してください。' : loadError.message)
          : 'メモ公開設定用のSQLを実行してください。')
      } else {
        setMemos((data ?? []) as Memo[])
        setError('')
      }
      setLoading(false)
    })
    return () => { active = false }
  }, [workerId, version])

  const openNew = () => {
    setDraft('')
    setIsPublic(false)
    setError('')
    setDialog({ mode: 'new', memo: null })
  }

  const openMemo = (memo: Memo) => {
    setDraft(memo.body)
    setIsPublic(memo.is_public)
    setError('')
    setDialog({ mode: 'view', memo })
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!dialog || dialog.mode === 'view' || busy) return
    if (!draft.trim()) {
      setError('メモ内容を入力してください。')
      return
    }
    if (draft.length > 10000) {
      setError('メモは10000文字以内で入力してください。')
      return
    }
    if (dialog.mode === 'edit' && dialog.memo?.created_by_worker_id !== workerId) {
      setError('作成者本人のメモのみ編集できます。')
      return
    }

    setBusy(true)
    setError('')
    const result = dialog.mode === 'new'
      ? await supabase.rpc('flexcon_add_memo_visible', { p_worker_id: workerId, p_body: draft, p_is_public: isPublic })
      : await supabase.rpc('flexcon_update_memo_visible', { p_worker_id: workerId, p_memo_no: dialog.memo!.memo_no, p_body: draft, p_is_public: isPublic })
    setBusy(false)
    if (result.error) {
      setError(result.error.code === 'PGRST202' ? 'メモ公開設定用のSQLを実行してください。' : result.error.message)
      return
    }
    setDialog(null)
    setVersion((current) => current + 1)
  }

  const changeVisibility = async (memo: Memo) => {
    if (memo.created_by_worker_id !== workerId || visibilityBusyNo !== null) return
    setVisibilityBusyNo(memo.memo_no)
    setError('')
    const { error: updateError } = await supabase.rpc('flexcon_set_memo_visibility', {
      p_worker_id: workerId,
      p_memo_no: memo.memo_no,
      p_is_public: !memo.is_public,
    })
    setVisibilityBusyNo(null)
    if (updateError) {
      setError(updateError.code === 'PGRST202' ? 'メモ公開設定用のSQLを実行してください。' : updateError.message)
      return
    }
    setMemos((current) => current.map((item) => item.memo_no === memo.memo_no ? { ...item, is_public: !memo.is_public } : item))
  }

  const remove = async () => {
    if (!dialog?.memo || dialog.mode !== 'view' || busy) return
    if (dialog.memo.created_by_worker_id !== workerId) {
      setError('作成者本人のメモのみ削除できます。')
      return
    }
    if (!window.confirm(`No. ${dialog.memo.memo_no} のメモを削除しますか？\nこの操作は取り消せません。`)) return

    setBusy(true)
    setError('')
    const { error: deleteError } = await supabase.rpc('flexcon_delete_memo', {
      p_worker_id: workerId,
      p_memo_no: dialog.memo.memo_no,
    })
    setBusy(false)
    if (deleteError) {
      setError(deleteError.code === 'PGRST202' ? 'メモ削除用のSQLを実行してください。' : deleteError.message)
      return
    }
    setDialog(null)
    setVersion((current) => current + 1)
  }

  return <div className="memo-page">
    <div className="memo-actions"><button className="primary-button" type="button" onClick={openNew}><Plus size={18} />追加</button></div>
    {error && !dialog && <div className="notice error" role="alert">{error}</div>}
    <div className="memo-table-wrap">
      <table className="memo-table">
        <thead><tr><th>No.</th><th>日時</th><th>作成者</th><th>公開</th><th>メモ内容</th></tr></thead>
        <tbody>
          {memos.map((memo) => <tr key={memo.memo_no} tabIndex={0} onDoubleClick={() => openMemo(memo)} onKeyDown={(event) => { if (event.key === 'Enter') openMemo(memo) }} title="ダブルクリックで全文を表示">
            <td className="numeric-cell">{memo.memo_no}</td>
            <td>{formatDateTime(memo.created_at)}</td>
            <td>{memo.created_by_worker_name}</td>
            <td className="memo-visibility-cell" onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
              <div>
                <ToggleSwitch checked={memo.is_public} label={memo.created_by_worker_id === workerId ? `No. ${memo.memo_no}を${memo.is_public ? '自分だけ' : '公開'}にする` : `No. ${memo.memo_no} は公開メモ`} disabled={memo.created_by_worker_id !== workerId || visibilityBusyNo !== null} onChange={() => void changeVisibility(memo)} />
                <span>{memo.is_public ? '公開' : '自分だけ'}</span>
              </div>
            </td>
            <td><span className="memo-preview">{memo.body.split(/\r\n|\r|\n/)[0]}</span></td>
          </tr>)}
          {!loading && memos.length === 0 && <tr><td className="empty-state" colSpan={5}>メモはまだありません</td></tr>}
          {loading && <tr><td className="empty-state" colSpan={5}>読み込み中...</td></tr>}
        </tbody>
      </table>
    </div>

    {dialog && <div className="modal-backdrop" role="presentation"><section className="registration-modal memo-dialog" role="dialog" aria-modal="true" aria-labelledby="memo-dialog-title">
      <div className="modal-header">
        <div><h2 id="memo-dialog-title">{dialog.mode === 'new' ? 'メモを追加' : `No. ${dialog.memo?.memo_no}`}</h2>
          {dialog.memo && <p>{formatDateTime(dialog.memo.created_at)}　{dialog.memo.created_by_worker_name}</p>}
        </div>
        <button className="icon-button" type="button" title="閉じる" aria-label="閉じる" onClick={() => setDialog(null)} disabled={busy}><X size={20} /></button>
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {dialog.mode === 'view' ? <>
        <div className="memo-dialog-actions">
          {dialog.memo?.created_by_worker_id === workerId && <>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => { setDraft(dialog.memo!.body); setError(''); setDialog({ ...dialog, mode: 'edit' }) }}><Pencil size={17} />編集</button>
            <button className="danger-button" type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={17} />削除</button>
          </>}
        </div>
        <div className="memo-full-text">{dialog.memo?.body}</div>
      </> : <form onSubmit={(event) => void save(event)}>
        <div className="memo-dialog-actions">
          <button className="secondary-button" type="button" onClick={() => { setError(''); setDialog(dialog.memo ? { mode: 'view', memo: dialog.memo } : null) }} disabled={busy}>取消</button>
          <button className="primary-button" type="submit" disabled={busy || !draft.trim()}><Save size={17} />{busy ? '保存中...' : '保存'}</button>
        </div>
        <div className="switch-field memo-visibility-field"><span>{isPublic ? '公開' : '自分だけ'}</span><ToggleSwitch checked={isPublic} label="メモを公開する" onChange={() => setIsPublic((current) => !current)} disabled={busy} /></div>
        <label className="memo-body-field">メモ内容<textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={10000} rows={12} autoFocus required /></label>
      </form>}
    </section></div>}
  </div>
}
