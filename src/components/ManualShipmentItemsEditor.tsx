import { Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { InspectionOption } from '../types'

export type ManualShipmentItemDraft = {
  key: string
  originPrefecture: string
  productName: string
  quantityCount: string
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
  const optionType = kind === 'other_rice'
    ? 'shipment_product'
    : prefecture === '青森県'
      ? 'brand_aomori'
      : prefecture === '岩手県'
        ? 'brand_iwate'
        : ''
  return shipmentProducts.filter((item) => item.option_type === optionType)
}

export function ManualShipmentItemsEditor({ kind, items, onChange, shipmentProducts, disabled = false }: Props) {
  const [prefecture, setPrefecture] = useState('')
  const [productName, setProductName] = useState('')
  const [quantityCount, setQuantityCount] = useState('1')
  const [error, setError] = useState('')
  const availableProducts = useMemo(
    () => optionsFor(kind, prefecture, shipmentProducts).filter((item) => item.active),
    [kind, prefecture, shipmentProducts],
  )

  const addItem = () => {
    const quantity = Number(quantityCount)
    if (kind === 'paper_bag' && !prefecture) return setError('県名を選択してください。')
    if (!productName) return setError(kind === 'paper_bag' ? '銘柄を選択してください。' : '種類を選択してください。')
    if (!Number.isInteger(quantity) || quantity < 1) return setError('本数を1以上の整数で入力してください。')

    const originPrefecture = kind === 'paper_bag' ? prefecture : ''
    const existingIndex = items.findIndex((item) =>
      item.originPrefecture === originPrefecture && item.productName === productName)
    if (existingIndex >= 0) {
      onChange(items.map((item, index) => index === existingIndex
        ? { ...item, quantityCount: String(Number(item.quantityCount || 0) + quantity) }
        : item))
    } else {
      onChange([...items, { key: createKey(), originPrefecture, productName, quantityCount: String(quantity) }])
    }
    setProductName('')
    setQuantityCount('1')
    setError('')
  }

  const updateItem = (key: string, changes: Partial<ManualShipmentItemDraft>) => {
    onChange(items.map((item) => item.key === key ? { ...item, ...changes } : item))
  }

  return (
    <section className="manual-items-editor" aria-label={kind === 'paper_bag' ? '紙袋の明細' : '銘柄米以外の明細'}>
      <div className={`manual-item-add ${kind === 'paper_bag' ? 'paper' : ''}`}>
        {kind === 'paper_bag' && (
          <label>県名
            <select value={prefecture} onChange={(event) => { setPrefecture(event.target.value); setProductName(''); setError('') }} disabled={disabled}>
              <option value="">選択</option>
              <option value="青森県">青森県</option>
              <option value="岩手県">岩手県</option>
            </select>
          </label>
        )}
        <label>{kind === 'paper_bag' ? '銘柄' : '種類'}
          <select value={productName} onChange={(event) => { setProductName(event.target.value); setError('') }} disabled={disabled || (kind === 'paper_bag' && !prefecture)}>
            <option value="">{kind === 'paper_bag' && !prefecture ? '先に県名を選択' : '選択'}</option>
            {availableProducts.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
          </select>
        </label>
        <label>{kind === 'paper_bag' ? '紙袋数' : 'フレコン本数'}
          <input type="number" min="1" step="1" value={quantityCount} onChange={(event) => { setQuantityCount(event.target.value); setError('') }} disabled={disabled} />
        </label>
        <button className="secondary-button" type="button" onClick={addItem} disabled={disabled}><Plus size={18} />追加</button>
      </div>
      {error && <div className="manual-item-error">{error}</div>}

      <div className="manual-item-list">
        {items.map((item) => {
          const productOptions = optionsFor(kind, item.originPrefecture, shipmentProducts)
          const hasCurrentProduct = productOptions.some((option) => option.name === item.productName)
          return (
            <div className={`manual-item-row ${kind === 'paper_bag' ? 'paper' : ''}`} key={item.key}>
              {kind === 'paper_bag' && (
                <select aria-label="県名" value={item.originPrefecture} onChange={(event) => updateItem(item.key, { originPrefecture: event.target.value, productName: '' })} disabled={disabled}>
                  <option value="青森県">青森県</option>
                  <option value="岩手県">岩手県</option>
                </select>
              )}
              <select aria-label={kind === 'paper_bag' ? '銘柄' : '種類'} value={item.productName} onChange={(event) => updateItem(item.key, { productName: event.target.value })} disabled={disabled}>
                {!hasCurrentProduct && item.productName && <option value={item.productName}>{item.productName}</option>}
                <option value="">選択</option>
                {productOptions.map((option) => <option key={option.id} value={option.name}>{option.name}{option.active ? '' : '（無効）'}</option>)}
              </select>
              <div className="manual-item-quantity">
                <input aria-label={kind === 'paper_bag' ? '紙袋数' : 'フレコン本数'} type="number" min="1" step="1" value={item.quantityCount} onChange={(event) => updateItem(item.key, { quantityCount: event.target.value })} disabled={disabled} />
                <span>{kind === 'paper_bag' ? '袋' : '本'}</span>
              </div>
              <button className="icon-button delete-icon" type="button" title="明細を削除" aria-label={`${item.productName}を削除`} onClick={() => onChange(items.filter((current) => current.key !== item.key))} disabled={disabled}><Trash2 size={18} /></button>
            </div>
          )
        })}
        {items.length === 0 && <div className="manual-item-empty">種類と本数を入力して「追加」を押してください。</div>}
      </div>
    </section>
  )
}
