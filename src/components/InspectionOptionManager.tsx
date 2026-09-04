import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Award, Check, ListChecks, MapPin, Pencil, Plus, Scale, Tags, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { InspectionOption, InspectionWeight } from '../types'
import { ToggleSwitch } from './ToggleSwitch'

type Props = { workerId: string }
type OptionType = InspectionOption['option_type']
type Notice = { type: 'success' | 'error'; text: string } | null
type WeightValues = Record<InspectionWeight['weight_type'], number>

type SectionProps = {
  workerId: string
  optionType: OptionType
  title: string
  items: InspectionOption[]
  onChanged: (message: string) => void
  onError: (message: string) => void
}

function OptionSection({ workerId, optionType, title, items, onChanged, onError }: SectionProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setEditingId(null)
    setName('')
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

  const Icon = optionType === 'location' ? MapPin : optionType === 'grade' ? Award : optionType === 'grade_reason' ? ListChecks : Tags

  return (
    <section className="inspection-option-section">
      <div className="section-title">
        <h2>{title}</h2>
        <span>{items.filter((item) => item.active).length}件使用中</span>
      </div>

      <form className="inspection-option-form" onSubmit={(event) => void submit(event)}>
        <input value={name} onChange={(event) => setName(event.target.value)} required aria-label={`${title}名`} />
        <button className="primary-button" type="submit" disabled={busy}>
          {editingId ? <><Check size={18} />保存</> : <><Plus size={18} />追加</>}
        </button>
        {editingId && (
          <button className="icon-button" type="button" title="編集を取り消す" aria-label="編集を取り消す" onClick={reset} disabled={busy}><X size={18} /></button>
        )}
      </form>

      <div className="inspection-option-list">
        {items.map((item, index) => (
          <div className={`inspection-option-row ${item.active ? '' : 'inactive-item'}`} key={item.id}>
            <Icon size={19} color={item.active ? '#236640' : '#7a847c'} />
            <strong>{item.name}</strong>
            <div className="inspection-option-order-buttons">
              <button className="icon-button" type="button" title="上へ移動" aria-label={`${item.name}を上へ移動`} onClick={() => void move(item, -1)} disabled={busy || index === 0}><ArrowUp size={16} /></button>
              <button className="icon-button" type="button" title="下へ移動" aria-label={`${item.name}を下へ移動`} onClick={() => void move(item, 1)} disabled={busy || index === items.length - 1}><ArrowDown size={16} /></button>
            </div>
            <button className="icon-button" type="button" title="編集" aria-label={`${item.name}を編集`} onClick={() => beginEdit(item)} disabled={busy}><Pencil size={17} /></button>
            <ToggleSwitch checked={item.active} label={`${item.name}を${item.active ? '無効' : '有効'}にする`} onChange={() => void toggle(item)} />
          </div>
        ))}
        {items.length === 0 && <div className="empty-state">登録されていません</div>}
      </div>
    </section>
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
    <section className="inspection-option-section inspection-weight-section">
      <div className="section-title">
        <h2><Scale className="inline-icon" size={19} />量目</h2>
      </div>
      <form className="inspection-weight-form" onSubmit={(event) => void save(event)}>
        <label>銘柄米
          <input type="number" min="1" step="1" value={brandedRiceWeight} onChange={(event) => setBrandedRiceWeight(event.target.value)} required />
        </label>
        <label>飼料用玄米
          <input type="number" min="1" step="1" value={feedRiceWeight} onChange={(event) => setFeedRiceWeight(event.target.value)} required />
        </label>
        <button className="primary-button" type="submit" disabled={busy}><Check size={18} />{busy ? '保存中...' : '保存'}</button>
      </form>
    </section>
  )
}

export function InspectionOptionManager({ workerId }: Props) {
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
      <div className="page-heading"><h1>検査項目管理</h1><p>検査場所と県別の銘柄を管理します。</p></div>
      <div className="inspection-master-grid">
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
          items={items.filter((item) => item.option_type === 'grade')}
          onChanged={changed}
          onError={failed}
        />
        <OptionSection
          workerId={workerId}
          optionType="grade_reason"
          title="等級の理由"
          items={items.filter((item) => item.option_type === 'grade_reason')}
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
      {notice && <div className={`notice operation-log ${notice.type}`} role="status" aria-live="polite">{notice.text}</div>}
    </div>
  )
}
