export type InspectionSummaryKind = 'standard' | 'bulk' | 'paper'

export function inspectionSummaryKindLabel(kind: InspectionSummaryKind) {
  return { standard: '推フレ', bulk: 'バラ', paper: '紙袋' }[kind]
}

export function groupInspectionSummaryRecords<T extends { inspection_date: string | null; brand: string | null }>(records: T[], kindFor: (record: T) => InspectionSummaryKind) {
  const groups = new Map<string, { key: string; inspectionDate: string | null; brand: string; kind: InspectionSummaryKind; records: T[] }>()
  for (const record of records) {
    const inspectionDate = record.inspection_date || null
    const brand = record.brand?.trim() || ''
    const kind = kindFor(record)
    const key = JSON.stringify([inspectionDate, brand, kind])
    const group = groups.get(key) ?? { key, inspectionDate, brand, kind, records: [] }
    group.records.push(record)
    groups.set(key, group)
  }
  const kindOrder = { standard: 0, bulk: 1, paper: 2 }
  return [...groups.values()].sort((left, right) => (
    (left.inspectionDate === null ? (right.inspectionDate === null ? 0 : 1) : right.inspectionDate === null ? -1 : left.inspectionDate.localeCompare(right.inspectionDate))
    || left.brand.localeCompare(right.brand, 'ja', { numeric: true })
    || kindOrder[left.kind] - kindOrder[right.kind]
  ))
}
