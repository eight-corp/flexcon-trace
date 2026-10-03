import type { AuthorizationRecord } from '../types'
import { matchesFilterText } from './tableFilters.ts'

export const AUTHORIZATION_COLUMNS = [
  { key: 'authorization_no', label: '№' },
  { key: 'full_name', label: '氏名' },
  { key: 'purchase_status', label: '仕入れ' },
  { key: 'seed_purchase_slip', label: '種子購入伝票' },
  { key: 'farming_plan', label: '営農計画書' },
  { key: 'address', label: '住所' },
  { key: 'prefecture', label: '産地' },
  { key: 'municipality', label: '市町村' },
  { key: 'phone', label: '電話番号' },
  { key: 'crop_type', label: '農作物の種類' },
  { key: 'feed_rice_variety', label: '飼料用米の品種' },
  { key: 'notes', label: '備考' },
] as const

export type AuthorizationColumn = (typeof AUTHORIZATION_COLUMNS)[number]['key']
export type AuthorizationSort = { key: AuthorizationColumn; direction: 'asc' | 'desc' } | null
export type AuthorizationFilters = Partial<Record<AuthorizationColumn, string[]>>

export const AUTHORIZATION_NO_COLLATOR = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })
const EMPTY_PURCHASE_IDS: ReadonlySet<string> = new Set()

export function authorizationColumnValue(record: AuthorizationRecord, key: AuthorizationColumn, purchaseIds: ReadonlySet<string> | null = EMPTY_PURCHASE_IDS): string {
  if (key === 'purchase_status') return purchaseIds === null ? '確認不可' : purchaseIds.has(record.id) ? 'あり' : 'なし'
  if (key === 'seed_purchase_slip' || key === 'farming_plan') return record[key] ? 'あり' : 'なし'
  return record[key] ?? ''
}

export function selectAuthorizations(items: AuthorizationRecord[], filters: AuthorizationFilters, sort: AuthorizationSort, textFilters: Partial<Record<AuthorizationColumn, string>> = {}, purchaseIds: ReadonlySet<string> | null = EMPTY_PURCHASE_IDS): AuthorizationRecord[] {
  const rows = items.filter((item) => AUTHORIZATION_COLUMNS.every(({ key }) => {
    const selected = filters[key]
    const value = authorizationColumnValue(item, key, purchaseIds)
    return (selected === undefined || selected.includes(value)) && matchesFilterText(value, textFilters[key] ?? '')
  }))
  if (!sort) return rows
  return [...rows].sort((left, right) => {
    const comparison = sort.key === 'purchase_status'
      ? Number(purchaseIds?.has(left.id) ?? false) - Number(purchaseIds?.has(right.id) ?? false)
      : sort.key === 'seed_purchase_slip' || sort.key === 'farming_plan'
        ? Number(left[sort.key]) - Number(right[sort.key])
        : AUTHORIZATION_NO_COLLATOR.compare(authorizationColumnValue(left, sort.key, purchaseIds), authorizationColumnValue(right, sort.key, purchaseIds))
    return sort.direction === 'asc' ? comparison : -comparison
  })
}

export function withAuthorizationAddRow<T extends { authorization_no: string }>(rows: T[], nextNo: string, sort: AuthorizationSort): (T | null)[] {
  const result: (T | null)[] = [...rows, null]
  if (sort?.key === 'authorization_no') {
    result.sort((left, right) => {
      const comparison = AUTHORIZATION_NO_COLLATOR.compare(left?.authorization_no ?? nextNo, right?.authorization_no ?? nextNo)
      return sort.direction === 'asc' ? comparison : -comparison
    })
  }
  return result
}
