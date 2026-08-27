import { useEffect, useState } from 'react'
import { MapPin, Plus, Power } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Destination } from '../types'

export function DestinationManager({ userId }: { userId: string }) {
  const [items, setItems] = useState<Destination[]>([])
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [contactName, setContactName] = useState('')
  const [message, setMessage] = useState('')

  const load = async () => {
    const { data, error } = await supabase.from('destinations').select('*').order('active', { ascending: false }).order('name')
    if (error) setMessage(error.message)
    else setItems((data ?? []) as Destination[])
  }

  useEffect(() => {
    void supabase.from('destinations').select('*').order('active', { ascending: false }).order('name')
      .then(({ data, error }) => {
        if (error) setMessage(error.message)
        else setItems((data ?? []) as Destination[])
      })
  }, [userId])

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    setMessage('')
    const { error } = await supabase.from('destinations').insert({ name: name.trim(), address: address.trim() || null, contact_name: contactName.trim() || null, created_by: userId })
    if (error) return setMessage(error.message)
    setName('')
    setAddress('')
    setContactName('')
    setMessage('納品先を追加しました。')
    await load()
  }

  const toggle = async (item: Destination) => {
    const { error } = await supabase.from('destinations').update({ active: !item.active }).eq('id', item.id)
    if (error) setMessage(error.message)
    else await load()
  }

  return (
    <div>
      <div className="page-heading"><h1>納品先管理</h1><p>出荷登録で選択する納品先を管理します。</p></div>
      {message && <div className={message.includes('追加') ? 'notice success' : 'notice error'}>{message}</div>}
      <section className="section-band">
        <div className="section-title"><h2>納品先を追加</h2></div>
        <form className="form-grid" onSubmit={add}>
          <label>納品先名<input value={name} onChange={(e) => setName(e.target.value)} required placeholder="例：〇〇精米所" /></label>
          <div className="form-grid two">
            <label>住所（任意）<input value={address} onChange={(e) => setAddress(e.target.value)} /></label>
            <label>担当者（任意）<input value={contactName} onChange={(e) => setContactName(e.target.value)} /></label>
          </div>
          <button className="primary-button" type="submit"><Plus size={18} />追加</button>
        </form>
      </section>

      <section>
        <div className="section-title"><h2>登録済み納品先</h2><span>{items.filter((item) => item.active).length}件使用中</span></div>
        <div className="destination-list">
          {items.map((item) => (
            <article className="destination-item" key={item.id} style={{ opacity: item.active ? 1 : 0.58 }}>
              <MapPin size={21} color={item.active ? '#236640' : '#7a847c'} />
              <div><strong>{item.name}</strong>{item.address && <small>{item.address}</small>}{item.contact_name && <small>担当：{item.contact_name}</small>}</div>
              <button className="icon-button" type="button" title={item.active ? '使用停止' : '使用再開'} onClick={() => void toggle(item)}><Power size={19} /></button>
            </article>
          ))}
          {items.length === 0 && <div className="empty-state">納品先がまだありません</div>}
        </div>
      </section>
    </div>
  )
}
