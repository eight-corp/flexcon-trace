export function formatPrefectureName(value: string | null | undefined) {
  const name = value?.trim() ?? ''
  if (!name || /[都道府県]$/.test(name)) return name
  return `${name}県`
}
