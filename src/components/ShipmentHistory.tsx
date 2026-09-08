import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Building2, Download, Filter, LayoutGrid, Pencil, Save, Search, Table2, Trash2, Truck, UserRound, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatPrefectureName } from '../lib/prefecture'
import type { Destination, InspectionOption, Shipment, TransportProfile } from '../types'
import { ManualShipmentItemsEditor, type ManualShipmentItemDraft } from './ManualShipmentItemsEditor'

type Props = {
  refreshKey: number
  workerId: string
  isAdmin: boolean
}

type Notice = { type: 'success' | 'error'; text: string } | null
type ViewMode = 'cards' | 'table'
type SortDirection = 'asc' | 'desc'
type MixedShipmentInfo = { mixedNo: number; producerLabel: string }
type TableColumn = 'shippedAt' | 'destination' | 'origin' | 'productName' | 'grade' | 'moisture' | 'reason' | 'flexconQuantity' | 'paperBagQuantity' | 'carrier' | 'driver' | 'vehicle' | 'worker' | 'note'
type ShipmentProductGroup = {
  origin: string
  name: string
  count: number
  unit: string
  grade: string
  moisture: number | null
  reason: string
}
type ShipmentTableRow = {
  id: string
  shipment: Shipment
  originalOrder: number
  shippedAt: string
  shippedAtValue: number
  destination: string
  origin: string
  productName: string
  grade: string
  moisture: string
  reason: string
  flexconQuantity: number
  flexconQuantityText: string
  paperBagQuantity: number
  paperBagQuantityText: string
  carrier: string
  driver: string
  vehicle: string
  worker: string
  note: string
  searchText: string
}

type DestinationSummaryRow = {
  destination: string
  productName: string
  grade: string
  flexconQuantity: number
  paperBagQuantity: number
}

const TABLE_COLUMNS: Array<{ key: TableColumn; label: string }> = [
  { key: 'shippedAt', label: '出荷日時' },
  { key: 'destination', label: '納品先' },
  { key: 'origin', label: '産地' },
  { key: 'productName', label: '品名' },
  { key: 'grade', label: '等級' },
  { key: 'moisture', label: '水分' },
  { key: 'reason', label: '理由' },
  { key: 'flexconQuantity', label: 'フレコン本数' },
  { key: 'paperBagQuantity', label: '紙袋数' },
  { key: 'carrier', label: '運送会社' },
  { key: 'driver', label: 'ドライバー' },
  { key: 'vehicle', label: '車両番号' },
  { key: 'worker', label: '担当者' },
  { key: 'note', label: '備考' },
]

