export function formatInspectionMoisture(value: string | number | null) {
  if (value === null || String(value).trim() === '') return ''
  const number = Number(value)
  return Number.isFinite(number) ? number.toFixed(1) : String(value)
}

export function formatInspectionQuantity(value: string | number) {
  if (String(value).trim() === '') return ''
  const number = Number(value)
  return Number.isSafeInteger(number) ? number.toLocaleString('ja-JP') : String(value)
}
