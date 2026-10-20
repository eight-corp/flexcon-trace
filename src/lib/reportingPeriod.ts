export type ReportingPeriod = { start: string; end: string }
export const ALL_REPORTING_PERIOD: ReportingPeriod = { start: '', end: '' }
export const REPORTING_PERIOD_STORAGE_KEY = 'rice.reporting-period.v1'

export function reportingYearPeriod(year: number): ReportingPeriod {
  return { start: `${year}-09-01`, end: `${year + 1}-08-31` }
}

export function currentReportingPeriod(date = new Date()): ReportingPeriod {
  return reportingYearPeriod(date.getFullYear() - (date.getMonth() < 8 ? 1 : 0))
}

export function validReportingPeriod(value: unknown): value is ReportingPeriod {
  if (!value || typeof value !== 'object' || !('start' in value) || !('end' in value)) return false
  const validDate = (date: unknown) => typeof date === 'string' && (!date || (
    /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
  ))
  return validDate(value.start) && validDate(value.end) && !(value.start && value.end && String(value.start) > String(value.end))
}

export function matchesReportingPeriod(date: string | null | undefined, period: ReportingPeriod) {
  if (!period.start && !period.end) return true
  if (period.start && period.end && period.start > period.end) return false
  return Boolean(date && (!period.start || date.slice(0, 10) >= period.start) && (!period.end || date.slice(0, 10) <= period.end))
}

export function inspectionReportingDate(record: { inspection_date: string | null; purchase_date: string }) {
  return record.inspection_date || record.purchase_date
}

export function shipmentReportingDate(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const year = date.getFullYear()
  return `${year}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
