import { matchesReportingPeriod, shipmentReportingDate, type ReportingPeriod } from './reportingPeriod.ts'

export type InventoryPeriodBasis = 'closing' | 'net'
type LedgerRow = {
  id: string; source_type: string; movement_date: string; crop_year: number | null
  from_warehouse_id: string | null; to_warehouse_id: string | null
  origin: string; product_name: string; grade: string; unit: string; quantity: number
}
type Warehouse = { id: string; name: string; created_at: string }
type InspectionYear = { id: string; fiscal_year: number }
type Balance = { warehouse_id: string | null; warehouse_name: string; crop_year: number | null; origin: string; product_name: string; grade: string; unit: string; quantity: number }
type Shipped = { warehouse_id: string | null; crop_year: number | null; origin: string; product_name: string; unit: string; shipped_quantity: number }

export function inventoryReportingDates<T extends { id: string; source_type: string; movement_date: string }>(
  ledger: T[], shipments: Array<{ id: string; shipped_at: string; flexcon_manual_shipment_items: Array<{ id: string }> }>,
  purchases: Array<{ id: string; purchased_at: string }>,
): T[] {
  const shipmentDates = new Map(shipments.map(row => [row.id, shipmentReportingDate(row.shipped_at)]))
  const itemDates = new Map(shipments.flatMap(row => row.flexcon_manual_shipment_items.map(item => [item.id, shipmentDates.get(row.id)] as const)))
  const purchaseDates = new Map(purchases.map(row => [row.id, shipmentReportingDate(row.purchased_at)]))
  return ledger.map(row => {
    const parts = row.id.split(':')
    const date = row.source_type === 'shipment_flexcon' ? shipmentDates.get(parts[1])
      : row.source_type === 'shipment_manual' || row.source_type === 'shipment_record' ? itemDates.get(parts[1])
      : row.source_type === 'settlement' ? purchaseDates.get(row.id) : null
    return date ? { ...row, movement_date: date } : row
  })
}

export function inventoryReportingSnapshot(
  ledger: LedgerRow[], warehouses: Warehouse[], flexcons: InspectionYear[], paperBags: InspectionYear[],
  period: ReportingPeriod, basis: InventoryPeriodBasis,
) {
  const warehouseById = new Map(warehouses.map(row => [row.id, row]))
  const unassigned = warehouses.filter(row => row.name === '倉庫未設定').sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.id
  const flexconYears = new Map(flexcons.map(row => [row.id, row.fiscal_year + 2018]))
  const paperYears = new Map(paperBags.map(row => [row.id, row.fiscal_year + 2018]))
  const balances = new Map<string, Balance>()
  const shipped = new Map<string, Shipped>()
  if (period.start && period.end && period.start > period.end) return { balances: [], shippedQuantities: [] }
  for (const row of ledger) {
    // Ledger quantities use numeric(14,3); accumulate thousandths to avoid floating point residue.
    const quantity = Math.round(Number(row.quantity) * 1000)
    const parts = row.id.split(':')
    const cropYear = row.crop_year ?? (row.source_type === 'inspection_paper_bag' ? paperYears.get(parts[1])
      : row.source_type === 'inspection_flexcon' ? flexconYears.get(parts[1])
      : row.source_type === 'shipment_flexcon' ? flexconYears.get(parts[2]) : null) ?? null
    const warehouseId = (id: string | null) => id === unassigned ? null : id
    const addBalance = (id: string | null, quantity: number) => {
      const normalized = warehouseId(id)
      const grade = row.grade?.trim() || '対象外'
      const key = JSON.stringify([normalized, cropYear, row.origin, row.product_name, grade, row.unit])
      const current = balances.get(key) ?? { warehouse_id: normalized, warehouse_name: normalized ? warehouseById.get(normalized)?.name ?? '倉庫未設定' : '倉庫未設定', crop_year: cropYear, origin: row.origin, product_name: row.product_name, grade, unit: row.unit, quantity: 0 }
      current.quantity += quantity
      balances.set(key, current)
    }
    // Closing stock includes all earlier movements, while net movement uses both boundaries.
    if (matchesReportingPeriod(row.movement_date, basis === 'closing' ? { start: '', end: period.end } : period)) {
      if (row.to_warehouse_id !== null || row.source_type === 'settlement') addBalance(row.to_warehouse_id, quantity)
      if (row.from_warehouse_id !== null) addBalance(row.from_warehouse_id, -quantity)
    }
    if (row.from_warehouse_id !== null && ['shipment_flexcon', 'shipment_manual', 'shipment_record'].includes(row.source_type) && matchesReportingPeriod(row.movement_date, period)) {
      const id = warehouseId(row.from_warehouse_id)
      const key = JSON.stringify([id, cropYear, row.origin, row.product_name, row.unit])
      const current = shipped.get(key) ?? { warehouse_id: id, crop_year: cropYear, origin: row.origin, product_name: row.product_name, unit: row.unit, shipped_quantity: 0 }
      current.shipped_quantity += quantity
      shipped.set(key, current)
    }
  }
  return {
    balances: [...balances.values()].filter(row => row.quantity !== 0).map(row => ({ ...row, quantity: row.quantity / 1000 })),
    shippedQuantities: [...shipped.values()].map(row => ({ ...row, shipped_quantity: row.shipped_quantity / 1000 })),
  }
}
