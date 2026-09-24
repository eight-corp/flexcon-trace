import type { AuthorizationRecord } from '../types'
import { matchesFilterText } from './tableFilters.ts'

export const AUTHORIZATION_COLUMNS = [
  { key: 'authorization_no', label: '№' },
  { key: 'full_name', label: '氏名' },
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

export function authorizationColumnValue(record: AuthorizationRecord, key: AuthorizationColumn): string {
  if (key === 'seed_purchase_slip' || key === 'farming_plan') return record[key] ? 'あり' : 'なし'
  return record[key] ?? ''
}

export function selectAuthorizations(items: AuthorizationRecord[], filters: AuthorizationFilters, sort: AuthorizationSort, textFilters: Partial<Record<AuthorizationColumn, string>> = {}): AuthorizationRecord[] {
  const rows = items.filter((item) => AUTHORIZATION_COLUMNS.every(({ key }) => {
    const selected = filters[key]
    const value = authorizationColumnValue(item, key)
    return (selected === undefined || selected.includes(value)) && matchesFilterText(value, textFilters[key] ?? '')
  }))
  if (!sort) return rows
  return [...rows].sort((left, right) => {
    const comparison = sort.key === 'seed_purchase_slip' || sort.key === 'farming_plan'
      ? Number(left[sort.key]) - Number(right[sort.key])
      : AUTHORIZATION_NO_COLLATOR.compare(authorizationColumnValue(left, sort.key), authorizationColumnValue(right, sort.key))
    return sort.direction === 'asc' ? comparison : -comparison
  })
}
