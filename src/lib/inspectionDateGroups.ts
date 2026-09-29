export function groupInspectionRecordsByDate<T extends { inspection_date: string | null }>(records: T[]) {
  const groups = new Map<string | null, T[]>()
  for (const record of records) {
    const date = record.inspection_date || null
    const group = groups.get(date) ?? []
    group.push(record)
    groups.set(date, group)
  }
  return [...groups].sort(([left], [right]) => {
    if (left === null) return right === null ? 0 : 1
    if (right === null) return -1
    return left.localeCompare(right)
  })
}
