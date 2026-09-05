import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Award, Building2, Check, ChevronDown, ListChecks, MapPin, Pencil, Plus, Scale, Tags, Trash2, Truck, UserCheck, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { InspectionOption, InspectionWeight } from '../types'
import { DestinationManager } from './DestinationManager'
import { ToggleSwitch } from './ToggleSwitch'
import { TransportManager } from './TransportManager'

type Props = { workerId: string }
type OptionType = InspectionOption['option_type']
type Notice = { type: 'success' | 'error'; text: string } | null
type WeightValues = Record<InspectionWeight['weight_type'], number>

type SectionProps = {
  workerId: string
  optionType: OptionType
  title: string
  items: InspectionOption[]
  supportsDescription?: boolean
  onChanged: (message: string) => void
  onError: (message: string) => void
}

function OptionSection({ workerId, optionType, title, items, supportsDescription = false, onChanged, onError }: SectionProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setEditingId(null)
    setName('')
    setDescription('')
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_save_inspection_option', {
      p_worker_id: workerId,
      p_option_id: editingId,
      p_option_type: optionType,
      p_name: name.trim(),
      p_description: supportsDescription ? description.trim() || null : null,
    })
    setBusy(false)
    if (error) {
      onError(error.message)
      return
    }
    const action = editingId ? '更新' : '追加'
    reset()
    onChanged(`${title}を${action}しました。`)
  }

  const beginEdit = (item: InspectionOption) => {
    setEditingId(item.id)
    setName(item.name)
    setDescription(item.description ?? '')
  }

  const remove = async (item: InspectionOption) => {
    if (busy || !window.confirm(`「${item.name}」を削除しますか？登録済みの検査記録は変更されません。`)) return
    setBusy(true)
    try {
      const { error } = await supabase.rpc('flexcon_delete_inspection_option', {
        p_worker_id: workerId,
        p_option_id: item.id,
      })
      if (error) onError(error.message)
      else {
        if (editingId === item.id) reset()
        onChanged('マスタ項目を削除しました。')
      }
    } catch {
      onError('削除結果を確認できません。通信状態を確認して一覧を再読み込みしてください。')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (item: InspectionOption) => {
    if (busy) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_set_inspection_option_active', {
      p_worker_id: workerId,
      p_option_id: item.id,
      p_active: !item.active,
    })
    setBusy(false)
    if (error) onError(error.message)
    else onChanged(`${item.name}を${item.active ? '無効' : '有効'}にしました。`)
  }

  const move = async (item: InspectionOption, direction: -1 | 1) => {
    if (busy) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_reorder_inspection_option', {
      p_worker_id: workerId,
      p_option_id: item.id,
      p_direction: direction,
    })
    setBusy(false)
    if (error) onError(error.message)
    else onChanged(`${item.name}の表示順を変更しました。`)
  }

  const Icon = optionType === 'location' ? MapPin : optionType === 'inspector' ? UserCheck : optionType === 'grade' ? Award : optionType === 'grade_reason' ? ListChecks : Tags

  return (
    <details className="master-accordion inspection-option-section">
      <summary className="master-accordion-summary">
        <span><Icon size={20} />{title}</span>
        <span>{items.filter((item) => item.active).length}件使用中<ChevronDown className="master-accordion-chevron" size={20} /></span>
      </summary>
      <div className="master-accordion-content">
        <form className={`inspection-option-form ${supportsDescription ? 'with-description' : ''}`} onSubmit={(event) => void submit(event)}>
          <input value={name} onChange={(event) => setName(event.target.value)} required placeholder={`${title}名`} aria-label={`${title}名`} />
          <button className="primary-button" type="submit" disabled={busy}>
            {editingId ? <><Check size={18} />保存</> : <><Plus size={18} />追加</>}
          </button>
          {editingId && (
            <button className="icon-button" type="button" title="編集を取り消す" aria-label="編集を取り消す" onClick={reset} disabled={busy}><X size={18} /></button>
          )}
          {supportsDescription && <label className="inspection-option-description-field"><span>説明文</span><textarea rows={2} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="任意" aria-label={`${title}の説明文`} /></label>}
        </form>

        <div className="inspection-option-list">
          {items.map((item, index) => (
            <div className={`inspection-option-row ${item.active ? '' : 'inactive-item'}`} key={item.id}>
              <Icon size={19} color={item.active ? '#236640' : '#7a847c'} />
              <div className="inspection-option-copy"><strong>{item.name}</strong>{supportsDescription && item.description && <p>{item.description}</p>}</div>
              <div className="inspection-option-order-buttons">
                <button className="icon-button" type="button" title="上へ移動" aria-label={`${item.name}を上へ移動`} onClick={() => void move(item, -1)} disabled={busy || index === 0}><ArrowUp size={16} /></button>
                <button className="icon-button" type="button" title="下へ移動" aria-label={`${item.name}を下へ移動`} onClick={() => void move(item, 1)} disabled={busy || index === items.length - 1}><ArrowDown size={16} /></button>
              </div>
              <button className="icon-button" type="button" title="編集" aria-label={`${item.name}を編集`} onClick={() => beginEdit(item)} disabled={busy}><Pencil size={17} /></button>
              <ToggleSwitch checked={item.active} label={`${item.name}を${item.active ? '無効' : '有効'}にする`} onChange={() => void toggle(item)} />
              <button className="icon-button delete-icon" type="button" title="削除" aria-label={`${item.name}を削除`} disabled={busy} onClick={() => void remove(item)}><Trash2 size={17} /></button>
            </div>
          ))}
          {items.length === 0 && <div className="empty-state">登録されていません</div>}
        </div>
      </div>
    </details>
  )
}

