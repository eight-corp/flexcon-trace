import { useEffect, useRef, useState } from 'react'
import { Building2, Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { TransportProfile } from '../types'
import { ToggleSwitch } from './ToggleSwitch'

type Notice = { type: 'success' | 'error'; text: string } | null

export function TransportManager({ workerId, embedded = false, onCountChange }: { workerId: string; embedded?: boolean; onCountChange?: (count: number) => void }) {
  const [items, setItems] = useState<TransportProfile[]>([])
  const [companyName, setCompanyName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const deleting = useRef(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    onCountChange?.(items.filter((item) => item.active).length)
  }, [items, onCountChange])

  const remove = async (item: TransportProfile) => {
    if (deleting.current || !window.confirm(`「${item.company_name}」を削除しますか？この操作は元に戻せません。`)) return
    deleting.current = true
    setDeletingId(item.id)
    setNotice(null)
    try {
      const { error } = await supabase.rpc('flexcon_delete_transport_profile', {
        p_worker_id: workerId,
        p_profile_id: item.id,
      })
      if (error) {
        setNotice({ type: 'error', text: error.message })
        return
      }
      if (editingId === item.id) resetForm()
      await load()
    } catch {
      setNotice({ type: 'error', text: '削除結果を確認できません。通信状態を確認して一覧を再読み込みしてください。' })
    } finally {
      deleting.current = false
      setDeletingId(null)
    }
  }

  const load = async () => {
    const { data, error } = await supabase.from('flexcon_transport_profiles').select('*').order('active', { ascending: false }).order('company_name')
    if (error) setNotice({ type: 'error', text: error.message })
    else setItems((data ?? []) as TransportProfile[])
  }

  useEffect(() => {
    void supabase.from('flexcon_transport_profiles').select('*').order('active', { ascending: false }).order('company_name')
      .then(({ data, error }) => {
        if (error) setNotice({ type: 'error', text: error.message })
        else setItems((data ?? []) as TransportProfile[])
      })
  }, [workerId])

  const resetForm = () => {
    setEditingId(null)
    setCompanyName('')
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setNotice(null)
    const { error } = editingId
      ? await supabase.rpc('flexcon_update_transport_profile', {
        p_worker_id: workerId,
        p_profile_id: editingId,
        p_company_name: companyName.trim(),
      })
      : await supabase.rpc('flexcon_add_transport_profile', {
        p_worker_id: workerId,
        p_company_name: companyName.trim(),
      })
    if (error) return setNotice({ type: 'error', text: error.message })
    const message = editingId ? '運送会社を更新しました。' : '運送会社を追加しました。'
    resetForm()
    setNotice({ type: 'success', text: message })
    await load()
  }

  const beginEdit = (item: TransportProfile) => {
    setEditingId(item.id)
    setCompanyName(item.company_name)
    setNotice(null)
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const toggle = async (item: TransportProfile) => {
    const { error } = await supabase.rpc('flexcon_set_transport_profile_active', {
      p_worker_id: workerId,
      p_profile_id: item.id,
      p_active: !item.active,
    })
    if (error) setNotice({ type: 'error', text: error.message })
    else await load()
  }

  return (
    <div>
      {!embedded && <div className="page-heading"><h1>運送会社管理</h1><p>出荷時に選択する運送会社名を管理します。</p></div>}
      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
      <form className="inspection-option-form" onSubmit={submit} ref={formRef}>
        <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} required aria-label="運送会社名" />
        <button className="primary-button" type="submit">
          {editingId ? <><Check size={18} />保存</> : <><Plus size={18} />追加</>}
        </button>
        {editingId && <button className="icon-button" type="button" title="編集を取り消す" aria-label="編集を取り消す" onClick={resetForm}><X size={18} /></button>}
      </form>

      <section>
        {!embedded && <div className="section-title"><h2>登録済み運送会社</h2><span>{items.filter((item) => item.active).length}件使用中</span></div>}
        <div className="destination-list">
          {items.map((item) => (
            <article className={`destination-item ${item.active ? '' : 'inactive-item'}`} key={item.id}>
              <Building2 size={21} color={item.active ? '#236640' : '#7a847c'} />
              <div><strong>{item.company_name}</strong></div>
              <button className="icon-button" type="button" title="編集" aria-label={`${item.company_name}を編集`} onClick={() => beginEdit(item)}><Pencil size={18} /></button>
              <ToggleSwitch checked={item.active} label={`${item.company_name}を${item.active ? '無効' : '有効'}にする`} onChange={() => void toggle(item)} />
              <button className="icon-button delete-icon" type="button" title="削除" aria-label={`${item.company_name}を削除`} disabled={deletingId !== null} onClick={() => void remove(item)}><Trash2 size={18} /></button>
            </article>
          ))}
          {items.length === 0 && <div className="empty-state">運送会社がまだありません</div>}
        </div>
      </section>
    </div>
  )
}