function toLocalDateTime(value: string) {
  const date = new Date(value)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function formatShipmentDateTime(value: string) {
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shipmentProductSummary(shipment: Shipment) {
  return shipmentProductGroups(shipment)
    .map((group) => `${group.origin ? `${group.origin} ` : ''}${group.name}${shipment.shipment_kind === 'other_rice' ? '' : ` ${group.grade || '等級未入力'}`} ${group.count}${group.unit}`)
    .join('、')
}

function shipmentProductGroups(shipment: Shipment): ShipmentProductGroup[] {
  if (shipment.shipment_kind !== 'qr_flexcon') {
    if (shipment.flexcon_manual_shipment_items.length > 0) {
      return [...shipment.flexcon_manual_shipment_items].sort((a, b) => a.sort_order - b.sort_order).map((item) => ({
        origin: formatPrefectureName(item.origin_prefecture) || '産地未登録',
        name: item.product_name,
        count: item.quantity_count,
        unit: shipment.shipment_kind === 'paper_bag' ? '袋' : '本',
        grade: item.grade ?? '',
        moisture: item.moisture,
        reason: item.reason ?? '',
      }))
    }
    return [{
      origin: formatPrefectureName(shipment.origin_prefecture) || '産地未登録',
      name: shipment.product_name?.trim() || '品名未登録',
      count: shipment.quantity_count ?? 0,
      unit: shipment.shipment_kind === 'paper_bag' ? '袋' : '本',
      grade: '',
      moisture: null,
      reason: '',
    }]
  }

  const groups = new Map<string, ShipmentProductGroup & { moistureTotal: number; moistureCount: number; reasons: Set<string> }>()
  shipment.flexcon_shipment_items.forEach((item) => {
    const origin = formatPrefectureName(item.origin_prefecture ?? shipment.origin_prefecture) || '産地未登録'
    const name = item.product_name?.trim() || shipment.product_name?.trim() || '品名未登録'
    const grade = item.grade?.trim() || ''
    const key = `${origin}\u001f${name}\u001f${grade}`
    const current = groups.get(key)
    const reasons = current?.reasons ?? new Set<string>()
    if (item.reason?.trim()) reasons.add(item.reason.trim())
    groups.set(key, {
      origin,
      name,
      grade,
      count: (current?.count ?? 0) + 1,
      unit: '本',
      moisture: null,
      reason: '',
      moistureTotal: (current?.moistureTotal ?? 0) + (item.moisture ?? 0),
      moistureCount: (current?.moistureCount ?? 0) + (item.moisture === null ? 0 : 1),
      reasons,
    })
  })
  return [...groups.values()].map((group) => ({
    origin: group.origin,
    name: group.name,
    grade: group.grade,
    count: group.count,
    unit: group.unit,
    moisture: group.moistureCount ? Math.round((group.moistureTotal / group.moistureCount) * 10) / 10 : null,
    reason: [...group.reasons].join('、'),
  }))
}

function tableFilterValue(row: ShipmentTableRow, key: TableColumn) {
  if (key === 'flexconQuantity') return row.flexconQuantityText
  if (key === 'paperBagQuantity') return row.paperBagQuantityText
  return row[key]
}

function ShipmentColumnHeader({
  column,
  sort,
  values,
  selectedValues,
  onSort,
  onFilterChange,
}: {
  column: { key: TableColumn; label: string }
  sort: { key: TableColumn; direction: SortDirection } | null
  values: string[]
  selectedValues: string[] | undefined
  onSort: (key: TableColumn) => void
  onFilterChange: (key: TableColumn, values: string[] | undefined) => void
}) {
  const allSelected = selectedValues === undefined || selectedValues.length === values.length
  const filterRef = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      const filter = filterRef.current
      if (filter?.open && event.target instanceof Node && !filter.contains(event.target)) {
        filter.open = false
      }
    }

    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [])

  return (
    <th className={`shipment-column-${column.key}`}>
      <div className="shipment-column-heading">
        <button type="button" className="shipment-column-sort" onClick={() => onSort(column.key)}>
          <span>{column.label}</span>
          {sort?.key === column.key && (sort.direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
        </button>
        <details ref={filterRef} className={`shipment-column-filter ${column.key === 'shippedAt' ? 'open-right' : ''} ${selectedValues === undefined ? '' : 'active'}`}>
          <summary title={`${column.label}を絞り込む`} aria-label={`${column.label}を絞り込む`}><Filter size={14} /></summary>
          <div className="shipment-filter-menu">
            <strong>{column.label}</strong>
            <label>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => onFilterChange(column.key, allSelected ? [] : undefined)}
              />
              すべて
            </label>
            <div className="shipment-filter-values">
              {values.map((value) => {
                const checked = selectedValues === undefined || selectedValues.includes(value)
                return (
                  <label key={value}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const current = selectedValues ?? values
                        const next = checked
                          ? current.filter((item) => item !== value)
                          : [...current, value]
                        onFilterChange(column.key, next.length === values.length ? undefined : next)
                      }}
                    />
                    {value || '（空白）'}
                  </label>
                )
              })}
            </div>
          </div>
        </details>
      </div>
    </th>
  )
}