function InspectionWeightSection({
  workerId,
  weights,
  onChanged,
  onError,
}: {
  workerId: string
  weights: WeightValues
  onChanged: (message: string) => void
  onError: (message: string) => void
}) {
  const [brandedRiceWeight, setBrandedRiceWeight] = useState(String(weights.branded_rice))
  const [feedRiceWeight, setFeedRiceWeight] = useState(String(weights.feed_rice))
  const [busy, setBusy] = useState(false)

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return

    const branded = Number(brandedRiceWeight)
    const feed = Number(feedRiceWeight)
    if (!Number.isInteger(branded) || branded <= 0 || !Number.isInteger(feed) || feed <= 0) {
      onError('量目は1以上の整数で入力してください。')
      return
    }

    setBusy(true)
    const { error } = await supabase.rpc('flexcon_save_inspection_weights', {
      p_worker_id: workerId,
      p_branded_rice_weight: branded,
      p_feed_rice_weight: feed,
    })
    setBusy(false)

    if (error) onError(error.message)
    else onChanged('量目を更新しました。')
  }

  return (
    <details className="master-accordion inspection-option-section inspection-weight-section">
      <summary className="master-accordion-summary">
        <span><Scale size={20} />量目初期値</span>
        <span><ChevronDown className="master-accordion-chevron" size={20} /></span>
      </summary>
      <div className="master-accordion-content">
        <form className="inspection-weight-form" onSubmit={(event) => void save(event)}>
          <label>銘柄米
            <input type="number" min="1" step="1" value={brandedRiceWeight} onChange={(event) => setBrandedRiceWeight(event.target.value)} required />
          </label>
          <label>飼料用玄米
            <input type="number" min="1" step="1" value={feedRiceWeight} onChange={(event) => setFeedRiceWeight(event.target.value)} required />
          </label>
          <button className="primary-button" type="submit" disabled={busy}><Check size={18} />{busy ? '保存中...' : '保存'}</button>
        </form>
      </div>
    </details>
  )
}

