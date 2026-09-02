import { useEffect, useRef, useState } from 'react'
import { Check, MapPin, Pencil, Plus, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Destination } from '../types'
import { ToggleSwitch } from './ToggleSwitch'

type Notice = { type: 'success' | 'error'; text: string } | null

export function DestinationManager({ workerId }: { workerId: string }) {
  const [items, setItems] = useState<Destination[]>([])
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const formRef = useRef<HTMLElement>(null)

  const load = async () => {
    const { data, error } = await supabase.from('flexcon_destinations').select('*').order('active', { ascending: false }).order('name')
    if (error) setNotice({ type: 'error', text: error.message })
    else setItems((data ?? []) as Destination[])
  }

  useEffect(() => {
    void supabase.from('flexcon_destinations').select('*').order('active', { ascending: false }).order('name')
      .then(({ data, error }) => {
        if (error) setNotice({ type: 'error', text: error.message })
        else setItems((data ?? []) as Destination[])
      })
  }, [workerId])

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setAddress('')
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setNotice(null)
    const { error } = editingId
      ? await supabase.rpc('flexcon_update_destination', {
        p_worker_id: workerId,
        p_destination_id: editingId,
        p_name: name.trim(),
        p_address: address.trim() || null,
        p_contact_name: null,
      })
      : await supabase.rpc('flexcon_add_destination', {
        p_worker_id: workerId,
        p_name: name.trim(),
        p_address: address.trim() || null,
        p_contact_name: null,
      })
    if (error) return setNotice({ type: 'error', text: error.message })
    const message = editingId ? '納品先を更新しました。' : '納品先を追加しました。'
    resetForm()
    setNotice({ type: 'success', text: message })
    await load()
  }

  const beginEdit = (item: Destination) => {
    setEditingId(item.id)
    setName(item.name)
    setAddress(item.address ?? '')
    setNotice(null)
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const toggle = async (item: Destination) => {
    const { error } = await supabase.rpc('flexcon_set_destination_active', {
      p_worker_id: workerId,
      p_destination_id: item.id,
      p_active: !item.active,
    })
    if (error) setNotice({ type: 'error', text: error.message })
    else await load()
  }

  return (
    <div>
      <div className="page-heading"><h1>納品先管理</h1><p>出荷登録で選択する納品先を管理します。</p></div>
      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
      <section className={`section-band master-form ${editingId ? 'master-form-active' : ''}`} ref={formRef}>
        <div className="section-title"><h2>{editingId ? '納品先を編集' : '納品先を追加'}</h2></div>
        <form className="form-grid" onSubmit={submit}>
          <label>納品先名<input value={name} onChange={(e) => setName(e.target.value)} required placeholder="例：〇〇精米所" /></label>
          <label>住所（任意）<input value={address} onChange={(e) => setAddress(e.target.value)} /></label>
          <div className="button-row">
            <button className="primary-button" type="submit">
              {editingId ? <><Check size={18} />保存</> : <><Plus size={18} />追加</>}
            </button>
            {editingId && <button className="secondary-button" type="button" onClick={resetForm}><X size={18} />取消</button>}
          </div>
        </form>
      </section>

      <section>
        <div className="section-title"><h2>登録済み納品先</h2><span>{items.filter((item) => item.active).length}件使用中</span></div>
        <div className="destination-list">
          {items.map((item) => (
            <article className={`destination-item ${item.active ? '' : 'inactive-item'}`} key={item.id}>
              <MapPin size={21} color={item.active ? '#236640' : '#7a847c'} />
              <div><strong>{item.name}</strong>{item.address && <small>{item.address}</small>}</div>
              <button className="icon-button" type="button" title="編集" aria-label={`${item.name}を編集`} onClick={() => beginEdit(item)}><Pencil size={18} /></button>
              <ToggleSwitch checked={item.active} label={`${item.name}を${item.active ? '無効' : '有効'}にする`} onChange={() => void toggle(item)} />
            </article>
          ))}
          {items.length === 0 && <div className="empty-state">納品先がまだありません</div>}
        </div>
      </section>
    </div>
  )
}
