const ERAS = [
  { name: '令和', start: '2019-05-01', firstYear: 2019 },
  { name: '平成', start: '1989-01-08', firstYear: 1989 },
  { name: '昭和', start: '1926-12-25', firstYear: 1926 },
  { name: '大正', start: '1912-07-30', firstYear: 1912 },
  { name: '明治', start: '1868-01-25', firstYear: 1868 },
] as const

export type JapaneseEraName = (typeof ERAS)[number]['name']

function dateParts(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? { year, month, day, iso: `${match[1]}-${match[2]}-${match[3]}` }
    : null
}

function eraForDate(iso: string) {
  return ERAS.find((era) => iso >= era.start)
}

export function formatJapaneseDate(value: string | null | undefined) {
  if (!value) return ''
  const parts = dateParts(value)
  if (!parts) return value
  const era = eraForDate(parts.iso)
  if (!era) return value
  const eraYear = parts.year - era.firstYear + 1
  return `${era.name}${eraYear === 1 ? '元' : eraYear}年${parts.month}月${parts.day}日`
}

export function formatJapaneseDateLong(value: string | null | undefined) {
  return formatJapaneseDate(value)
}

export function formatJapaneseDateForFilename(value: string) {
  return formatJapaneseDate(value)
}

export function formatJapaneseDateTime(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return `${formatJapaneseDate(localDate)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatJapaneseCropYear(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return ''
  const year = Number(value)
  if (!Number.isInteger(year)) return String(value)
  if (year < 100) return `令和${year === 1 ? '元' : year}年産`
  const era = eraForDate(`${year}-12-31`)
  if (!era) return String(value)
  const eraYear = year - era.firstYear + 1
  return `${era.name}${eraYear === 1 ? '元' : eraYear}年産`
}

export function parseJapaneseDate(value: string) {
  const normalized = value.trim().replaceAll('０', '0').replaceAll('１', '1').replaceAll('２', '2').replaceAll('３', '3').replaceAll('４', '4').replaceAll('５', '5').replaceAll('６', '6').replaceAll('７', '7').replaceAll('８', '8').replaceAll('９', '9')
  const match = normalized.match(/^(令和|平成|昭和|大正|明治)(元|\d{1,3})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/)
  if (!match) return null
  const era = ERAS.find((item) => item.name === match[1])!
  const year = era.firstYear + (match[2] === '元' ? 1 : Number(match[2])) - 1
  const iso = `${year}-${match[3].padStart(2, '0')}-${match[4].padStart(2, '0')}`
  if (!dateParts(iso) || eraForDate(iso)?.name !== era.name) return null
  return iso
}

export const JAPANESE_ERAS = ERAS

export type CalendarMode = 'wareki' | 'seireki'

export function formatDisplayDate(value: string | null | undefined, mode: CalendarMode) {
  if (mode === 'wareki') return formatJapaneseDate(value)
  if (!value) return ''
  const parts = dateParts(value)
  return parts ? `${parts.year}年${parts.month}月${parts.day}日` : value
}

export function formatDisplayDateTime(value: string | null | undefined, mode: CalendarMode) {
  if (mode === 'wareki') return formatJapaneseDateTime(value)
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return `${formatDisplayDate(iso, mode)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatDisplayCropYear(value: number | string | null | undefined, mode: CalendarMode) {
  if (mode === 'wareki') return formatJapaneseCropYear(value)
  if (value === null || value === undefined || value === '') return ''
  const year = Number(value)
  if (!Number.isInteger(year)) return String(value)
  return `${year < 100 ? year + 2018 : year}年産`
}

export function parseDisplayDate(value: string, mode: CalendarMode) {
  if (mode === 'wareki') return parseJapaneseDate(value)
  const normalized = value.trim().normalize('NFKC')
  const match = normalized.match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/)
  if (!match) return null
  const iso = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  return dateParts(iso) ? iso : null
}