export function InspectionOptionManager({ workerId }: Props) {
  const [destinationCount, setDestinationCount] = useState(0)
  const [transportCount, setTransportCount] = useState(0)
  const [items, setItems] = useState<InspectionOption[]>([])
  const [weights, setWeights] = useState<WeightValues>({ branded_rice: 1020, feed_rice: 1000 })
  const [notice, setNotice] = useState<Notice>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    void Promise.all([
      supabase
        .from('flexcon_inspection_options')
        .select('*')
        .order('option_type')
        .order('sort_order')
        .order('name'),
      supabase
        .from('flexcon_inspection_weights')
        .select('*'),
    ]).then(([optionResult, weightResult]) => {
      if (optionResult.error) setNotice({ type: 'error', text: '検査項目を取得できません。追加SQLを実行してください。' })
      else setItems((optionResult.data ?? []) as InspectionOption[])

      if (weightResult.error) {
        setNotice({ type: 'error', text: '量目を取得できません。量目用SQLを実行してください。' })
      } else {
        const data = weightResult.data as InspectionWeight[]
        setWeights({
          branded_rice: data.find((item) => item.weight_type === 'branded_rice')?.weight_kg ?? 1020,
          feed_rice: data.find((item) => item.weight_type === 'feed_rice')?.weight_kg ?? 1000,
        })
      }
    })
  }, [workerId, version])

  const changed = (message: string) => {
    setNotice({ type: 'success', text: message })
    setVersion((value) => value + 1)
  }

  const failed = (message: string) => setNotice({ type: 'error', text: message })

  return (
    <div>
      <div className="page-heading"><h1>マスタ</h1><p>各項目を選択して登録内容を管理します。</p></div>
      <div className="inspection-master-grid">
        <details className="master-accordion">
          <summary className="master-accordion-summary">
            <span><Building2 size={20} />納品先</span>
            <span>{destinationCount}件使用中<ChevronDown className="master-accordion-chevron" size={20} /></span>
          </summary>
          <div className="master-accordion-content"><DestinationManager workerId={workerId} embedded onCountChange={setDestinationCount} /></div>
        </details>
        <details className="master-accordion">
          <summary className="master-accordion-summary">
            <span><Truck size={20} />運送会社</span>
            <span>{transportCount}件使用中<ChevronDown className="master-accordion-chevron" size={20} /></span>
          </summary>
          <div className="master-accordion-content"><TransportManager workerId={workerId} embedded onCountChange={setTransportCount} /></div>
        </details>
        <OptionSection
          workerId={workerId}
          optionType="location"
          title="検査場所"
          items={items.filter((item) => item.option_type === 'location')}
          onChanged={changed}
          onError={failed}
        />
        <OptionSection
          workerId={workerId}
          optionType="inspector"
          title="検査員"
          items={items.filter((item) => item.option_type === 'inspector')}
          onChanged={changed}
          onError={failed}
        />
        <OptionSection
          workerId={workerId}
          optionType="brand_aomori"
          title="青森県の銘柄"
          items={items.filter((item) => item.option_type === 'brand_aomori' || item.option_type === 'brand')}
          onChanged={changed}
          onError={failed}
        />
        <OptionSection
          workerId={workerId}
          optionType="brand_iwate"
          title="岩手県の銘柄"
          items={items.filter((item) => item.option_type === 'brand_iwate')}
          onChanged={changed}
          onError={failed}
        />
        <OptionSection
          workerId={workerId}
          optionType="grade"
          title="等級"
          supportsDescription
          items={items.filter((item) => item.option_type === 'grade')}
          onChanged={changed}
          onError={failed}
        />
        <OptionSection
          workerId={workerId}
          optionType="grade_reason"
          title="等級の理由"
          supportsDescription
          items={items.filter((item) => item.option_type === 'grade_reason')}
          onChanged={changed}
          onError={failed}
        />
        <OptionSection
          workerId={workerId}
          optionType="shipment_product"
          title="銘柄米以外の種類"
          items={items.filter((item) => item.option_type === 'shipment_product')}
          onChanged={changed}
          onError={failed}
        />
        <InspectionWeightSection
          key={`${weights.branded_rice}-${weights.feed_rice}`}
          workerId={workerId}
          weights={weights}
          onChanged={changed}
          onError={failed}
        />
      </div>
      {notice?.type === 'error' && <div className="notice error" role="alert">{notice.text}</div>}
    </div>
  )
}
