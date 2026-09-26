import type { InspectionOption } from '../types'

export function findWarehouseForInspectionLocation(
  location: string,
  options: Array<Pick<InspectionOption, 'id' | 'name' | 'active' | 'option_type'>>,
) {
  const name = location.trim()
  if (!name) return null
  return options.find((option) => option.option_type === 'warehouse' && option.active && option.name.trim() === name) ?? null
}
