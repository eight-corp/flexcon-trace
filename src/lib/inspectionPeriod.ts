export type InspectionPeriod = {
  basis: 'inspection' | 'purchase'
  start: string
  end: string
}

export function matchesInspectionPeriod(
  record: { inspection_date: string | null; purchase_date: string },
  period: InspectionPeriod,
) {
  if (!period.start && !period.end) return true
  if (period.start && period.end && period.start > period.end) return false
  const date = (period.basis === 'inspection' ? record.inspection_date : record.purchase_date)?.slice(0, 10)
  return Boolean(date && (!period.start || date >= period.start) && (!period.end || date <= period.end))
}
