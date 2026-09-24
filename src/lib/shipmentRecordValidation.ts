import type { InspectionOption } from '../types'
import { selectedInspectionGrade } from './inspectionGrade'

export type ShipmentRecordItemDraft = {
  key: string
  originPrefecture: string
  productName: string
  grade: string
  quantityCount: string
  unit: '本' | '袋' | 'kg'
}

export function brandTypes(origin: string) {
  return origin === '青森県' ? ['brand', 'brand_aomori'] : origin === '岩手県' ? ['brand', 'brand_iwate'] : ['brand']
}

export function productOptions(origin: string, options: InspectionOption[]) {
  const types = [...brandTypes(origin), 'shipment_product']
  return options.filter((item, index, all) =>
    types.includes(item.option_type)
    && all.findIndex((candidate) => types.includes(candidate.option_type) && candidate.name === item.name) === index)
}

export function isShipmentRecordBrand(origin: string, productName: string, options: InspectionOption[]) {
  return options.some((option) => option.name === productName && brandTypes(origin).includes(option.option_type))
}

export function gradesFor(productName: string, options: InspectionOption[], requireActive = true) {
  return options.filter((option) => option.option_type === 'grade' && (!requireActive || option.active)
    && (selectedInspectionGrade(option.name) || option.name === '未検査')
    && (productName === '飼料用玄米' ? ['合格', '未検査'].includes(option.name) : option.name !== '合格'))
}

export function validateShipmentRecordItems(items: ShipmentRecordItemDraft[], options: InspectionOption[], requireActive = true) {
  if (items.length === 0) return '出荷明細を1件以上追加してください。'
  const seen = new Set<string>()
  for (const item of items) {
    if (!['青森県', '岩手県'].includes(item.originPrefecture)) return '産地を選択してください。'
    const product = productOptions(item.originPrefecture, options).find((option) => option.name === item.productName && (!requireActive || option.active))
    if (!product) return '種類を選択してください。'
    if (!['本', '袋', 'kg'].includes(item.unit)) return '単位を選択してください。'
    if (!Number.isInteger(Number(item.quantityCount)) || Number(item.quantityCount) < 1) return '数量は1以上の整数で入力してください。'
    if (isShipmentRecordBrand(item.originPrefecture, item.productName, options)) {
      const grade = item.grade === '未検査' ? item.grade : selectedInspectionGrade(item.grade)
      if (!grade || !gradesFor(item.productName, options, requireActive).some((option) => option.name === grade)) return '銘柄米の等級を選択してください。'
    } else if (item.grade) return '銘柄米以外に等級は入力できません。'
    const key = `${item.originPrefecture}\u001f${item.productName.toLowerCase()}\u001f${item.grade}\u001f${item.unit}`
    if (seen.has(key)) return '同じ産地・種類・等級・単位が重複しています。'
    seen.add(key)
  }
  return null
}
