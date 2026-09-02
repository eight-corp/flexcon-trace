import { useEffect, useState } from 'react'
import { Building2, Check, Pencil, Plus, Truck, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { TransportProfile } from '../types'
import { ToggleSwitch } from './ToggleSwitch'

type Notice = { type: 'success' | 'error'; text: string } | null

export function TransportManager({ workerId }: { workerId: string }) {
  const [items, setItems] = useState<TransportProfile[]>([])
  const [companyName, setCompanyName] = useState('')
  const [driverName, setDriverName] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editCompanyName, setEditCompanyName] = useState('')
  const [editDriverName, setEditDriverName] = useState('')
  const [editVehicleNo, setEditVehicleNo] = useState('')
  const [notice, setNotice] = useState<Notice>(null)

  const load = async () => {
    const { data, error } = await supabase.from('flexcon_transport_profiles').select('*').order('active', { ascending: false }).order('company_name').order('driver_name')
    if (error) setNotice({ type: 'error', text: error.message })
    else setItems((data ?? []) as TransportProfile[])
  }

  useEffect(() => {
    void supabase.from('flexcon_transport_profiles').select('*').order('active', { ascending: false }).order('company_name').order('driver_name')
      .then(({ data, error }) => {
        if (error) setNotice({ type: 'error', text: error.message })
        else setItems((data ?? []) as TransportProfile[])
      })
  }, [workerId])

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    setNotice(null)
    const { error } = await supabase.rpc('flexcon_add_transport_profile', {
      p_worker_id: workerId,
      p_company_name: companyName.trim(),
      p_driver_name: driverName.trim(),
      p_vehicle_no: vehicleNo.trim(),
    })
    if (error) return setNotice({ type: 'error', text: error.message })
    setCompanyName('')
    setDriverName('')
    setVehicleNo('')
    setNotice({ type: 'success', text: '運送会社情報を追加しました。' })
    await load()
  }

  const beginEdit = (item: TransportProfile) => {
    setEditingId(item.id)
    setEditCompanyName(item.company_name)
    setEditDriverName(item.driver_name)
    setEditVehicleNo(item.vehicle_no)
    setNotice(null)
  }

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editingId) return
    const { error } = await supabase.rpc('flexcon_update_transport_profile', {
      p_worker_id: workerId,
      p_profile_id: editingId,
      p_company_name: editCompanyName.trim(),
      p_driver_name: editDriverName.trim(),
      p_vehicle_no: editVehicleNo.trim(),
    })
    if (error) return setNotice({ type: 'error', text: error.message })
    setEditingId(null)
    setNotice({ type: 'success', text: '運送会社情報を更新しました。' })
    await load()
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
      <div className="page-heading"><h1>運送会社管理</h1><p>出荷時に選択する会社、ドライバー、車両番号を管理します。</p></div>
      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
      <section className="section-band">
        <div className="section-title"><h2>運送会社情報を追加</h2></div>
        <form className="form-grid" onSubmit={add}>
          <label>運送会社名<input value={companyName} onChange={(e) => setCompanyName(e.target.value)} required placeholder="例：〇〇運送" /></label>
          <div className="form-grid two">
            <label>ドライバー名<input value={driverName} onChange={(e) => setDriverName(e.target.value)} required /></label>
            <label>車両番号<input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} required placeholder="例：岩手 100 あ 12-34" /></label>
          </div>
          <button className="primary-button" type="submit"><Plus size={18} />追加</button>
        </form>
      </section>

      <section>
        <div className="section-title"><h2>登録済み運送会社情報</h2><span>{items.filter((item) => item.active).length}件使用中</span></div>
        <div className="destination-list">
          {items.map((item) => editingId === item.id ? (
            <article className="destination-item editing-item" key={item.id}>
              <form className="form-grid" onSubmit={saveEdit}>
                <label>運送会社名<input value={editCompanyName} onChange={(e) => setEditCompanyName(e.target.value)} required /></label>
                <div className="form-grid two">
                  <label>ドライバー名<input value={editDriverName} onChange={(e) => setEditDriverName(e.target.value)} required /></label>
                  <label>車両番号<input value={editVehicleNo} onChange={(e) => setEditVehicleNo(e.target.value)} required /></label>
                </div>
                <div className="button-row">
                  <button className="primary-button" type="submit"><Check size={18} />保存</button>
                  <button className="secondary-button" type="button" onClick={() => setEditingId(null)}><X size={18} />取消</button>
                </div>
              </form>
            </article>
          ) : (
            <article className={`destination-item ${item.active ? '' : 'inactive-item'}`} key={item.id}>
              <Building2 size={21} color={item.active ? '#236640' : '#7a847c'} />
              <div>
                <strong>{item.company_name}</strong>
                <small>ドライバー：{item.driver_name}</small>
                <small><Truck size={13} className="inline-icon" />{item.vehicle_no}</small>
              </div>
              <button className="icon-button" type="button" title="編集" aria-label={`${item.company_name}を編集`} onClick={() => beginEdit(item)}><Pencil size={18} /></button>
              <ToggleSwitch checked={item.active} label={`${item.company_name}を${item.active ? '無効' : '有効'}にする`} onChange={() => void toggle(item)} />
            </article>
          ))}
          {items.length === 0 && <div className="empty-state">運送会社情報がまだありません</div>}
        </div>
      </section>
    </div>
  )
}
