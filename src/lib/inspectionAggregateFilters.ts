import { formatDisplayCropYear, type CalendarMode } from './japaneseEra.ts'
import { matchesFilterText } from './tableFilters.ts'

export type InspectionAggregateRow = {
  kind: 'flexcon' | 'paper'
  fiscalYear: number
  origin: string
  brand: string
  inspectedByGrade: Record<string, number>
  inspectedQuantity: number
  uninspectedQuantity: number
}
export type InspectionAggregateColumn = 'fiscalYear' | 'origin' | 'brand' | 'inspectedQuantity' | 'uninspectedQuantity' | `grade:${string}`
export type InspectionAggregateFilters = {
  columnFilters: Partial<Record<InspectionAggregateColumn, string[]>>
  textFilters: Partial<Record<InspectionAggregateColumn, string>>
}

export function inspectionAggregateGroupKey(row: Pick<InspectionAggregateRow, 'kind' | 'fiscalYear' | 'origin' | 'brand'>) {
  return JSON.stringify([row.kind, row.fiscalYear, row.origin, row.brand])
}

export function inspectionAggregateDisplayValue(row: InspectionAggregateRow, key: InspectionAggregateColumn, mode: CalendarMode) {
  if (key === 'fiscalYear') return formatDisplayCropYear(row.fiscalYear, mode)
  if (key === 'origin' || key === 'brand') return row[key]
  if (key === 'inspectedQuantity' || key === 'uninspectedQuantity') return `${row[key].toLocaleString()}kg`
  const quantity = row.inspectedByGrade[key.slice('grade:'.length)]
  return quantity ? `${quantity.toLocaleString()}kg` : ''
}

export function matchesInspectionAggregateFilters(row: InspectionAggregateRow, filters: InspectionAggregateFilters, mode: CalendarMode) {
  const keys = new Set([...Object.keys(filters.columnFilters), ...Object.keys(filters.textFilters)] as InspectionAggregateColumn[])
  return [...keys].every(key => {
    const value = inspectionAggregateDisplayValue(row, key, mode)
    const selected = filters.columnFilters[key]
    return (selected === undefined || selected.includes(value)) && matchesFilterText(value, filters.textFilters[key] ?? '')
  })
}