export function ShipmentHistory({ refreshKey, workerId, isAdmin }: Props) {
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [transportProfiles, setTransportProfiles] = useState<TransportProfile[]>([])
  const [shipmentProducts, setShipmentProducts] = useState<InspectionOption[]>([])
  const [mixedShipmentByLot, setMixedShipmentByLot] = useState<Record<string, MixedShipmentInfo>>({})
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [localVersion, setLocalVersion] = useState(0)
  const [editing, setEditing] = useState<Shipment | null>(null)
  const [shippedAt, setShippedAt] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [transportProfileId, setTransportProfileId] = useState('')
  const [driverName, setDriverName] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [note, setNote] = useState('')
  const [purchasePrice, setPurchasePrice] = useState('')
  const [manualItems, setManualItems] = useState<ManualShipmentItemDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('cards')
  const [sort, setSort] = useState<{ key: TableColumn; direction: SortDirection } | null>(null)
  const [columnFilters, setColumnFilters] = useState<Partial<Record<TableColumn, string[]>>>({})

  useEffect(() => {
    void Promise.all([
      supabase.from('flexcon_shipments').select('id, destination_id, transport_profile_id, shipped_at, carrier_name, driver_name, vehicle_no, note, shipment_kind, origin_prefecture, product_name, quantity_count, purchase_price_per_bale, flexcon_destinations(name), flexcon_shipment_items(lot_number, origin_prefecture, product_name, grade, moisture, reason), flexcon_manual_shipment_items(id, origin_prefecture, product_name, quantity_count, grade, moisture, reason, sort_order), workers(worker_name)').order('shipped_at', { ascending: false }).limit(200),
      supabase.from('flexcon_mixed_flexcons').select('mixed_no, lot_number, flexcon_mixed_flexcon_members(sort_order, flexcon_authorizations(full_name))'),
    ]).then(([shipmentResult, mixedResult]) => {
      if (shipmentResult.error) setNotice({ type: 'error', text: shipmentResult.error.message })
      else setShipments((shipmentResult.data ?? []) as unknown as Shipment[])

      if (mixedResult.error) {
        setNotice({ type: 'error', text: '混在フレコン情報を取得できません。追加SQLを実行してください。' })
      } else {
        const mixedByLot: Record<string, MixedShipmentInfo> = {}
        for (const mixed of mixedResult.data ?? []) {
          const members = [...(mixed.flexcon_mixed_flexcon_members ?? [])].sort((left, right) => left.sort_order - right.sort_order)
          const firstAuthorization = Array.isArray(members[0]?.flexcon_authorizations)
            ? members[0]?.flexcon_authorizations[0]
            : members[0]?.flexcon_authorizations
          const firstName = firstAuthorization?.full_name
          mixedByLot[mixed.lot_number] = {
            mixedNo: mixed.mixed_no,
            producerLabel: firstName ? (members.length > 1 ? `${firstName}＋他${members.length - 1}名` : firstName) : '生産者未登録',
          }
        }
        setMixedShipmentByLot(mixedByLot)
      }
      })
  }, [refreshKey, localVersion])

  useEffect(() => {
    if (!isAdmin) return
    void Promise.all([
      supabase.from('flexcon_destinations').select('*').order('active', { ascending: false }).order('name'),
      supabase.from('flexcon_transport_profiles').select('*').order('active', { ascending: false }).order('company_name'),
      supabase.from('flexcon_inspection_options').select('*').in('option_type', ['shipment_product', 'brand_aomori', 'brand_iwate', 'grade', 'grade_reason']).order('sort_order').order('name'),
    ]).then(([destinationResult, transportResult, productResult]) => {
      if (destinationResult.error) setNotice({ type: 'error', text: destinationResult.error.message })
      else setDestinations((destinationResult.data ?? []) as Destination[])
      if (transportResult.error) setNotice({ type: 'error', text: transportResult.error.message })
      else setTransportProfiles((transportResult.data ?? []) as TransportProfile[])
      if (!productResult.error) setShipmentProducts((productResult.data ?? []) as InspectionOption[])
    })
  }, [isAdmin])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return shipments
    return shipments.filter((item) =>
      item.flexcon_destinations?.name.toLowerCase().includes(term)
      || item.carrier_name?.toLowerCase().includes(term)
      || item.driver_name?.toLowerCase().includes(term)
      || item.vehicle_no?.toLowerCase().includes(term)
      || item.product_name?.toLowerCase().includes(term)
      || shipmentProductSummary(item).toLowerCase().includes(term)
      || item.workers?.worker_name.toLowerCase().includes(term)
      || item.flexcon_shipment_items.some((detail) => {
        const mixed = mixedShipmentByLot[detail.lot_number]
        return detail.lot_number.includes(term)
          || (mixed ? `混在№${mixed.mixedNo} ${mixed.producerLabel}`.toLowerCase().includes(term) : false)
      }))
  }, [mixedShipmentByLot, search, shipments])

  const tableRows = useMemo(() => shipments.flatMap((shipment, shipmentIndex) =>
    shipmentProductGroups(shipment).map((group, groupIndex) => ({
      id: `${shipment.id}-${groupIndex}-${group.name}`,
      shipment,
      originalOrder: shipmentIndex * 100 + groupIndex,
      shippedAt: formatShipmentDateTime(shipment.shipped_at),
      shippedAtValue: new Date(shipment.shipped_at).getTime(),
      destination: shipment.flexcon_destinations?.name ?? '納品先不明',
      origin: group.origin,
      productName: group.name,
      grade: shipment.shipment_kind === 'other_rice' ? '' : group.grade || '未入力',
      moisture: group.moisture === null ? '' : `${group.moisture.toFixed(1)}%`,
      reason: group.reason,
      flexconQuantity: group.unit === '本' ? group.count : 0,
      flexconQuantityText: group.unit === '本' ? `${group.count}本` : '',
      paperBagQuantity: group.unit === '袋' ? group.count : 0,
      paperBagQuantityText: group.unit === '袋' ? `${group.count}袋` : '',
      carrier: shipment.carrier_name ?? '',
      driver: shipment.driver_name ?? '',
      vehicle: shipment.vehicle_no ?? '',
      worker: shipment.workers?.worker_name ?? '',
      note: shipment.note ?? '',
      searchText: shipment.flexcon_shipment_items.map((item) => {
        const mixed = mixedShipmentByLot[item.lot_number]
        return `${item.lot_number} ${mixed ? `混在№${mixed.mixedNo} ${mixed.producerLabel}` : ''}`
      }).join(' ').toLowerCase(),
    }))), [mixedShipmentByLot, shipments])

  const filterValues = useMemo(() => Object.fromEntries(TABLE_COLUMNS.map((column) => [
    column.key,
    Array.from(new Set(tableRows.map((row) => tableFilterValue(row, column.key)))).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true })),
  ])) as Record<TableColumn, string[]>, [tableRows])

  const displayedTableRows = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = tableRows.filter((row) => {
      if (term && !TABLE_COLUMNS.some((column) => tableFilterValue(row, column.key).toLowerCase().includes(term)) && !row.searchText.includes(term)) return false
      return TABLE_COLUMNS.every((column) => {
        const selected = columnFilters[column.key]
        return selected === undefined || selected.includes(tableFilterValue(row, column.key))
      })
    })

    if (!sort) return rows.sort((a, b) => a.originalOrder - b.originalOrder)
    return rows.sort((a, b) => {
      const left = sort.key === 'flexconQuantity'
        ? a.flexconQuantity
        : sort.key === 'paperBagQuantity'
          ? a.paperBagQuantity
          : sort.key === 'shippedAt'
            ? a.shippedAtValue
            : a[sort.key]
      const right = sort.key === 'flexconQuantity'
        ? b.flexconQuantity
        : sort.key === 'paperBagQuantity'
          ? b.paperBagQuantity
          : sort.key === 'shippedAt'
            ? b.shippedAtValue
            : b[sort.key]
      const comparison = typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), 'ja', { numeric: true })
      return sort.direction === 'asc' ? comparison : -comparison
    })
  }, [columnFilters, search, sort, tableRows])

  const destinationSummaryRows = useMemo(() => {
    const summaries = new Map<string, {
      flexconQuantity: number
      paperBagQuantity: number
    }>()

    displayedTableRows.forEach((row) => {
      const key = `${row.destination}\u001f${row.productName}\u001f${row.grade}`
      const summary = summaries.get(key) ?? {
        flexconQuantity: 0,
        paperBagQuantity: 0,
      }
      summary.flexconQuantity += row.flexconQuantity
      summary.paperBagQuantity += row.paperBagQuantity
      summaries.set(key, summary)
    })

    return Array.from(summaries, ([key, summary]): DestinationSummaryRow => {
      const [destination, productName, grade] = key.split('\u001f')
      return {
        destination,
        productName,
        grade,
        flexconQuantity: summary.flexconQuantity,
        paperBagQuantity: summary.paperBagQuantity,
      }
    }).sort((a, b) => {
      const destinationOrder = a.destination.localeCompare(b.destination, 'ja', { numeric: true })
      return destinationOrder
        || a.productName.localeCompare(b.productName, 'ja', { numeric: true })
        || a.grade.localeCompare(b.grade, 'ja', { numeric: true })
    })
  }, [displayedTableRows])

  const changeSort = (key: TableColumn) => {
    setSort((current) => {
      if (!current || current.key !== key) return { key, direction: 'asc' }
      if (current.direction === 'asc') return { key, direction: 'desc' }
      return null
    })
  }

  const changeColumnFilter = (key: TableColumn, values: string[] | undefined) => {
    setColumnFilters((current) => {
      const next = { ...current }
      if (values === undefined) delete next[key]
      else next[key] = values
      return next
    })
  }

  const beginEdit = (shipment: Shipment) => {
    setEditing(shipment)
    setShippedAt(toLocalDateTime(shipment.shipped_at))
    setDestinationId(shipment.destination_id)
    setTransportProfileId(
      shipment.transport_profile_id
      ?? transportProfiles.find((item) => item.company_name === shipment.carrier_name)?.id
      ?? '',
    )
    setDriverName(shipment.driver_name ?? '')
    setVehicleNo(shipment.vehicle_no ?? '')
    setNote(shipment.note ?? '')
    setPurchasePrice(shipment.purchase_price_per_bale == null ? '' : String(shipment.purchase_price_per_bale))
    setManualItems(shipment.shipment_kind === 'qr_flexcon' ? [] : (
      shipment.flexcon_manual_shipment_items.length > 0
        ? [...shipment.flexcon_manual_shipment_items].sort((a, b) => a.sort_order - b.sort_order).map((item) => ({
          key: item.id,
          originPrefecture: formatPrefectureName(item.origin_prefecture),
          productName: item.product_name,
          quantityCount: String(item.quantity_count),
          grade: item.grade ?? '',
          moisture: item.moisture === null ? '' : String(item.moisture),
          reason: item.reason ?? '',
        }))
        : [{
          key: shipment.id,
          originPrefecture: formatPrefectureName(shipment.origin_prefecture),
          productName: shipment.product_name ?? '',
          quantityCount: String(shipment.quantity_count ?? 1),
          grade: '',
          moisture: '',
          reason: '',
        }]
    ))
    setNotice(null)
  }

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing || !isAdmin) return
    setBusy(true)
    if (editing.shipment_kind !== 'qr_flexcon' && (
      manualItems.length === 0
      || manualItems.some((item) => !item.productName
        || !item.originPrefecture
        || !Number.isInteger(Number(item.quantityCount))
        || Number(item.quantityCount) < 1
        || (editing.shipment_kind === 'paper_bag' && (!item.grade
          || item.moisture.trim() === ''
          || !Number.isFinite(Number(item.moisture))
          || Number(item.moisture) < 0
          || Number(item.moisture) > 100
          || (item.grade !== '1等' && item.grade !== '合格' && !item.reason))))
    )) {
      setNotice({ type: 'error', text: '明細の種類、本数、検査結果を確認してください。' })
      setBusy(false)
      return
    }
    const commonValues = {
      p_worker_id: workerId,
      p_shipment_id: editing.id,
      p_destination_id: destinationId,
      p_transport_profile_id: transportProfileId,
      p_shipped_at: new Date(shippedAt).toISOString(),
      p_driver_name: driverName.trim(),
      p_vehicle_no: vehicleNo.trim(),
      p_purchase_price_per_bale: purchasePrice.trim() === '' ? null : Number(purchasePrice),
      p_note: note.trim() || null,
    }
    const { error } = editing.shipment_kind === 'qr_flexcon'
      ? await supabase.rpc('flexcon_update_shipment', {
        ...commonValues,
        p_origin_prefecture: null,
        p_product_name: null,
        p_quantity_count: editing.quantity_count ?? editing.flexcon_shipment_items.length,
      })
      : await supabase.rpc('flexcon_update_manual_shipment', {
        ...commonValues,
        p_items: manualItems.map((item) => ({
          origin_prefecture: item.originPrefecture,
          product_name: item.productName,
          quantity_count: Number(item.quantityCount),
          grade: editing.shipment_kind === 'paper_bag' ? item.grade : null,
          moisture: editing.shipment_kind === 'paper_bag' ? Number(item.moisture) : null,
          reason: editing.shipment_kind === 'paper_bag' ? item.reason || null : null,
        })),
      })
    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setEditing(null)
      setNotice({ type: 'success', text: '出荷履歴を更新しました。' })
      setLocalVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const deleteShipment = async (shipment: Shipment) => {
    if (!isAdmin) return
    const destination = shipment.flexcon_destinations?.name ?? '納品先不明'
    const count = shipment.quantity_count ?? shipment.flexcon_shipment_items.length
    const unit = shipment.shipment_kind === 'paper_bag' ? '袋' : '本'
    const qrMessage = shipment.shipment_kind === 'qr_flexcon' ? '\n対象のQRコードは未出荷状態へ戻ります。' : ''
    const message = `${destination}への${count}${unit}の出荷履歴を削除しますか？${qrMessage}`
    if (!window.confirm(message)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_shipment', {
      p_worker_id: workerId,
      p_shipment_id: shipment.id,
    })
    if (error) {
      setNotice({ type: 'error', text: error.message })
    } else {
      setNotice({ type: 'success', text: shipment.shipment_kind === 'qr_flexcon' ? '出荷履歴を削除し、対象QRを未出荷へ戻しました。' : '出荷履歴を削除しました。' })
      setLocalVersion((value) => value + 1)
    }
    setBusy(false)
  }

  const exportCsv = () => {
    const rows = [['出荷日時', '納品先', '担当者', '運送会社名', 'ドライバー名', '車両番号', '出荷区分', '産地', '品名', '等級', '水分', '理由', '種類別数量', 'QRコード', '混在フレコン情報', '数量', '単位', '仕入値（1俵当たり）', '備考']]
    filtered.forEach((shipment) => {
      const details = shipment.shipment_kind === 'qr_flexcon'
        ? shipment.flexcon_shipment_items.map((item) => ({
          lotNumber: item.lot_number,
          originPrefecture: formatPrefectureName(item.origin_prefecture ?? shipment.origin_prefecture),
          productName: item.product_name ?? shipment.product_name ?? '品名未登録',
          quantityCount: 1,
          grade: item.grade ?? '',
          moisture: item.moisture,
          reason: item.reason ?? '',
        }))
        : shipment.flexcon_manual_shipment_items.length > 0
          ? [...shipment.flexcon_manual_shipment_items].sort((a, b) => a.sort_order - b.sort_order).map((item) => ({
            lotNumber: '',
            originPrefecture: formatPrefectureName(item.origin_prefecture),
            productName: item.product_name,
            quantityCount: item.quantity_count,
            grade: item.grade ?? '',
            moisture: item.moisture,
            reason: item.reason ?? '',
          }))
          : [{
            lotNumber: '',
            originPrefecture: formatPrefectureName(shipment.origin_prefecture),
            productName: shipment.product_name ?? '品名未登録',
            quantityCount: shipment.quantity_count ?? 0,
            grade: '',
            moisture: null,
            reason: '',
          }]
      details.forEach((item) => rows.push([
        formatShipmentDateTime(shipment.shipped_at),
        shipment.flexcon_destinations?.name ?? '',
        shipment.workers?.worker_name ?? '',
        shipment.carrier_name ?? '',
        shipment.driver_name ?? '',
        shipment.vehicle_no ?? '',
        shipment.shipment_kind === 'paper_bag' ? '紙袋' : shipment.shipment_kind === 'other_rice' ? '銘柄米以外' : mixedShipmentByLot[item.lotNumber] ? '混在フレコン' : 'QRフレコン',
        item.originPrefecture,
        item.productName,
        item.grade,
        item.moisture === null ? '' : `${Number(item.moisture).toFixed(1)}%`,
        item.reason,
        shipmentProductSummary(shipment),
        item.lotNumber,
        mixedShipmentByLot[item.lotNumber] ? `混在№${mixedShipmentByLot[item.lotNumber].mixedNo} ${mixedShipmentByLot[item.lotNumber].producerLabel}` : '',
        String(item.quantityCount),
        shipment.shipment_kind === 'paper_bag' ? '袋' : '本',
        shipment.purchase_price_per_bale == null ? '' : String(shipment.purchase_price_per_bale),
        shipment.note ?? '',
      ]))
    })
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
    const csv = '\uFEFF' + rows.map((row) => row.map(quote).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `出荷履歴_${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <div className="page-heading"><h1>出荷履歴</h1><p>納品先、担当者、運送会社、ドライバー、車両番号、ロット番号、混在№、生産者名で検索できます。</p></div>
      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
      <div className="search-row">
        <div style={{ position: 'relative', flex: 1 }}><Search size={18} style={{ position: 'absolute', left: 12, top: 13, color: '#6b756d' }} /><input style={{ paddingLeft: 38 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="検索" /></div>
        <div className="view-mode-switch" role="group" aria-label="表示形式">
          <button type="button" className={viewMode === 'cards' ? 'active' : ''} title="パネル表示" aria-label="パネル表示" onClick={() => setViewMode('cards')}><LayoutGrid size={18} /></button>
          <button type="button" className={viewMode === 'table' ? 'active' : ''} title="一覧表示" aria-label="一覧表示" onClick={() => setViewMode('table')}><Table2 size={18} /></button>
        </div>
        <button className="secondary-button" type="button" onClick={exportCsv} disabled={filtered.length === 0} title="CSV出力"><Download size={19} /><span>CSV</span></button>
      </div>
      {viewMode === 'cards' ? (
        <div className="shipment-list">
          {filtered.map((shipment) => (
            <article className="shipment-item" key={shipment.id}>
              <div className="shipment-head">
                <div>
                  <div className="shipment-title-line">
                    <strong>{shipment.flexcon_destinations?.name ?? '納品先不明'}</strong>
                    <span>{shipmentProductSummary(shipment)}</span>
                  </div>
                  <small>{formatShipmentDateTime(shipment.shipped_at)}</small>
                  <small><UserRound size={13} className="inline-icon" />担当：{shipment.workers?.worker_name ?? '不明'}</small>
                  {shipment.carrier_name && <small><Building2 size={13} className="inline-icon" />{shipment.carrier_name} / {shipment.driver_name ?? 'ドライバー不明'}</small>}
                  {shipment.vehicle_no && <small><Truck size={13} className="inline-icon" />{shipment.vehicle_no}</small>}
                  {shipment.purchase_price_per_bale != null && <small>仕入値：{shipment.purchase_price_per_bale.toLocaleString('ja-JP')}円／俵</small>}
                </div>
                <div className="shipment-side">
                  <span className="shipment-count">{shipment.quantity_count ?? shipment.flexcon_shipment_items.length}{shipment.shipment_kind === 'paper_bag' ? '袋' : '本'}</span>
                  {isAdmin && (
                    <div className="shipment-admin-actions">
                      <button className="icon-button" type="button" title="出荷履歴を編集" aria-label="出荷履歴を編集" onClick={() => beginEdit(shipment)} disabled={busy}><Pencil size={18} /></button>
                      <button className="icon-button delete-icon" type="button" title="出荷履歴を削除" aria-label="出荷履歴を削除" onClick={() => void deleteShipment(shipment)} disabled={busy}><Trash2 size={18} /></button>
                    </div>
                  )}
                </div>
              </div>
              {shipment.flexcon_shipment_items.length > 0 && <div className="lot-tags">{shipment.flexcon_shipment_items.map((item) => {
                const mixed = mixedShipmentByLot[item.lot_number]
                return <span className={`lot-tag shipment-result-tag ${mixed ? 'mixed-lot-tag' : ''}`} key={item.lot_number}>{mixed ? <><strong>混在№{mixed.mixedNo}</strong><span>{mixed.producerLabel}</span><code>{item.lot_number}</code></> : <code>{item.lot_number}</code>}<small>{item.grade || '等級未入力'}{item.moisture === null ? '' : `　水分 ${item.moisture.toFixed(1)}%`}{item.reason ? `　${item.reason}` : ''}</small></span>
              })}</div>}
              {shipment.shipment_kind === 'paper_bag' && <div className="shipment-manual-results">{shipmentProductGroups(shipment).map((group, index) => <span key={`${group.name}-${group.grade}-${index}`}><strong>{group.name}　{group.grade || '等級未入力'}</strong><small>{group.moisture === null ? '水分未入力' : `水分 ${group.moisture.toFixed(1)}%`}{group.reason ? `　${group.reason}` : ''}</small></span>)}</div>}
              {shipment.note && <p className="shipment-note">{shipment.note}</p>}
            </article>
          ))}
          {filtered.length === 0 && <div className="empty-state">該当する出荷履歴がありません</div>}
        </div>
      ) : (
        <div className="shipment-table-view">
          <section className="shipment-destination-summary" aria-labelledby="destination-summary-title">
            <div className="section-title"><div><h2 id="destination-summary-title">納品先別集計</h2><span>{destinationSummaryRows.length}件</span></div></div>
            <div className="shipment-summary-table-wrap">
              <table className="shipment-summary-table">
                <thead><tr><th>納品先</th><th>品名</th><th>等級</th><th>フレコン本数</th><th>紙袋数</th></tr></thead>
                <tbody>
                  {destinationSummaryRows.map((row) => (
                    <tr key={`${row.destination}-${row.productName}-${row.grade}`}>
                      <td>{row.destination}</td>
                      <td>{row.productName}</td>
                      <td>{row.grade}</td>
                      <td className="numeric-cell">{row.flexconQuantity ? `${row.flexconQuantity}本` : ''}</td>
                      <td className="numeric-cell">{row.paperBagQuantity ? `${row.paperBagQuantity}袋` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {destinationSummaryRows.length === 0 && <div className="empty-state">集計する出荷履歴がありません</div>}
            </div>
          </section>

          <div className="shipment-table-wrap">
            <table className="shipment-table">
              <thead>
                <tr>
                  {TABLE_COLUMNS.map((column) => (
                    <ShipmentColumnHeader
                      key={column.key}
                      column={column}
                      sort={sort}
                      values={filterValues[column.key]}
                      selectedValues={columnFilters[column.key]}
                      onSort={changeSort}
                      onFilterChange={changeColumnFilter}
                    />
                  ))}
                  {isAdmin && <th className="shipment-actions-heading">操作</th>}
                </tr>
              </thead>
              <tbody>
                {displayedTableRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.shippedAt}</td>
                    <td>{row.destination}</td>
                    <td>{row.origin}</td>
                    <td>{row.productName}</td>
                    <td>{row.grade}</td>
                    <td className="numeric-cell">{row.moisture}</td>
                    <td>{row.reason}</td>
                    <td className="numeric-cell">{row.flexconQuantityText}</td>
                    <td className="numeric-cell">{row.paperBagQuantityText}</td>
                    <td>{row.carrier}</td>
                    <td>{row.driver}</td>
                    <td>{row.vehicle}</td>
                    <td>{row.worker}</td>
                    <td className="shipment-note-cell">{row.note}</td>
                    {isAdmin && (
                      <td className="shipment-actions-cell">
                        <div className="shipment-table-actions">
                          <button className="icon-button" type="button" title="出荷履歴を編集" aria-label={`${row.destination}の出荷履歴を編集`} onClick={() => beginEdit(row.shipment)} disabled={busy}><Pencil size={17} /></button>
                          <button className="icon-button delete-icon" type="button" title="出荷履歴を削除" aria-label={`${row.destination}の出荷履歴を削除`} onClick={() => void deleteShipment(row.shipment)} disabled={busy}><Trash2 size={17} /></button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {displayedTableRows.length === 0 && <div className="empty-state">該当する出荷履歴がありません</div>}
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop" role="presentation">
          <section className="registration-modal" role="dialog" aria-modal="true" aria-labelledby="history-edit-title">
            <div className="modal-header">
              <div><h2 id="history-edit-title">出荷履歴を編集</h2><p>{editing.quantity_count ?? editing.flexcon_shipment_items.length}{editing.shipment_kind === 'paper_bag' ? '袋' : '本'}の出荷情報</p></div>
              <button className="icon-button" type="button" title="閉じる" aria-label="編集画面を閉じる" onClick={() => setEditing(null)} disabled={busy}><X size={21} /></button>
            </div>

            {notice?.type === 'error' && <div className="notice error">{notice.text}</div>}

            {editing.flexcon_shipment_items.length > 0 && <div className="lot-tags history-edit-lots">{editing.flexcon_shipment_items.map((item) => {
              const mixed = mixedShipmentByLot[item.lot_number]
              return <span className={`lot-tag ${mixed ? 'mixed-lot-tag' : ''}`} key={item.lot_number}>{mixed ? <><strong>混在№{mixed.mixedNo}</strong><span>{mixed.producerLabel}</span><code>{item.lot_number}</code></> : item.lot_number}</span>
            })}</div>}

            <form className="form-grid" onSubmit={(event) => void saveEdit(event)}>
              {editing.shipment_kind !== 'qr_flexcon' && <ManualShipmentItemsEditor key={editing.id} kind={editing.shipment_kind} items={manualItems} onChange={setManualItems} shipmentProducts={shipmentProducts} disabled={busy} />}
              <div className="form-grid two">
                <label>出荷日時<input type="datetime-local" step={60} value={shippedAt} onChange={(e) => setShippedAt(e.target.value)} required /></label>
                <label>納品先
                  <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)} required>
                    <option value="">選択してください</option>
                    {destinations.map((item) => <option key={item.id} value={item.id} disabled={!item.active}>{item.name}{item.active ? '' : '（無効）'}</option>)}
                  </select>
                </label>
              </div>
              <label>運送会社
                <select value={transportProfileId} onChange={(e) => setTransportProfileId(e.target.value)} required>
                  <option value="">選択してください</option>
                  {transportProfiles.map((item) => <option key={item.id} value={item.id} disabled={!item.active}>{item.company_name}{item.active ? '' : '（無効）'}</option>)}
                </select>
              </label>
              <fieldset className="driver-vehicle-fields">
                <legend>ドライバー・車両情報</legend>
                <div className="form-grid two">
                  <label>ドライバー名<input value={driverName} onChange={(e) => setDriverName(e.target.value)} required /></label>
                  <label>車両番号<input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} required /></label>
                </div>
              </fieldset>
              <label>仕入値（任意・1俵当たり）<input type="number" min="0" step="0.01" inputMode="decimal" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} /></label>
              <label>備考（任意）<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <div className="modal-actions">
                <button className="secondary-button" type="button" onClick={() => setEditing(null)} disabled={busy}>取消</button>
                <button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? '保存中...' : '変更を保存'}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}
