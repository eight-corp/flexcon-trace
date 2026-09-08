import { Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { InspectionOption } from '../types'

export type ManualShipmentItemDraft = {
  key: string
  originPrefecture: string
  productName: string
  quantityCount: string
  grade: string
  moisture: string
  reason: string
}

type Props = {
  kind: 'paper_bag' | 'other_rice'
  items: ManualShipmentItemDraft[]
  onChange: (items: ManualShipmentItemDraft[]) => void
  shipmentProducts: InspectionOption[]
  disabled?: boolean
}

function createKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

function optionsFor(
  kind: Props['kind'],
  prefecture: string,
  shipmentProducts: InspectionOption[],
) {
  const regionalBrandType = prefecture === '青森県'
    ? 'brand_aomori'
    : prefecture === '岩手県'
      ? 'brand_iwate'
      : ''
  const optionTypes = kind === 'paper_bag'
    ? [regionalBrandType, 'shipment_product']
    : ['shipment_product']

  return shipmentProducts.filter((item, index, allItems) =>
    optionTypes.includes(item.option_type)
    && allItems.findIndex((candidate) => optionTypes.includes(candidate.option_type) && candidate.name === item.name) === index)
}

export function ManualShipmentItemsEditor({ kind, items, onChange, shipmentProducts, disabled = false }: Props) {
  const [prefecture, setPrefecture] = useState('')
  const [productName, setProductName] = useState('')
  const [quantityCount, setQuantityCount] = useState('1')
  const [grade, setGrade] = useState('')
  const [moisture, setMoisture] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const availableProducts = useMemo(
    () => optionsFor(kind, prefecture, shipmentProducts).filter((item) => item.active),
    [kind, prefecture, shipmentProducts],
  )
  const gradeOptions = shipmentProducts.filter((item) => item.option_type === 'grade' && item.active)
  const reasonOptions = shipmentProducts.filter((item) => item.option_type === 'grade_reason' && item.active)
  const availableGrades = gradeOptions.filter((item) => productName === '飼料用玄米' ? item.name === '合格' : item.name !== '合格')
  const reasonForbidden = grade === '1等' || grade === '合格'

  const addItem = () => {
    const quantity = Number(quantityCount)
    const moistureValue = Number(moisture)
    if (!prefecture) return setError('産地を選択してください。')
    if (!productName) return setError(kind === 'paper_bag' ? '銘柄を選択してください。' : '種類を選択してください。')
    if (!Number.isInteger(quantity) || quantity < 1) return setError('本数を1以上の整数で入力してください。')
    if (kind === 'paper_bag' && !grade) return setError('等級を選択してください。')
    if (kind === 'paper_bag' && (moisture.trim() === '' || !Number.isFinite(moistureValue) || moistureValue < 0 || moistureValue > 100)) return setError('水分は0から100の範囲で入力してください。')
    if (kind === 'paper_bag' && !reasonForbidden && !reason) return setError('理由を選択してください。')

    const originPrefecture = prefecture
    const existingIndex = items.findIndex((item) =>
      item.originPrefecture === originPrefecture
      && item.productName === productName
      && item.grade === (kind === 'paper_bag' ? grade : '')
      && item.moisture === (kind === 'paper_bag' ? moisture : '')
      && item.reason === (kind === 'paper_bag' && !reasonForbidden ? reason : ''))
    if (existingIndex >= 0) {
      onChange(items.map((item, index) => index === existingIndex
        ? { ...item, quantityCount: String(Number(item.quantityCount || 0) + quantity) }
        : item))
    } else {
      onChange([...items, {
        key: createKey(),
        originPrefecture,
        productName,
        quantityCount: String(quantity),
        grade: kind === 'paper_bag' ? grade : '',
        moisture: kind === 'paper_bag' ? moisture : '',
        reason: kind === 'paper_bag' && !reasonForbidden ? reason : '',
      }])
    }
    setProductName('')
    setQuantityCount('1')
    setGrade('')
    setMoisture('')
    setReason('')
    setError('')
  }

  const updateItem = (key: string, changes: Partial<ManualShipmentItemDraft>) => {
    onChange(items.map((item) => item.key === key ? { ...item, ...changes } : item))
  }

  return (
    <section className="manual-items-editor" aria-label={kind === 'paper_bag' ? '紙袋の明細' : '銘柄米以外の明細'}>
      <div className="manual-item-add paper">
        <label>産地
          <select className={items.length === 0 && !prefecture ? 'shipment-required-missing' : ''} aria-invalid={items.length === 0 && !prefecture} value={prefecture} onChange={(event) => { setPrefecture(event.target.value); setProductName(''); setError('') }} disabled={disabled}>
            <option value="">選択</option>
            <option value="青森県">青森県</option>
            <option value="岩手県">岩手県</option>
          </select>
        </label>
        <label>{kind === 'paper_bag' ? '銘柄' : '種類'}
          <select className={items.length === 0 && !productName ? 'shipment-required-missing' : ''} aria-invalid={items.length === 0 && !productName} value={productName} onChange={(event) => { setProductName(event.target.value); setGrade(''); setReason(''); setError('') }} disabled={disabled || !prefecture}>
            <option value="">{!prefecture ? '先に産地を選択' : '選択'}</option>
            {availableProducts.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
          </select>
        </label>
        <label>{kind === 'paper_bag' ? '紙袋数' : 'フレコン本数'}
          <input className={items.length === 0 && (!Number.isInteger(Number(quantityCount)) || Number(quantityCount) < 1) ? 'shipment-required-missing' : ''} aria-invalid={items.length === 0 && (!Number.isInteger(Number(quantityCount)) || Number(quantityCount) < 1)} type="number" min="1" step="1" value={quantityCount} onChange={(event) => { setQuantityCount(event.target.value); setError('') }} disabled={disabled} />
        </label>
        {kind === 'paper_bag' && <>
          <label className="manual-paper-moisture">水分
            <input className={!moisture ? 'shipment-required-missing' : ''} type="number" min="0" max="100" step="0.1" value={moisture} onChange={(event) => { setMoisture(event.target.value); setError('') }} disabled={disabled} />
          </label>
          <label className="manual-paper-grade">等級
            <select className={!grade ? 'shipment-required-missing' : ''} value={grade} onChange={(event) => { const nextGrade = event.target.value; setGrade(nextGrade); if (nextGrade === '1等' || nextGrade === '合格') setReason(''); setError('') }} disabled={disabled || !productName}>
              <option value="">選択</option>{availableGrades.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
            </select>
          </label>
          <label className="manual-paper-reason">理由
            <select className={!reasonForbidden && grade && !reason ? 'shipment-required-missing' : ''} value={reasonForbidden ? '' : reason} onChange={(event) => { setReason(event.target.value); setError('') }} disabled={disabled || !grade || reasonForbidden}>
              <option value="">選択</option>{reasonOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
            </select>
          </label>
        </>}
        <button className="secondary-button" type="button" onClick={addItem} disabled={disabled}><Plus size={18} />追加</button>
      </div>
      {error && <div className="manual-item-error">{error}</div>}

      <div className="manual-item-list">
        {items.map((item) => {
          const productOptions = optionsFor(kind, item.originPrefecture, shipmentProducts)
          const hasCurrentProduct = productOptions.some((option) => option.name === item.productName)
          return (
            <div className="manual-item-row paper" key={item.key}>
              <select className={!item.originPrefecture ? 'shipment-required-missing' : ''} aria-invalid={!item.originPrefecture} aria-label="産地" value={item.originPrefecture} onChange={(event) => updateItem(item.key, { originPrefecture: event.target.value, productName: kind === 'paper_bag' ? '' : item.productName, grade: '', moisture: '', reason: '' })} disabled={disabled}>
                <option value="">選択</option>
                <option value="青森県">青森県</option>
                <option value="岩手県">岩手県</option>
              </select>
              <select className={!item.productName ? 'shipment-required-missing' : ''} aria-invalid={!item.productName} aria-label={kind === 'paper_bag' ? '銘柄' : '種類'} value={item.productName} onChange={(event) => updateItem(item.key, { productName: event.target.value, grade: '', reason: '' })} disabled={disabled}>
                {!hasCurrentProduct && item.productName && <option value={item.productName}>{item.productName}</option>}
                <option value="">選択</option>
                {productOptions.map((option) => <option key={option.id} value={option.name}>{option.name}{option.active ? '' : '（無効）'}</option>)}
              </select>
              <div className="manual-item-quantity">
                <input className={!Number.isInteger(Number(item.quantityCount)) || Number(item.quantityCount) < 1 ? 'shipment-required-missing' : ''} aria-invalid={!Number.isInteger(Number(item.quantityCount)) || Number(item.quantityCount) < 1} aria-label={kind === 'paper_bag' ? '紙袋数' : 'フレコン本数'} type="number" min="1" step="1" value={item.quantityCount} onChange={(event) => updateItem(item.key, { quantityCount: event.target.value })} disabled={disabled} />
                <span>{kind === 'paper_bag' ? '袋' : '本'}</span>
              </div>
              <button className="icon-button delete-icon" type="button" title="明細を削除" aria-label={`${item.productName}を削除`} onClick={() => onChange(items.filter((current) => current.key !== item.key))} disabled={disabled}><Trash2 size={18} /></button>
              {kind === 'paper_bag' && <div className="manual-item-inspection-row">
                <label>水分<input className={!item.moisture ? 'shipment-required-missing' : ''} aria-label="水分" type="number" min="0" max="100" step="0.1" value={item.moisture} onChange={(event) => updateItem(item.key, { moisture: event.target.value })} disabled={disabled} /></label>
                <label>等級<select className={!item.grade ? 'shipment-required-missing' : ''} aria-label="等級" value={item.grade} onChange={(event) => { const nextGrade = event.target.value; updateItem(item.key, { grade: nextGrade, reason: nextGrade === '1等' || nextGrade === '合格' ? '' : item.reason }) }} disabled={disabled}><option value="">選択</option>{gradeOptions.filter((option) => item.productName === '飼料用玄米' ? option.name === '合格' : option.name !== '合格').map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></label>
                <label>理由<select className={item.grade && item.grade !== '1等' && item.grade !== '合格' && !item.reason ? 'shipment-required-missing' : ''} aria-label="理由" value={item.grade === '1等' || item.grade === '合格' ? '' : item.reason} onChange={(event) => updateItem(item.key, { reason: event.target.value })} disabled={disabled || !item.grade || item.grade === '1等' || item.grade === '合格'}><option value="">選択</option>{reasonOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></label>
              </div>}
            </div>
          )
        })}
        {items.length === 0 && <div className="manual-item-empty">種類と本数を入力して「追加」を押してください。</div>}
      </div>
    </section>
  )
}
