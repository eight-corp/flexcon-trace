import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { InspectionOption } from '../types'
import { gradesFor, isShipmentRecordBrand, productOptions, type ShipmentRecordItemDraft } from '../lib/shipmentRecordValidation'

type Props = {
  items: ShipmentRecordItemDraft[]
  onChange: (items: ShipmentRecordItemDraft[]) => void
  options: InspectionOption[]
  disabled?: boolean
}

export function ShipmentRecordItemsEditor({ items, onChange, options, disabled = false }: Props) {
  const [origin, setOrigin] = useState('')
  const [product, setProduct] = useState('')
  const [grade, setGrade] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [unit, setUnit] = useState<ShipmentRecordItemDraft['unit']>('本')
  const [error, setError] = useState('')
  const availableProducts = productOptions(origin, options).filter((item) => item.active)
  const brand = isShipmentRecordBrand(origin, product, options)

  const addItem = () => {
    const count = Number(quantity)
    if (!origin) return setError('産地を選択してください。')
    if (!product) return setError('種類を選択してください。')
    if (brand && !gradesFor(product, options).some((item) => item.name === grade)) return setError('等級を選択してください。')
    if (!Number.isInteger(count) || count < 1) return setError('数量は1以上の整数で入力してください。')
    const selectedGrade = brand ? grade : ''
    const existing = items.find((item) => item.originPrefecture === origin && item.productName === product
      && item.grade === selectedGrade && item.unit === unit)
    if (existing) {
      onChange(items.map((item) => item.key === existing.key
        ? { ...item, quantityCount: String(Number(item.quantityCount) + count) } : item))
    } else {
      onChange([...items, {
        key: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        originPrefecture: origin, productName: product, grade: selectedGrade,
        quantityCount: String(count), unit,
      }])
    }
    setProduct('')
    setGrade('')
    setQuantity('1')
    setError('')
  }

  const updateItem = (key: string, changes: Partial<ShipmentRecordItemDraft>) => {
    onChange(items.map((item) => item.key === key ? { ...item, ...changes } : item))
  }

  return <section className="record-items-editor" aria-label="出荷明細">
    <div className="record-item-fields">
      <label>産地<select className={!origin ? 'shipment-required-missing' : ''} value={origin} onChange={(event) => { setOrigin(event.target.value); setProduct(''); setGrade(''); setError('') }} disabled={disabled}><option value="">選択</option><option value="青森県">青森県</option><option value="岩手県">岩手県</option></select></label>
      <label>種類<select className={!product ? 'shipment-required-missing' : ''} value={product} onChange={(event) => { setProduct(event.target.value); setGrade(''); setError('') }} disabled={disabled || !origin}><option value="">{origin ? '選択' : '先に産地を選択'}</option>{availableProducts.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
      <label>等級<select className={brand && !grade ? 'shipment-required-missing' : ''} value={brand ? grade : ''} onChange={(event) => { setGrade(event.target.value); setError('') }} disabled={disabled || !brand}><option value="">{brand ? '選択' : '対象外'}</option>{brand && gradesFor(product, options).map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
      <label>数量<input type="number" min="1" step="1" className={!Number.isInteger(Number(quantity)) || Number(quantity) < 1 ? 'shipment-required-missing' : ''} value={quantity} onChange={(event) => { setQuantity(event.target.value); setError('') }} disabled={disabled} /></label>
      <label>単位<select value={unit} onChange={(event) => setUnit(event.target.value as ShipmentRecordItemDraft['unit'])} disabled={disabled}><option value="本">本</option><option value="袋">袋</option><option value="kg">kg</option></select></label>
      <button className="secondary-button" type="button" onClick={addItem} disabled={disabled}><Plus size={18} />追加</button>
    </div>
    {error && <div className="manual-item-error" role="alert">{error}</div>}
    <div className="record-item-list">
      {items.map((item) => {
        const rowBrand = isShipmentRecordBrand(item.originPrefecture, item.productName, options)
        const rowProducts = productOptions(item.originPrefecture, options)
        return <div className="record-item-row" key={item.key}>
          <select aria-label="産地" className={!item.originPrefecture ? 'shipment-required-missing' : ''} value={item.originPrefecture} onChange={(event) => updateItem(item.key, { originPrefecture: event.target.value, productName: '', grade: '' })} disabled={disabled}><option value="">選択</option><option value="青森県">青森県</option><option value="岩手県">岩手県</option></select>
          <select aria-label="種類" className={!item.productName ? 'shipment-required-missing' : ''} value={item.productName} onChange={(event) => updateItem(item.key, { productName: event.target.value, grade: '' })} disabled={disabled || !item.originPrefecture}><option value="">選択</option>{!rowProducts.some((option) => option.name === item.productName) && item.productName && <option value={item.productName}>{item.productName}</option>}{rowProducts.map((option) => <option key={option.id} value={option.name}>{option.name}{option.active ? '' : '（無効）'}</option>)}</select>
          <select aria-label="等級" className={rowBrand && !item.grade ? 'shipment-required-missing' : ''} value={rowBrand ? item.grade : ''} onChange={(event) => updateItem(item.key, { grade: event.target.value })} disabled={disabled || !rowBrand}><option value="">{rowBrand ? '選択' : '対象外'}</option>{rowBrand && !gradesFor(item.productName, options).some((option) => option.name === item.grade) && item.grade && <option value={item.grade}>{item.grade}</option>}{rowBrand && gradesFor(item.productName, options).map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select>
          <input aria-label="数量" type="number" min="1" step="1" className={!Number.isInteger(Number(item.quantityCount)) || Number(item.quantityCount) < 1 ? 'shipment-required-missing' : ''} value={item.quantityCount} onChange={(event) => updateItem(item.key, { quantityCount: event.target.value })} disabled={disabled} />
          <select aria-label="単位" value={item.unit} onChange={(event) => updateItem(item.key, { unit: event.target.value as ShipmentRecordItemDraft['unit'] })} disabled={disabled}><option value="本">本</option><option value="袋">袋</option><option value="kg">kg</option></select>
          <button className="icon-button delete-icon" type="button" title="明細を削除" aria-label={`${item.productName}を削除`} onClick={() => onChange(items.filter((current) => current.key !== item.key))} disabled={disabled}><Trash2 size={18} /></button>
        </div>
      })}
      {items.length === 0 && <div className="manual-item-empty">種類・数量・単位を入力して「追加」を押してください。</div>}
    </div>
  </section>
}
