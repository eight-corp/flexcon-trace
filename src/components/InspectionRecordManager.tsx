import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, BarChart3, ChevronDown, CircleAlert, ClipboardList, ExternalLink, FileText, Filter, List, Plus, Printer, Search, TableRowsSplit, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatPrefectureName } from '../lib/prefecture'
import type { AuthorizationRecord, FlexconInspection, InspectionOption, InspectionRegistration, InspectionWeight, PaperBagInspection } from '../types'

type Props = {
  workerId: string
  readOnly: boolean
  selectedAuthorizationId: string | null
  selectedRegistrationId: string | null
  selectedRecordTarget: InspectionRecordTarget | null
  onSelectedAuthorizationChange: (authorizationId: string | null) => void
  onSelectedRegistrationChange: (registrationId: string | null) => void
  onSelectedRecordTargetChange: (target: InspectionRecordTarget | null) => void
  onBack: () => void
}
export type InspectionRecordTarget = { kind: 'flexcon' | 'paper'; id: string }
type Notice = { type: 'success' | 'error'; text: string } | null
type AddGroupForm = {
  authorization_id: string
  producer_name: string
  fiscal_year: string
  purchase_date: string
  inspection_date: string
  inspection_location: string
  brand: string
  flexcon_count: string
  paper_bag_count: string
  bulk_quantity_kg: string
}
type InlineDetailDraft = {
  fiscal_year: string
  purchase_date: string
  inspection_date: string
  inspector_name: string
  inspection_location: string
  brand: string
  quantity: string
  grade: string
  reason: string
  moisture: string
}
type GeneratedCertificate = {
  url: string
  fileName: string
  flexconIds: string[]
  count: number
  previouslyPrintedCount: number
}
type CertificateKind = 'standard' | 'bulk'
type GradingNoticeFailure = {
  summary: string
  reasons: string[]
}
type InspectionProgressRow = {
  fiscalYear: number
  origin: string
  brand: string
  inspectedQuantity: number
  uninspectedQuantity: number
}
type InspectionDetailRow = {
  id: string
  registrationId: string
  authorizationId: string
  fiscalYear: number
  origin: string
  brand: string
  kind: 'flexcon' | 'paper'
  recordNo: number | null
  quantityKg: number
  quantityLabel: string
  authorizationNo: string
  fullName: string
  purchaseDate: string
  inspectionDate: string | null
  moisture: number | null
  grade: string | null
  missingFields: string[]
  complete: boolean
}
type InspectionRegistrationSummaryRow = {
  registrationId: string
  registrationNo: number
  authorizationId: string
  purchaseDates: string
  inspectionDates: string
  fullName: string
  origin: string
  municipality: string
  inspectionLocations: string
  authorizationNo: string
  brands: string
  flexconCount: number
  paperBagCount: number
  bulkQuantity: number
  inspectedQuantity: number
  uninspectedQuantity: number
}
type SummarySortDirection = 'asc' | 'desc'
type SummaryColumn = 'registrationNo' | 'purchaseDates' | 'inspectionDates' | 'fullName' | 'origin' | 'municipality' | 'inspectionLocations' | 'authorizationNo' | 'brands' | 'flexconCount' | 'paperBagCount' | 'bulkQuantity' | 'inspectedQuantity' | 'uninspectedQuantity'

const SUMMARY_COLUMNS: Array<{ key: SummaryColumn; label: string }> = [
  { key: 'registrationNo', label: '登録No.' },
  { key: 'purchaseDates', label: '仕入日' },
  { key: 'inspectionDates', label: '検査日' },
  { key: 'fullName', label: '氏名' },
  { key: 'origin', label: '産地' },
  { key: 'municipality', label: '市町村名' },
  { key: 'inspectionLocations', label: '検査場所' },
  { key: 'authorizationNo', label: '委任状No.' },
  { key: 'brands', label: '銘柄' },
  { key: 'flexconCount', label: '推フレ数' },
  { key: 'paperBagCount', label: '紙袋数' },
  { key: 'bulkQuantity', label: 'バラ数量' },
  { key: 'inspectedQuantity', label: '検査済み数量' },
  { key: 'uninspectedQuantity', label: '未検査数量' },
]

const DEFAULT_BRANDED_RICE_WEIGHT = 1020
const DEFAULT_FEED_RICE_WEIGHT = 1000
const AUTHORIZATION_NO_COLLATOR = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })

function currentFiscalYear() { return new Date().getFullYear() - 2018 }
function westernYear(fiscalYear: number) { return fiscalYear >= 2000 ? fiscalYear : fiscalYear + 2018 }
function today() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}
function emptyAddGroupForm(): AddGroupForm {
  return {
    authorization_id: '',
    producer_name: '',
    fiscal_year: String(currentFiscalYear()),
    purchase_date: today(),
    inspection_date: '',
    inspection_location: '',
    brand: '',
    flexcon_count: '',
    paper_bag_count: '',
    bulk_quantity_kg: '',
  }
}
function isHighMoisture(value: string | number | null | undefined) {
  return value !== null && value !== undefined && value !== '' && Number(value) > 16
}
function isFeedRiceBrand(brand: string) {
  return brand.trim() === '飼料用玄米'
}
function flexconRecordKind(item: FlexconInspection, weights: Record<InspectionWeight['weight_type'], number>) {
  if (item.record_kind === 'standard' || item.record_kind === 'bulk') return item.record_kind
  const standardWeight = isFeedRiceBrand(item.brand ?? '') ? weights.feed_rice : weights.branded_rice
  return item.quantity_kg === standardWeight ? 'standard' : 'bulk'
}
function isGradeAllowedForBrand(brand: string, grade: string) {
  if (!grade) return true
  return isFeedRiceBrand(brand) ? grade === '合格' : grade !== '合格'
}
function isInspectionResultComplete(item: FlexconInspection | PaperBagInspection) {
  const reasonOptional = item.grade === '1等' || item.grade === '合格'
  const quantity = 'quantity_kg' in item ? item.quantity_kg : item.bag_count
  return item.fiscal_year > 0
    && Boolean(item.purchase_date)
    && Boolean(item.inspection_date)
    && Boolean(item.inspector_name?.trim())
    && Boolean(item.inspection_location?.trim())
    && Boolean(item.brand?.trim())
    && quantity > 0
    && item.moisture !== null
    && Boolean(item.grade?.trim())
    && isGradeAllowedForBrand(item.brand ?? '', item.grade ?? '')
    && (reasonOptional || Boolean(item.reason?.trim()))
}
function incompleteInspectionFields(item: FlexconInspection | PaperBagInspection) {
  const fields: string[] = []
  const quantity = 'quantity_kg' in item ? item.quantity_kg : item.bag_count
  if (item.fiscal_year <= 0) fields.push('年度')
  if (!item.purchase_date) fields.push('仕入日')
  if (!item.inspection_date) fields.push('検査日')
  if (!item.inspector_name?.trim()) fields.push('検査員')
  if (!item.inspection_location?.trim()) fields.push('検査場所')
  if (!item.brand?.trim()) fields.push('銘柄')
  if (quantity <= 0) fields.push('数量')
  if (item.moisture === null) fields.push('水分')
  if (!item.grade?.trim()) {
    fields.push('等級')
  } else if (!isGradeAllowedForBrand(item.brand ?? '', item.grade)) {
    fields.push('銘柄に対応する等級')
  }
  if (item.grade?.trim() && item.grade !== '1等' && item.grade !== '合格' && !item.reason?.trim()) fields.push('理由')
  return fields
}
function gradingNoticeFailureFor(items: Array<FlexconInspection | PaperBagInspection>): GradingNoticeFailure {
  if (items.length === 0) {
    return {
      summary: '格付結果通知票の対象となる検査記録がありません。',
      reasons: ['フレコンまたは紙袋を登録してください。'],
    }
  }
  const missingCounts = new Map<string, number>()
  items.forEach((item) => incompleteInspectionFields(item).forEach((field) => (
    missingCounts.set(field, (missingCounts.get(field) ?? 0) + 1)
  )))
  return {
    summary: '検査完了と判定できる行がないため、格付結果通知票を作成できません。',
    reasons: missingCounts.size > 0
      ? [...missingCounts].map(([field, count]) => `${field}：未完了 ${count}行`)
      : ['検査記録の入力内容を確認してください。'],
  }
}
function inspectionLedgerFailureFor(items: Array<FlexconInspection | PaperBagInspection>): GradingNoticeFailure {
  const failure = gradingNoticeFailureFor(items)
  return {
    summary: failure.summary.replaceAll('格付結果通知票', '検査請求者別検査台帳'),
    reasons: failure.reasons,
  }
}
function displayDate(value: string | null | undefined) { return value ? value.replaceAll('-', '/') : '' }
function joinDistinct(values: Array<string | null | undefined>, formatter: (value: string) => string = (value) => value) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)).map(formatter))].join('、')
}
function summaryDisplayValue(row: InspectionRegistrationSummaryRow, key: SummaryColumn) {
  if (key === 'flexconCount') return `${row.flexconCount}本`
  if (key === 'paperBagCount') return `${row.paperBagCount}袋`
  if (key === 'bulkQuantity' || key === 'inspectedQuantity' || key === 'uninspectedQuantity') return `${row[key].toLocaleString()}kg`
  return String(row[key] ?? '')
}
function summarySortValue(row: InspectionRegistrationSummaryRow, key: SummaryColumn) {
  if (key === 'registrationNo' || key === 'flexconCount' || key === 'paperBagCount' || key === 'bulkQuantity' || key === 'inspectedQuantity' || key === 'uninspectedQuantity') return row[key]
  return String(row[key] ?? '')
}
function InspectionSummaryColumnHeader({
  column,
  sort,
  values,
  selectedValues,
  onSort,
  onFilterChange,
}: {
  column: { key: SummaryColumn; label: string }
  sort: { key: SummaryColumn; direction: SummarySortDirection } | null
  values: string[]
  selectedValues: string[] | undefined
  onSort: (key: SummaryColumn) => void
  onFilterChange: (key: SummaryColumn, values: string[] | undefined) => void
}) {
  const allSelected = selectedValues === undefined || selectedValues.length === values.length
  const filterRef = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      const filter = filterRef.current
      if (filter?.open && event.target instanceof Node && !filter.contains(event.target)) filter.open = false
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [])

  return <th className={`inspection-summary-column-heading inspection-summary-column-${column.key}`}>
    <div className="shipment-column-heading">
      <button type="button" className="shipment-column-sort" onClick={() => onSort(column.key)}>
        <span>{column.label}</span>
        {sort?.key === column.key && (sort.direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
      </button>
      <details ref={filterRef} className={`shipment-column-filter ${column.key === 'registrationNo' ? 'open-right' : ''} ${selectedValues === undefined ? '' : 'active'}`}>
        <summary title={`${column.label}を絞り込む`} aria-label={`${column.label}を絞り込む`}><Filter size={14} /></summary>
        <div className="shipment-filter-menu">
          <strong>{column.label}</strong>
          <label><input type="checkbox" checked={allSelected} onChange={() => onFilterChange(column.key, allSelected ? [] : undefined)} />すべて</label>
          <div className="shipment-filter-values">
            {values.map((value) => {
              const checked = selectedValues === undefined || selectedValues.includes(value)
              return <label key={value}>
                <input type="checkbox" checked={checked} onChange={() => {
                  const current = selectedValues ?? values
                  const next = checked ? current.filter((item) => item !== value) : [...current, value]
                  onFilterChange(column.key, next.length === values.length ? undefined : next)
                }} />
                {value || '（空白）'}
              </label>
            })}
          </div>
        </div>
      </details>
    </div>
  </th>
}
function displayCropYear(value: number) { return value >= 2000 ? `${value}年産` : `令和${value}年産` }
function brandTypeForPrefecture(prefecture: string | null): 'brand_aomori' | 'brand_iwate' | null {
  const normalized = (prefecture ?? '').trim().replace(/県$/, '')
  if (normalized === '青森') return 'brand_aomori'
  if (normalized === '岩手') return 'brand_iwate'
  return null
}
export function InspectionRecordManager({ workerId, readOnly, selectedAuthorizationId, selectedRegistrationId, selectedRecordTarget, onSelectedAuthorizationChange, onSelectedRegistrationChange, onSelectedRecordTargetChange, onBack }: Props) {
  const [authorizations, setAuthorizations] = useState<AuthorizationRecord[]>([])
  const [registrations, setRegistrations] = useState<InspectionRegistration[]>([])
  const [flexcons, setFlexcons] = useState<FlexconInspection[]>([])
  const [paperBags, setPaperBags] = useState<PaperBagInspection[]>([])
  const [inspectionOptions, setInspectionOptions] = useState<InspectionOption[]>([])
  const [weights, setWeights] = useState<Record<InspectionWeight['weight_type'], number>>({ branded_rice: DEFAULT_BRANDED_RICE_WEIGHT, feed_rice: DEFAULT_FEED_RICE_WEIGHT })
  const [addGroupForm, setAddGroupForm] = useState<AddGroupForm>(emptyAddGroupForm)
  const [addGroupFormOpen, setAddGroupFormOpen] = useState(false)
  const [producerPickerOpen, setProducerPickerOpen] = useState(false)
  const [detailDrafts, setDetailDrafts] = useState<Record<string, InlineDetailDraft>>({})
  const [splitPaper, setSplitPaper] = useState<PaperBagInspection | null>(null)
  const [splitCounts, setSplitCounts] = useState({ first: '', second: '' })
  const [summaryView, setSummaryView] = useState<'list' | 'aggregate'>('list')
  const [search, setSearch] = useState('')
  const [summarySort, setSummarySort] = useState<{ key: SummaryColumn; direction: SummarySortDirection } | null>(null)
  const [summaryColumnFilters, setSummaryColumnFilters] = useState<Partial<Record<SummaryColumn, string[]>>>({})
  const [notice, setNotice] = useState<Notice>(null)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [certificateDialogOpen, setCertificateDialogOpen] = useState(false)
  const [certificateKind, setCertificateKind] = useState<CertificateKind>('standard')
  const [certificateRange, setCertificateRange] = useState({ start: '', end: '' })
  const [certificateBusy, setCertificateBusy] = useState(false)
  const [certificateError, setCertificateError] = useState('')
  const [generatedCertificate, setGeneratedCertificate] = useState<GeneratedCertificate | null>(null)
  const [gradingNoticeBusy, setGradingNoticeBusy] = useState(false)
  const [gradingNoticeFailure, setGradingNoticeFailure] = useState<GradingNoticeFailure | null>(null)
  const [inspectionLedgerBusy, setInspectionLedgerBusy] = useState(false)
  const [inspectionLedgerFailure, setInspectionLedgerFailure] = useState<GradingNoticeFailure | null>(null)
  const detailSaveChains = useRef(new Map<string, Promise<void>>())
  const scrolledRecordTargetRef = useRef<string | null>(null)

  useEffect(() => {
    const load = async () => {
      const [authorizationResult, registrationResult, flexconResult, paperResult, optionResult, weightResult] = await Promise.all([
        supabase.from('flexcon_authorizations').select('*').order('authorization_no'),
        supabase.from('flexcon_inspection_registrations').select('*').order('registration_no'),
        supabase.from('flexcon_inspection_flexcons').select('*').order('purchase_date', { ascending: false }).order('flexcon_no'),
        supabase.from('flexcon_inspection_paper_bags').select('*').order('purchase_date', { ascending: false }).order('created_at'),
        supabase.from('flexcon_inspection_options').select('*').eq('active', true).order('sort_order').order('name'),
        supabase.from('flexcon_inspection_weights').select('*'),
      ])
      if (registrationResult.error || flexconResult.error || paperResult.error) {
        setNotice({ type: 'error', text: '登録No.対応の検査記録用SQLを実行してください。' })
        return
      }
      if (authorizationResult.error) {
        setNotice({ type: 'error', text: authorizationResult.error.message })
        return
      }
      setAuthorizations(((authorizationResult.data ?? []) as AuthorizationRecord[]).sort((left, right) => (
        AUTHORIZATION_NO_COLLATOR.compare(left.authorization_no, right.authorization_no)
      )))
      setRegistrations((registrationResult.data ?? []) as InspectionRegistration[])
      setFlexcons((flexconResult.data ?? []) as FlexconInspection[])
      setPaperBags((paperResult.data ?? []) as PaperBagInspection[])
      if (!optionResult.error) setInspectionOptions((optionResult.data ?? []) as InspectionOption[])
      if (!weightResult.error) {
        const loadedWeights = weightResult.data as InspectionWeight[]
        setWeights({
          branded_rice: loadedWeights.find((item) => item.weight_type === 'branded_rice')?.weight_kg ?? DEFAULT_BRANDED_RICE_WEIGHT,
          feed_rice: loadedWeights.find((item) => item.weight_type === 'feed_rice')?.weight_kg ?? DEFAULT_FEED_RICE_WEIGHT,
        })
      }
    }
    void load()
  }, [version])

  useEffect(() => {
    if (!selectedRecordTarget) {
      scrolledRecordTargetRef.current = null
      return
    }
    if (!selectedAuthorizationId) return
    const targetKey = `${selectedRecordTarget.kind}:${selectedRecordTarget.id}`
    if (scrolledRecordTargetRef.current === targetKey) return
    const records = selectedRecordTarget.kind === 'flexcon' ? flexcons : paperBags
    if (!records.some((item) => item.id === selectedRecordTarget.id)) return
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`inspection-record-${selectedRecordTarget.id}`)
      target?.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' })
      const tableWrap = target?.closest('.inspection-detail-table-wrap')
      if (tableWrap instanceof HTMLElement) tableWrap.scrollLeft = 0
      if (target) scrolledRecordTargetRef.current = targetKey
    })
    return () => window.cancelAnimationFrame(frame)
  }, [flexcons, paperBags, selectedAuthorizationId, selectedRecordTarget])

  const selectedAuthorization = authorizations.find((item) => item.id === selectedAuthorizationId) ?? null
  const addAuthorization = authorizations.find((item) => item.id === addGroupForm.authorization_id) ?? null
  const producerCandidates = useMemo(() => {
    const term = addGroupForm.producer_name.trim().toLowerCase()
    return authorizations.filter((item) => !term || [
      item.authorization_no,
      item.full_name,
      item.prefecture,
      item.municipality,
    ].some((value) => String(value ?? '').toLowerCase().includes(term))).slice(0, 20)
  }, [addGroupForm.producer_name, authorizations])
  const selectedFlexcons = flexcons
    .filter((item) => item.authorization_id === selectedAuthorizationId && (readOnly || !selectedRegistrationId || item.registration_id === selectedRegistrationId))
    .sort((left, right) => left.flexcon_no - right.flexcon_no)
  const selectedStandardFlexcons = selectedFlexcons.filter((item) => flexconRecordKind(item, weights) === 'standard')
  const selectedBulkFlexcons = selectedFlexcons.filter((item) => flexconRecordKind(item, weights) === 'bulk')
  const standardCertificateFlexcons = selectedStandardFlexcons.filter((item) => item.quantity_kg === (isFeedRiceBrand(item.brand ?? '') ? weights.feed_rice : weights.branded_rice))
  const selectedPaperBags = paperBags.filter((item) => item.authorization_id === selectedAuthorizationId && (readOnly || !selectedRegistrationId || item.registration_id === selectedRegistrationId))
  const selectedRegistration = registrations.find((item) => item.id === selectedRegistrationId) ?? null
  const certificateFlexconsFor = (kind: CertificateKind) => kind === 'bulk' ? selectedBulkFlexcons : standardCertificateFlexcons

  const summaryRows = useMemo(() => {
    const authorizationById = new Map(authorizations.map((item) => [item.id, item]))
    const flexconsByRegistration = new Map<string, FlexconInspection[]>()
    const paperBagsByRegistration = new Map<string, PaperBagInspection[]>()
    flexcons.forEach((item) => {
      const rows = flexconsByRegistration.get(item.registration_id) ?? []
      rows.push(item)
      flexconsByRegistration.set(item.registration_id, rows)
    })
    paperBags.forEach((item) => {
      const rows = paperBagsByRegistration.get(item.registration_id) ?? []
      rows.push(item)
      paperBagsByRegistration.set(item.registration_id, rows)
    })
    return registrations.map((registration): InspectionRegistrationSummaryRow | null => {
    const authorization = authorizationById.get(registration.authorization_id)
    if (!authorization) return null
    const registeredFlexcons = flexconsByRegistration.get(registration.id) ?? []
    const registeredPaperBags = paperBagsByRegistration.get(registration.id) ?? []
    const records: Array<FlexconInspection | PaperBagInspection> = [...registeredFlexcons, ...registeredPaperBags]
    if (records.length === 0) return null
    const standardFlexcons = registeredFlexcons.filter((item) => flexconRecordKind(item, weights) === 'standard')
    const bulkFlexcons = registeredFlexcons.filter((item) => flexconRecordKind(item, weights) === 'bulk')
    const quantityFor = (item: FlexconInspection | PaperBagInspection) => (
      'quantity_kg' in item ? item.quantity_kg : item.bag_count * 30
    )
    return {
      registrationId: registration.id,
      registrationNo: registration.registration_no,
      authorizationId: authorization.id,
      purchaseDates: joinDistinct(records.map((item) => item.purchase_date), displayDate),
      inspectionDates: joinDistinct(records.map((item) => item.inspection_date), displayDate),
      fullName: authorization.full_name,
      origin: formatPrefectureName(authorization.prefecture),
      municipality: authorization.municipality ?? '',
      inspectionLocations: joinDistinct(records.map((item) => item.inspection_location)),
      authorizationNo: authorization.authorization_no,
      brands: joinDistinct(records.map((item) => item.brand)),
      flexconCount: standardFlexcons.length,
      paperBagCount: registeredPaperBags.reduce((total, item) => total + item.bag_count, 0),
      bulkQuantity: bulkFlexcons.reduce((total, item) => total + item.quantity_kg, 0),
      inspectedQuantity: records.filter(isInspectionResultComplete).reduce((total, item) => total + quantityFor(item), 0),
      uninspectedQuantity: records.filter((item) => !isInspectionResultComplete(item)).reduce((total, item) => total + quantityFor(item), 0),
    }
    }).filter((row): row is InspectionRegistrationSummaryRow => row !== null)
      .sort((left, right) => left.registrationNo - right.registrationNo)
  }, [authorizations, flexcons, paperBags, registrations, weights])
  const summaryFilterValues = useMemo(() => Object.fromEntries(SUMMARY_COLUMNS.map((column) => [
    column.key,
    Array.from(new Set(summaryRows.map((row) => summaryDisplayValue(row, column.key)))).sort((left, right) => left.localeCompare(right, 'ja', { numeric: true })),
  ])) as Record<SummaryColumn, string[]>, [summaryRows])
  const displayedSummary = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = summaryRows.filter((row) => {
      if (term && !SUMMARY_COLUMNS.some((column) => summaryDisplayValue(row, column.key).toLowerCase().includes(term))) return false
      return SUMMARY_COLUMNS.every((column) => {
        const selected = summaryColumnFilters[column.key]
        return selected === undefined || selected.includes(summaryDisplayValue(row, column.key))
      })
    })
    if (!summarySort) return rows
    return rows.sort((left, right) => {
      const leftValue = summarySortValue(left, summarySort.key)
      const rightValue = summarySortValue(right, summarySort.key)
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), 'ja', { numeric: true })
      return summarySort.direction === 'asc' ? comparison : -comparison
    })
  }, [search, summaryColumnFilters, summaryRows, summarySort])
  const changeSummarySort = (key: SummaryColumn) => {
    setSummarySort((current) => {
      if (!current || current.key !== key) return { key, direction: 'asc' }
      if (current.direction === 'asc') return { key, direction: 'desc' }
      return null
    })
  }
  const changeSummaryColumnFilter = (key: SummaryColumn, values: string[] | undefined) => {
    setSummaryColumnFilters((current) => {
      const next = { ...current }
      if (values === undefined) delete next[key]
      else next[key] = values
      return next
    })
  }

  const deleteInspectionRegistration = async (row: InspectionRegistrationSummaryRow) => {
    const details = [
      `推フレ ${row.flexconCount}本`,
      `紙袋 ${row.paperBagCount}袋`,
      `バラ ${row.bulkQuantity.toLocaleString()}kg`,
    ].join('、')
    if (!window.confirm(`登録No. ${row.registrationNo}（${row.fullName}）を削除しますか？\n${details}\n\nこの操作は取り消せません。`)) return

    setBusy(true)
    setNotice(null)
    const { error } = await supabase.rpc('flexcon_delete_inspection_registration', {
      p_worker_id: workerId,
      p_registration_id: row.registrationId,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })

    setNotice({ type: 'success', text: `登録No. ${row.registrationNo}を削除しました。` })
    setVersion((value) => value + 1)
  }

  const inspectionProgressRows = useMemo(() => {
    const authorizationById = new Map(authorizations.map((authorization) => [authorization.id, authorization]))
    const grouped = new Map<string, InspectionProgressRow>()
    const addRecord = (item: FlexconInspection | PaperBagInspection, quantity: number) => {
      const authorization = authorizationById.get(item.authorization_id)
      const origin = formatPrefectureName(authorization?.prefecture) || '産地未登録'
      const brand = item.brand?.trim() || '銘柄未登録'
      const key = JSON.stringify([item.fiscal_year, origin, brand])
      const row = grouped.get(key) ?? {
        fiscalYear: item.fiscal_year,
        origin,
        brand,
        inspectedQuantity: 0,
        uninspectedQuantity: 0,
      }
      if (isInspectionResultComplete(item)) {
        row.inspectedQuantity += quantity
      } else {
        row.uninspectedQuantity += quantity
      }
      grouped.set(key, row)
    }
    flexcons.forEach((item) => addRecord(item, item.quantity_kg))
    paperBags.forEach((item) => addRecord(item, item.bag_count * 30))
    return [...grouped.values()].sort((left, right) => (
      right.fiscalYear - left.fiscalYear
      || left.origin.localeCompare(right.origin, 'ja', { numeric: true })
      || left.brand.localeCompare(right.brand, 'ja', { numeric: true })
    ))
  }, [authorizations, flexcons, paperBags])
  const inspectionProgressTotals = useMemo(() => inspectionProgressRows.reduce((totals, row) => ({
    inspected: totals.inspected + row.inspectedQuantity,
    uninspected: totals.uninspected + row.uninspectedQuantity,
  }), { inspected: 0, uninspected: 0 }), [inspectionProgressRows])
  const inspectionDetailRows = useMemo(() => {
    const authorizationById = new Map(authorizations.map((authorization) => [authorization.id, authorization]))
    const commonDetail = (item: FlexconInspection | PaperBagInspection) => {
      const authorization = authorizationById.get(item.authorization_id)
      return {
        id: item.id,
        registrationId: item.registration_id,
        authorizationId: item.authorization_id,
        fiscalYear: item.fiscal_year,
        origin: formatPrefectureName(authorization?.prefecture) || '産地未登録',
        brand: item.brand?.trim() || '銘柄未登録',
        authorizationNo: authorization?.authorization_no ?? '',
        fullName: authorization?.full_name ?? '氏名未登録',
        purchaseDate: item.purchase_date,
        inspectionDate: item.inspection_date,
        moisture: item.moisture,
        grade: item.grade,
        missingFields: incompleteInspectionFields(item),
        complete: isInspectionResultComplete(item),
      }
    }
    const rows: InspectionDetailRow[] = [
      ...flexcons.map((item) => ({
        ...commonDetail(item),
        kind: 'flexcon' as const,
        recordNo: item.flexcon_no,
        quantityKg: item.quantity_kg,
        quantityLabel: `${item.quantity_kg.toLocaleString()}kg`,
      })),
      ...paperBags.map((item) => ({
        ...commonDetail(item),
        kind: 'paper' as const,
        recordNo: null,
        quantityKg: item.bag_count * 30,
        quantityLabel: `${item.bag_count.toLocaleString()}袋 / ${(item.bag_count * 30).toLocaleString()}kg`,
      })),
    ]
    return rows.sort((left, right) => (
      right.fiscalYear - left.fiscalYear
      || left.origin.localeCompare(right.origin, 'ja', { numeric: true })
      || left.brand.localeCompare(right.brand, 'ja', { numeric: true })
      || AUTHORIZATION_NO_COLLATOR.compare(left.authorizationNo, right.authorizationNo)
      || left.kind.localeCompare(right.kind)
      || (left.recordNo ?? 0) - (right.recordNo ?? 0)
      || left.purchaseDate.localeCompare(right.purchaseDate)
    ))
  }, [authorizations, flexcons, paperBags])
  const inspectedDetailRows = inspectionDetailRows.filter((row) => row.complete)
  const uninspectedDetailRows = inspectionDetailRows.filter((row) => !row.complete)

  const locationOptions = inspectionOptions.filter((item) => item.option_type === 'location')
  const inspectorOptions = inspectionOptions.filter((item) => item.option_type === 'inspector')
  const gradeOptions = inspectionOptions.filter((item) => item.option_type === 'grade')
  const reasonOptions = inspectionOptions.filter((item) => item.option_type === 'grade_reason')
  const selectedBrandType = brandTypeForPrefecture(selectedAuthorization?.prefecture ?? null)
  const brandOptions = inspectionOptions.filter((item) => item.option_type === selectedBrandType || item.option_type === 'brand')
  const addBrandType = brandTypeForPrefecture(addAuthorization?.prefecture ?? null)
  const addBrandOptions = inspectionOptions.filter((item) => item.option_type === addBrandType || item.option_type === 'brand')

  const addInspectionGroup = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!addAuthorization || busy) return setNotice({ type: 'error', text: '委任状一覧に登録されている生産者名を選択してください。' })
    const flexconCount = Number(addGroupForm.flexcon_count || 0)
    const paperBagCount = Number(addGroupForm.paper_bag_count || 0)
    const bulkQuantityKg = Number(addGroupForm.bulk_quantity_kg || 0)
    if (!addGroupForm.purchase_date) return setNotice({ type: 'error', text: '仕入日を入力してください。' })
    if (!addGroupForm.brand) return setNotice({ type: 'error', text: '銘柄を選択してください。' })
    if (!Number.isInteger(bulkQuantityKg) || bulkQuantityKg < 0) return setNotice({ type: 'error', text: 'バラは0kg以上の整数で入力してください。' })
    if (flexconCount <= 0 && paperBagCount <= 0 && bulkQuantityKg <= 0) return setNotice({ type: 'error', text: 'フレコン本数、紙袋数、バラのいずれかを入力してください。' })
    const flexconQuantity = addGroupForm.brand === '飼料用玄米' ? weights.feed_rice : weights.branded_rice
    setBusy(true); setNotice(null)
    const { data, error } = await supabase.rpc('flexcon_add_inspection_group', {
      p_worker_id: workerId,
      p_authorization_id: addAuthorization.id,
      p_fiscal_year: Number(addGroupForm.fiscal_year),
      p_purchase_date: addGroupForm.purchase_date,
      p_inspection_date: addGroupForm.inspection_date || null,
      p_inspection_location: addGroupForm.inspection_location.trim() || null,
      p_brand: addGroupForm.brand,
      p_flexcon_count: flexconCount,
      p_paper_bag_count: paperBagCount,
      p_flexcon_quantity_kg: flexconQuantity,
      p_bulk_quantity_kg: bulkQuantityKg,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setAddGroupForm(emptyAddGroupForm())
    setAddGroupFormOpen(false)
    setProducerPickerOpen(false)
    const registrationNo = Number((data as { registration_no?: unknown } | null)?.registration_no)
    let registrationId: string | null = null
    if (Number.isFinite(registrationNo)) {
      const { data: registrationData } = await supabase
        .from('flexcon_inspection_registrations')
        .select('id')
        .eq('registration_no', registrationNo)
        .maybeSingle()
      registrationId = registrationData?.id ?? null
    }
    if (!registrationId) {
      setNotice({ type: 'error', text: '登録は完了しましたが、編集する登録行を取得できませんでした。一覧を更新して対象行を選択してください。' })
      setVersion((value) => value + 1)
      return
    }
    onSelectedRecordTargetChange(null)
    onSelectedRegistrationChange(registrationId)
    onSelectedAuthorizationChange(addAuthorization.id)
  }

  const detailDraft = (item: FlexconInspection | PaperBagInspection): InlineDetailDraft => detailDrafts[item.id] ?? {
    fiscal_year: String(item.fiscal_year),
    purchase_date: item.purchase_date,
    inspection_date: item.inspection_date ?? '',
    inspector_name: item.inspector_name ?? '',
    inspection_location: item.inspection_location ?? '',
    brand: item.brand ?? '',
    quantity: String('quantity_kg' in item ? item.quantity_kg : item.bag_count),
    grade: item.grade ?? '',
    reason: item.reason ?? '',
    moisture: item.moisture === null ? '' : String(item.moisture),
  }
  const changeDetailDraft = (item: FlexconInspection | PaperBagInspection, values: Partial<InlineDetailDraft>) => {
    setDetailDrafts((current) => {
      const previous = current[item.id] ?? detailDraft(item)
      return { ...current, [item.id]: { ...previous, ...values } }
    })
  }
  const saveInlineDetail = async (
    detailKind: 'flexcon' | 'paper',
    item: FlexconInspection | PaperBagInspection,
    values: Partial<InlineDetailDraft> = {},
  ) => {
    if (!selectedAuthorization || busy) return
    const draft = { ...detailDraft(item), ...values }
    if (!isGradeAllowedForBrand(draft.brand, draft.grade)) {
      draft.grade = ''
      draft.reason = ''
    }
    if (draft.grade === '1等' || draft.grade === '合格') draft.reason = ''
    const fiscalYear = Number(draft.fiscal_year)
    const quantity = Number(draft.quantity)
    const moisture = draft.moisture.trim() === '' ? null : Number(draft.moisture)
    if (!Number.isInteger(fiscalYear) || fiscalYear < 1 || fiscalYear > 99) return setNotice({ type: 'error', text: '年度は1から99の整数で入力してください。' })
    if (!draft.purchase_date) return setNotice({ type: 'error', text: '仕入日を入力してください。' })
    if (!draft.brand) return setNotice({ type: 'error', text: '銘柄を選択してください。' })
    if (!Number.isInteger(quantity) || quantity <= 0) return setNotice({ type: 'error', text: detailKind === 'flexcon' ? '数量は1kg以上の整数で入力してください。' : '紙袋数は1以上の整数で入力してください。' })
    if (moisture !== null && (!Number.isFinite(moisture) || moisture < 0 || moisture > 100)) return setNotice({ type: 'error', text: '水分は0から100の範囲で入力してください。' })
    changeDetailDraft(item, draft)
    const common = {
      p_worker_id: workerId,
      p_authorization_id: selectedAuthorization.id,
      p_fiscal_year: fiscalYear,
      p_purchase_date: draft.purchase_date,
      p_inspection_date: draft.inspection_date || null,
      p_inspector_name: draft.inspector_name.trim() || null,
      p_inspection_location: draft.inspection_location.trim() || null,
      p_brand: draft.brand,
      p_grade: draft.grade.trim() || null,
      p_reason: draft.reason.trim() || null,
      p_moisture: moisture,
    }
    const runSave = async () => {
      const { error } = detailKind === 'flexcon'
        ? await supabase.rpc('flexcon_save_inspection_flexcon', { ...common, p_flexcon_id: item.id, p_flexcon_no: (item as FlexconInspection).flexcon_no, p_quantity_kg: quantity })
        : await supabase.rpc('flexcon_save_inspection_paper_bags', { ...common, p_paper_bag_id: item.id, p_bag_count: quantity })
      if (error) {
        setNotice({ type: 'error', text: error.message })
        return
      }
      const savedValues = {
        fiscal_year: fiscalYear,
        purchase_date: draft.purchase_date,
        inspection_date: draft.inspection_date || null,
        inspector_name: draft.inspector_name.trim() || null,
        inspection_location: draft.inspection_location.trim() || null,
        brand: draft.brand,
        grade: draft.grade.trim() || null,
        reason: draft.reason.trim() || null,
        moisture: moisture === null ? null : Math.round(moisture * 10) / 10,
        moisture_values: moisture === null ? [] : [moisture],
        updated_by_worker_id: workerId,
        updated_at: new Date().toISOString(),
      }
      if (detailKind === 'flexcon') {
        setFlexcons((current) => current.map((record) => record.id === item.id ? { ...record, ...savedValues, quantity_kg: quantity } : record))
      } else {
        setPaperBags((current) => current.map((record) => record.id === item.id ? { ...record, ...savedValues, bag_count: quantity } : record))
      }
      setDetailDrafts((current) => {
        if (current[item.id] && JSON.stringify(current[item.id]) !== JSON.stringify(draft)) return current
        const next = { ...current }
        delete next[item.id]
        return next
      })
      setNotice({ type: 'success', text: detailKind === 'flexcon' ? 'フレコン検査記録を保存しました。' : '紙袋検査記録を保存しました。' })
    }
    const previousSave = detailSaveChains.current.get(item.id) ?? Promise.resolve()
    const saveTask = previousSave.catch(() => undefined).then(runSave)
    detailSaveChains.current.set(item.id, saveTask)
    await saveTask
    if (detailSaveChains.current.get(item.id) === saveTask) detailSaveChains.current.delete(item.id)
  }

  const renderInlineMetadataFields = (detailKind: 'flexcon' | 'paper', item: FlexconInspection | PaperBagInspection) => {
    const draft = detailDraft(item)
    const save = (values: Partial<InlineDetailDraft> = {}) => void saveInlineDetail(detailKind, item, values)
    return <>
      <td className="inspection-inline-cell inspection-year-cell"><input className={!draft.fiscal_year || Number(draft.fiscal_year) <= 0 ? 'inspection-missing' : ''} type="number" min="1" max="99" value={draft.fiscal_year} aria-label="年度" disabled={busy} onChange={(event) => changeDetailDraft(item, { fiscal_year: event.target.value })} onBlur={() => save()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></td>
      <td className="inspection-inline-cell inspection-date-cell"><input className={!draft.purchase_date ? 'inspection-missing' : ''} type="date" value={draft.purchase_date} aria-label="仕入日" disabled={busy} onChange={(event) => { const purchase_date = event.target.value; changeDetailDraft(item, { purchase_date }); save({ purchase_date }) }} /></td>
      <td className="inspection-inline-cell inspection-date-cell"><input className={!draft.inspection_date ? 'inspection-missing' : ''} type="date" value={draft.inspection_date} aria-label="検査日" disabled={busy} onChange={(event) => { const inspection_date = event.target.value; changeDetailDraft(item, { inspection_date }); save({ inspection_date }) }} /></td>
      <td className="inspection-inline-cell inspection-inspector-cell"><select className={!draft.inspector_name ? 'inspection-missing' : ''} value={draft.inspector_name} aria-label="検査員" disabled={busy} onChange={(event) => { const inspector_name = event.target.value; changeDetailDraft(item, { inspector_name }); save({ inspector_name }) }}><option value="">未選択</option>{inspectorOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
      <td className="inspection-inline-cell inspection-location-cell"><select className={!draft.inspection_location ? 'inspection-missing' : ''} value={draft.inspection_location} aria-label="検査場所" disabled={busy} onChange={(event) => { const inspection_location = event.target.value; changeDetailDraft(item, { inspection_location }); save({ inspection_location }) }}><option value="">未選択</option>{locationOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
      <td className={`inspection-prefecture-cell ${selectedAuthorization?.prefecture ? '' : 'inspection-missing'}`}>{selectedAuthorization?.prefecture ?? ''}</td>
    </>
  }
  const renderInlineResultFields = (detailKind: 'flexcon' | 'paper', item: FlexconInspection | PaperBagInspection) => {
    const draft = detailDraft(item)
    const reasonForbidden = draft.grade === '1等' || draft.grade === '合格'
    const availableGradeOptions = gradeOptions.filter((option) => (
      isFeedRiceBrand(draft.brand) ? option.name === '合格' : option.name !== '合格'
    ))
    const save = (values: Partial<InlineDetailDraft> = {}) => void saveInlineDetail(detailKind, item, values)
    return <>
      <td className="inspection-inline-cell"><input className={[draft.moisture === '' ? 'inspection-missing' : '', isHighMoisture(draft.moisture) ? 'moisture-high' : ''].filter(Boolean).join(' ')} type="number" min="0" max="100" step="0.1" value={draft.moisture} aria-label="水分" disabled={busy} onChange={(event) => changeDetailDraft(item, { moisture: event.target.value })} onBlur={() => save()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></td>
      <td className="inspection-inline-cell"><select className={!draft.grade ? 'inspection-missing' : ''} value={draft.grade} aria-label="等級" disabled={busy} onChange={(event) => { const grade = event.target.value; const reason = grade === '1等' || grade === '合格' ? '' : draft.reason; changeDetailDraft(item, { grade, reason }); save({ grade, reason }) }}><option value="">未選択</option>{availableGradeOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
      <td className="inspection-inline-cell inspection-inline-reason-cell"><select className={!reasonForbidden && Boolean(draft.grade) && !draft.reason ? 'inspection-missing' : ''} value={reasonForbidden ? '' : draft.reason} aria-label="理由" disabled={busy || reasonForbidden} title={reasonForbidden ? '1等と合格には理由を入力できません' : undefined} onChange={(event) => { const reason = event.target.value; changeDetailDraft(item, { reason }); save({ reason }) }}><option value="">未選択</option>{reasonOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
    </>
  }
  const renderInlineProductFields = (detailKind: 'flexcon' | 'paper', item: FlexconInspection | PaperBagInspection) => {
    const draft = detailDraft(item)
    const save = (values: Partial<InlineDetailDraft> = {}) => void saveInlineDetail(detailKind, item, values)
    return <>
      <td className="inspection-inline-cell inspection-brand-cell"><select className={!draft.brand ? 'inspection-missing' : ''} value={draft.brand} aria-label="銘柄" disabled={busy} onChange={(event) => { const brand = event.target.value; const grade = isGradeAllowedForBrand(brand, draft.grade) ? draft.grade : ''; const reason = grade ? draft.reason : ''; changeDetailDraft(item, { brand, grade, reason }); save({ brand, grade, reason }) }}><option value="">未選択</option>{brandOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
      <td className="inspection-inline-cell inspection-quantity-cell"><input className={!draft.quantity || Number(draft.quantity) <= 0 ? 'inspection-missing' : ''} type="number" min="1" step="1" value={draft.quantity} aria-label={detailKind === 'flexcon' ? '数量（kg）' : '数量（袋）'} disabled={busy} onChange={(event) => changeDetailDraft(item, { quantity: event.target.value })} onBlur={() => save()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></td>
    </>
  }
  const renderReadOnlyMetadataFields = (item: FlexconInspection | PaperBagInspection) => <>
    <td>{item.fiscal_year}</td>
    <td>{displayDate(item.purchase_date)}</td>
    <td className={item.inspection_date ? undefined : 'inspection-missing'}>{displayDate(item.inspection_date)}</td>
    <td className={item.inspector_name ? undefined : 'inspection-missing'}>{item.inspector_name ?? ''}</td>
    <td className={item.inspection_location ? undefined : 'inspection-missing'}>{item.inspection_location ?? ''}</td>
    <td className={selectedAuthorization?.prefecture ? undefined : 'inspection-missing'}>{formatPrefectureName(selectedAuthorization?.prefecture) || ''}</td>
  </>
  const renderReadOnlyProductFields = (item: FlexconInspection | PaperBagInspection) => <>
    <td className={item.brand ? undefined : 'inspection-missing'}>{item.brand ?? ''}</td>
    <td>{'quantity_kg' in item ? `${item.quantity_kg.toLocaleString()}kg` : `${item.bag_count.toLocaleString()}袋`}</td>
  </>
  const renderReadOnlyResultFields = (item: FlexconInspection | PaperBagInspection) => <>
    <td className={[item.moisture === null ? 'inspection-missing' : '', isHighMoisture(item.moisture) ? 'moisture-high' : ''].filter(Boolean).join(' ') || undefined}>{item.moisture === null ? '' : `${item.moisture.toFixed(1)}%`}</td>
    <td className={item.grade ? undefined : 'inspection-missing'}>{item.grade ?? ''}</td>
    <td className={item.grade && item.grade !== '1等' && item.grade !== '合格' && !item.reason ? 'inspection-missing' : undefined}>{item.reason ?? ''}</td>
  </>

  const deleteFlexcon = async (item: FlexconInspection) => {
    if (!window.confirm(`№${item.flexcon_no}を削除しますか？`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_inspection_flexcon', { p_worker_id: workerId, p_flexcon_id: item.id })
    setBusy(false)
    if (error) {
      const isRetiredMixedReference = error.code === '23503' && error.message.includes('source_flexcon_id')
      return setNotice({ type: 'error', text: isRetiredMixedReference ? '過去の混在フレコン参照が残っています。混在参照解除SQLを実行してください。' : error.message })
    }
    setNotice({ type: 'success', text: 'フレコン検査記録を削除しました。' }); setVersion((value) => value + 1)
  }
  const deletePaperBags = async (item: PaperBagInspection) => {
    if (!window.confirm(`${item.brand ?? ''} ${item.bag_count}袋を削除しますか？`)) return
    setBusy(true)
    const { error } = await supabase.rpc('flexcon_delete_inspection_paper_bags', { p_worker_id: workerId, p_paper_bag_id: item.id })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setNotice({ type: 'success', text: '紙袋検査記録を削除しました。' }); setVersion((value) => value + 1)
  }
  const beginSplitPaperBags = (item: PaperBagInspection) => {
    const first = Math.floor(item.bag_count / 2)
    setSplitPaper(item)
    setSplitCounts({ first: String(first), second: String(item.bag_count - first) })
    setNotice(null)
  }
  const splitPaperBags = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!splitPaper || busy) return
    const first = Number(splitCounts.first)
    const second = Number(splitCounts.second)
    if (!Number.isInteger(first) || !Number.isInteger(second) || first <= 0 || second <= 0) return setNotice({ type: 'error', text: '分割後の袋数はどちらも1以上の整数で入力してください。' })
    if (first + second !== splitPaper.bag_count) return setNotice({ type: 'error', text: `分割後の合計を元の${splitPaper.bag_count}袋に合わせてください。` })
    setBusy(true); setNotice(null)
    const { error } = await supabase.rpc('flexcon_split_inspection_paper_bags', {
      p_worker_id: workerId,
      p_paper_bag_id: splitPaper.id,
      p_first_bag_count: first,
      p_second_bag_count: second,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setSplitPaper(null)
    setNotice({ type: 'success', text: `紙袋${first + second}袋を${first}袋と${second}袋に分割しました。` })
    setVersion((value) => value + 1)
  }
  const openCertificateDialog = (kind: CertificateKind) => {
    const candidates = certificateFlexconsFor(kind)
    if (candidates.length === 0) return
    if (generatedCertificate) URL.revokeObjectURL(generatedCertificate.url)
    setGeneratedCertificate(null)
    setCertificateError('')
    setCertificateKind(kind)
    setCertificateRange({
      start: String(candidates[0].flexcon_no),
      end: String(candidates[candidates.length - 1].flexcon_no),
    })
    setCertificateDialogOpen(true)
  }
  const closeCertificateDialog = () => {
    if (certificateBusy) return
    if (generatedCertificate) URL.revokeObjectURL(generatedCertificate.url)
    setGeneratedCertificate(null)
    setCertificateError('')
    setCertificateDialogOpen(false)
  }
  const certificateTargets = () => {
    const start = Number(certificateRange.start)
    const end = Number(certificateRange.end)
    if (!Number.isInteger(start) || !Number.isInteger(end)) return []
    return certificateFlexconsFor(certificateKind).filter((item) => item.flexcon_no >= start && item.flexcon_no <= end)
  }
  const createCertificatePdf = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedAuthorization || certificateBusy) return
    const start = Number(certificateRange.start)
    const end = Number(certificateRange.end)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0) {
      setCertificateError('開始№と終了№は1以上の整数で入力してください。')
      return
    }
    if (start > end) {
      setCertificateError('開始№は終了№以下にしてください。')
      return
    }
    const targets = certificateTargets()
    if (targets.length === 0) {
      setCertificateError('指定範囲に印刷できるフレコンがありません。')
      return
    }

    const pdfWindow = window.open('', '_blank')
    if (pdfWindow) {
      pdfWindow.document.title = '検査証明書を作成中'
      pdfWindow.document.body.textContent = '検査証明書PDFを作成しています...'
    }
    setCertificateBusy(true)
    setCertificateError('')
    try {
      const { generateInspectionCertificatePdf } = await import('../lib/certificatePdf')
      const blob = await generateInspectionCertificatePdf({
        authorization: {
          authorizationNo: selectedAuthorization.authorization_no,
          fullName: selectedAuthorization.full_name,
          address: selectedAuthorization.address ?? '',
          prefecture: selectedAuthorization.prefecture ?? '',
          feedRiceVariety: selectedAuthorization.feed_rice_variety ?? '',
        },
        flexcons: targets.map((item) => ({
          flexconNo: item.flexcon_no,
          lotNumber: item.lot_number || `${westernYear(item.fiscal_year)}${selectedAuthorization.authorization_no.padStart(4, '0')}${String(item.flexcon_no).padStart(3, '0')}`,
          fiscalYear: item.fiscal_year,
          inspectionDate: item.inspection_date,
          inspectorName: item.inspector_name ?? '',
          brand: item.brand ?? '',
          quantityKg: item.quantity_kg,
          grade: item.grade ?? '',
          reason: item.reason ?? '',
        })),
      })
      if (generatedCertificate) URL.revokeObjectURL(generatedCertificate.url)
      const url = URL.createObjectURL(blob)
      const fileName = `検査証明書_${certificateKind === 'bulk' ? 'バラ_' : ''}${selectedAuthorization.authorization_no}_${start}-${end}.pdf`
      setGeneratedCertificate({
        url,
        fileName,
        flexconIds: targets.map((item) => item.id),
        count: targets.length,
        previouslyPrintedCount: targets.filter((item) => (item.certificate_print_count ?? 0) > 0).length,
      })
      if (pdfWindow) {
        pdfWindow.location.href = url
      } else {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = fileName
        anchor.click()
      }
    } catch (error) {
      if (pdfWindow) pdfWindow.close()
      setCertificateError(error instanceof Error ? error.message : '検査証明書PDFを作成できませんでした。')
    } finally {
      setCertificateBusy(false)
    }
  }
  const reopenCertificatePdf = () => {
    if (!generatedCertificate) return
    window.open(generatedCertificate.url, '_blank')
  }
  const markCertificatePrinted = async () => {
    if (!generatedCertificate || certificateBusy) return
    setCertificateBusy(true)
    setCertificateError('')
    const { error } = await supabase.rpc('flexcon_mark_certificates_printed', {
      p_worker_id: workerId,
      p_flexcon_ids: generatedCertificate.flexconIds,
    })
    setCertificateBusy(false)
    if (error) {
      setCertificateError(error.message)
      return
    }
    const printedAt = new Date().toISOString()
    const printedIds = new Set(generatedCertificate.flexconIds)
    setFlexcons((current) => current.map((item) => printedIds.has(item.id) ? {
      ...item,
      certificate_print_count: (item.certificate_print_count ?? 0) + 1,
      certificate_last_printed_at: printedAt,
      certificate_last_printed_by_worker_id: workerId,
    } : item))
    closeCertificateDialog()
  }

  const createInspectionLedgerPdf = async () => {
    if (!selectedAuthorization || inspectionLedgerBusy) return
    setInspectionLedgerFailure(null)
    const targetFlexcons = selectedFlexcons.filter(isInspectionResultComplete)
    const targetPaperBags = selectedPaperBags.filter(isInspectionResultComplete)
    if (targetFlexcons.length === 0 && targetPaperBags.length === 0) {
      setInspectionLedgerFailure(inspectionLedgerFailureFor([...selectedFlexcons, ...selectedPaperBags]))
      return
    }

    const pdfWindow = window.open('', '_blank')
    if (pdfWindow) {
      pdfWindow.document.title = '検査請求者別検査台帳を作成中'
      pdfWindow.document.body.textContent = '検査請求者別検査台帳PDFを作成しています...'
    }
    setInspectionLedgerBusy(true)
    setNotice(null)
    try {
      const { generateInspectionLedgerPdf } = await import('../lib/inspectionLedgerPdf')
      const commonRecord = (item: FlexconInspection | PaperBagInspection) => ({
        fiscalYear: item.fiscal_year,
        purchaseDate: item.purchase_date,
        inspectionDate: item.inspection_date ?? '',
        inspectorName: item.inspector_name ?? '',
        inspectionLocation: item.inspection_location ?? '',
        origin: selectedAuthorization.prefecture ?? '',
        brand: item.brand ?? '',
        grade: item.grade ?? '',
        reason: item.reason ?? '',
        moisture: item.moisture,
      })
      const records = [
        ...targetFlexcons.map((item) => {
          const standardWeightKg = isFeedRiceBrand(item.brand ?? '') ? weights.feed_rice : weights.branded_rice
          const isBulk = flexconRecordKind(item, weights) === 'bulk'
          return {
            ...commonRecord(item),
            kind: 'flexcon' as const,
            quantityCount: 1,
            quantityKg: isBulk ? item.quantity_kg : standardWeightKg,
            weightKg: standardWeightKg,
          }
        }),
        ...targetPaperBags.map((item) => ({
          ...commonRecord(item),
          kind: 'paper_bag' as const,
          quantityCount: item.bag_count,
          quantityKg: item.bag_count * 30,
          weightKg: 30,
        })),
      ]
      const { blob, pageCount } = await generateInspectionLedgerPdf({
        authorization: {
          authorizationNo: selectedAuthorization.authorization_no,
          fullName: selectedAuthorization.full_name,
          address: selectedAuthorization.address ?? '',
          feedRiceVariety: selectedAuthorization.feed_rice_variety ?? '',
        },
        records,
      })
      const url = URL.createObjectURL(blob)
      if (pdfWindow) {
        pdfWindow.location.href = url
      } else {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `検査請求者別検査台帳_${selectedAuthorization.authorization_no}_${today().replaceAll('-', '')}.pdf`
        anchor.click()
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 300_000)
      setNotice({ type: 'success', text: `${pageCount}ページの検査請求者別検査台帳PDFを作成しました。PDF画面で印刷するページを指定できます。` })
    } catch (error) {
      if (pdfWindow) pdfWindow.close()
      setInspectionLedgerFailure({
        summary: '検査請求者別検査台帳を作成できませんでした。',
        reasons: [error instanceof Error ? error.message : 'PDFの作成中に不明なエラーが発生しました。'],
      })
    } finally {
      setInspectionLedgerBusy(false)
    }
  }

  const createGradingNoticePdf = async () => {
    if (!selectedAuthorization || gradingNoticeBusy) return
    setGradingNoticeFailure(null)
    const authorizationById = new Map(authorizations.map((authorization) => [authorization.id, authorization]))
    const producerFlexcons = flexcons.filter((item) => item.authorization_id === selectedAuthorization.id)
    const producerPaperBags = paperBags.filter((item) => item.authorization_id === selectedAuthorization.id)
    const targetFlexcons = producerFlexcons.filter(isInspectionResultComplete)
    const targetPaperBags = producerPaperBags.filter(isInspectionResultComplete)
    if (targetFlexcons.length === 0 && targetPaperBags.length === 0) {
      setGradingNoticeFailure(gradingNoticeFailureFor([...producerFlexcons, ...producerPaperBags]))
      return
    }

    const pdfWindow = window.open('', '_blank')
    if (pdfWindow) {
      pdfWindow.document.title = '格付結果通知票を作成中'
      pdfWindow.document.body.textContent = '格付結果通知票PDFを作成しています...'
    }
    setGradingNoticeBusy(true)
    setNotice(null)
    try {
      const { generateGradingNoticePdf } = await import('../lib/gradingNoticePdf')
      const records = [...targetFlexcons.map((item) => {
        const authorization = authorizationById.get(item.authorization_id)
        return authorization ? {
          authorizationNo: authorization.authorization_no,
          fullName: authorization.full_name,
          prefecture: authorization.prefecture ?? '',
          municipality: authorization.municipality ?? '',
          feedRiceVariety: authorization.feed_rice_variety ?? '',
          inspectionDate: item.inspection_date ?? '',
          inspectionLocation: item.inspection_location ?? '',
          fiscalYear: item.fiscal_year,
          brand: item.brand ?? '',
          grade: item.grade ?? '',
          reason: item.reason ?? '',
          kind: 'flexcon' as const,
          quantity: item.quantity_kg,
          moisture: item.moisture,
        } : null
      }), ...targetPaperBags.map((item) => {
        const authorization = authorizationById.get(item.authorization_id)
        return authorization ? {
          authorizationNo: authorization.authorization_no,
          fullName: authorization.full_name,
          prefecture: authorization.prefecture ?? '',
          municipality: authorization.municipality ?? '',
          feedRiceVariety: authorization.feed_rice_variety ?? '',
          inspectionDate: item.inspection_date ?? '',
          inspectionLocation: item.inspection_location ?? '',
          fiscalYear: item.fiscal_year,
          brand: item.brand ?? '',
          grade: item.grade ?? '',
          reason: item.reason ?? '',
          kind: 'paper_bag' as const,
          quantity: item.bag_count,
          moisture: item.moisture,
        } : null
      })].filter((record) => record !== null)
      const { blob, pageCount } = await generateGradingNoticePdf(records)
      const url = URL.createObjectURL(blob)
      if (pdfWindow) {
        pdfWindow.location.href = url
      } else {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `格付結果通知票_${selectedAuthorization.authorization_no}_${today().replaceAll('-', '')}.pdf`
        anchor.click()
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 300_000)
      setNotice({ type: 'success', text: `${pageCount}ページの格付結果通知票PDFを作成しました。PDF画面で印刷するページを指定できます。` })
    } catch (error) {
      if (pdfWindow) pdfWindow.close()
      setGradingNoticeFailure({
        summary: '格付結果通知票を作成できませんでした。',
        reasons: [error instanceof Error ? error.message : 'PDFの作成中に不明なエラーが発生しました。'],
      })
    } finally {
      setGradingNoticeBusy(false)
    }
  }

  const openInspectionDetail = (row: InspectionDetailRow) => {
    onSelectedRecordTargetChange({ kind: row.kind, id: row.id })
    onSelectedRegistrationChange(row.registrationId)
    onSelectedAuthorizationChange(row.authorizationId)
  }
  const renderInspectionDetailList = (title: string, rows: InspectionDetailRow[], tone: 'inspected' | 'uninspected') => {
    const totalQuantity = rows.reduce((total, row) => total + row.quantityKg, 0)
    return <details className={`inspection-record-detail-list ${tone}`}>
      <summary><span>{title}</span><span>{rows.length.toLocaleString()}件　{totalQuantity.toLocaleString()}kg <ChevronDown size={17} aria-hidden="true" /></span></summary>
      <div className="inspection-record-detail-table-wrap"><table className="inspection-record-detail-table">
        <thead><tr><th>産年</th><th>産地</th><th>銘柄</th><th>種別</th><th>№</th><th>数量</th><th>委任状№</th><th>氏名</th><th>仕入日</th><th>検査日</th><th>水分</th><th>等級</th><th>未記入</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={`${row.kind}-${row.id}`} tabIndex={0} onClick={() => openInspectionDetail(row)} onKeyDown={(event) => { if (event.key === 'Enter') openInspectionDetail(row) }}>
          <td>{displayCropYear(row.fiscalYear)}</td><td>{row.origin}</td><td>{row.brand}</td><td>{row.kind === 'flexcon' ? 'フレコン' : '紙袋'}</td><td>{row.recordNo ?? '-'}</td><td>{row.quantityLabel}</td><td>{row.authorizationNo}</td><td><strong>{row.fullName}</strong></td><td>{displayDate(row.purchaseDate)}</td><td>{displayDate(row.inspectionDate)}</td><td>{row.moisture === null ? '' : `${row.moisture.toFixed(1)}%`}</td><td>{row.grade ?? ''}</td><td>{row.missingFields.join('、')}</td>
        </tr>)}
        {rows.length === 0 && <tr><td colSpan={13} className="empty-state">該当する検査記録はありません</td></tr>}</tbody>
      </table></div>
    </details>
  }
  const renderFlexconSection = (title: string, items: FlexconInspection[], certificateSectionKind: CertificateKind) => <section className="section-band inspection-detail-section">
    <div className="section-title"><div><h2>{title}</h2><span>{items.length}本</span></div>{!readOnly && <div className="button-row"><span className="certificate-status-key"><span aria-hidden="true" />印刷済み</span><button className="secondary-button certificate-create-button" type="button" disabled={certificateFlexconsFor(certificateSectionKind).length === 0} onClick={() => openCertificateDialog(certificateSectionKind)}><FileText size={18} />検査証明書作成</button></div>}</div>
    <div className="inspection-detail-table-wrap"><table className="inspection-detail-table">
      <thead><tr><th>№</th><th>年度</th><th>仕入日</th><th>検査日</th><th>検査員</th><th>検査場所</th><th>産地</th><th>銘柄</th><th>数量（kg）</th><th>水分</th><th>等級</th><th>理由</th>{!readOnly && <th></th>}</tr></thead>
      <tbody>{items.map((item) => <tr id={`inspection-record-${item.id}`} className={[(item.certificate_print_count ?? 0) > 0 ? 'certificate-printed-row' : '', isInspectionResultComplete(item) ? 'inspection-complete-row' : '', selectedRecordTarget?.kind === 'flexcon' && selectedRecordTarget.id === item.id ? 'inspection-target-row' : ''].filter(Boolean).join(' ') || undefined} title={(item.certificate_print_count ?? 0) > 0 ? `印刷済み（${item.certificate_print_count}回）` : '未印刷'} key={item.id}><td>{item.flexcon_no}</td>{readOnly ? renderReadOnlyMetadataFields(item) : renderInlineMetadataFields('flexcon', item)}{readOnly ? renderReadOnlyProductFields(item) : renderInlineProductFields('flexcon', item)}{readOnly ? renderReadOnlyResultFields(item) : renderInlineResultFields('flexcon', item)}{!readOnly && <td className="inspection-row-actions"><button className="icon-button delete-icon" type="button" title="削除" aria-label={`№${item.flexcon_no}を削除`} onClick={() => void deleteFlexcon(item)}><Trash2 size={17} /></button></td>}</tr>)}
      {items.length === 0 && <tr><td colSpan={readOnly ? 12 : 13} className="empty-state">{title}は登録されていません</td></tr>}</tbody>
    </table></div>
  </section>

  if (!selectedAuthorization) {
    return <div className="inspection-page">
      <div className="page-heading inspection-heading"><div><h1>検査記録</h1><p>生産者詳細で追加した順番に検査記録を表示します。</p></div></div>
      <div className="inspection-record-tabs inspection-summary-tabs" role="tablist" aria-label="検査記録の表示">
        <button type="button" role="tab" aria-selected={summaryView === 'list'} className={summaryView === 'list' ? 'active' : ''} onClick={() => setSummaryView('list')}><List size={18} />一覧</button>
        <button type="button" role="tab" aria-selected={summaryView === 'aggregate'} className={summaryView === 'aggregate' ? 'active' : ''} onClick={() => { setProducerPickerOpen(false); setAddGroupFormOpen(false); setSummaryView('aggregate') }}><BarChart3 size={18} />集計</button>
      </div>
      {summaryView === 'list' && <>
      <div className="search-row"><div className="search-input-wrap"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="登録No.・氏名・産地・銘柄などで検索" /></div>{!readOnly && <button className={addGroupFormOpen ? 'secondary-button' : 'primary-button'} type="button" aria-expanded={addGroupFormOpen} onClick={() => { setProducerPickerOpen(false); setAddGroupFormOpen((current) => !current) }}>{addGroupFormOpen ? <><X size={18} />閉じる</> : <><Plus size={18} />追加</>}</button>}</div>
      {!readOnly && addGroupFormOpen && <form className="inspection-group-add inspection-summary-add section-band" onSubmit={(event) => void addInspectionGroup(event)}>
        <div className="inspection-producer-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setProducerPickerOpen(false) }}>
          <label>生産者名<input value={addGroupForm.producer_name} onFocus={() => setProducerPickerOpen(true)} onChange={(event) => { const producerName = event.target.value; const exactMatches = authorizations.filter((item) => item.full_name.trim() === producerName.trim()); setAddGroupForm((current) => ({ ...current, authorization_id: exactMatches.length === 1 ? exactMatches[0].id : '', producer_name: producerName, brand: '' })); setProducerPickerOpen(true) }} placeholder="氏名・委任状No.で絞り込み" autoComplete="off" role="combobox" aria-expanded={producerPickerOpen} aria-controls="inspection-producer-candidates" required /></label>
          {producerPickerOpen && <div id="inspection-producer-candidates" className="inspection-producer-candidates" role="listbox">
            {producerCandidates.map((item) => <button type="button" role="option" aria-selected={item.id === addGroupForm.authorization_id} key={item.id} onClick={() => { setAddGroupForm((current) => ({ ...current, authorization_id: item.id, producer_name: item.full_name, brand: '' })); setProducerPickerOpen(false) }}><span>No. {item.authorization_no}</span><strong>{item.full_name}<small>{[formatPrefectureName(item.prefecture), item.municipality].filter(Boolean).join(' ') || '産地未登録'}</small></strong></button>)}
            {producerCandidates.length === 0 && <span className="empty-state">該当する生産者がありません</span>}
          </div>}
        </div>
        <label>年度<input type="number" min="1" max="99" value={addGroupForm.fiscal_year} onChange={(event) => setAddGroupForm((current) => ({ ...current, fiscal_year: event.target.value }))} required /></label>
        <label>仕入日<input type="date" value={addGroupForm.purchase_date} onChange={(event) => setAddGroupForm((current) => ({ ...current, purchase_date: event.target.value }))} required /></label>
        <label>検査日<input type="date" value={addGroupForm.inspection_date} onChange={(event) => setAddGroupForm((current) => ({ ...current, inspection_date: event.target.value }))} /></label>
        <label>検査場所<select value={addGroupForm.inspection_location} onChange={(event) => setAddGroupForm((current) => ({ ...current, inspection_location: event.target.value }))}><option value="">未選択</option>{locationOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
        <label>産地<input value={formatPrefectureName(addAuthorization?.prefecture) || ''} readOnly aria-label="産地" /></label>
        <label>銘柄<select value={addGroupForm.brand} onChange={(event) => setAddGroupForm((current) => ({ ...current, brand: event.target.value }))} required disabled={!addAuthorization}><option value="">選択してください</option>{addBrandOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
        <label>推フレ数<input type="number" min="0" max="999" value={addGroupForm.flexcon_count} onChange={(event) => setAddGroupForm((current) => ({ ...current, flexcon_count: event.target.value }))} placeholder="0" /></label>
        <label>紙袋数<input type="number" min="0" value={addGroupForm.paper_bag_count} onChange={(event) => setAddGroupForm((current) => ({ ...current, paper_bag_count: event.target.value }))} placeholder="0" /></label>
        <label>バラ（kg）<input type="number" min="0" step="1" value={addGroupForm.bulk_quantity_kg} onChange={(event) => setAddGroupForm((current) => ({ ...current, bulk_quantity_kg: event.target.value }))} placeholder="0" /></label>
        <button className="primary-button" type="submit" disabled={busy}><Plus size={18} />{busy ? '追加中...' : '追加'}</button>
      </form>}
      </>}
      {summaryView === 'aggregate' && <section className="inspection-progress-section inspection-summary-aggregate section-band">
        <div className="section-title">
          <div><h2>検査数量</h2><span>産年・産地・銘柄別</span></div>
          <div className="inspection-progress-totals"><span>検査済み <strong>{inspectionProgressTotals.inspected.toLocaleString()}kg</strong></span><span>未検査 <strong>{inspectionProgressTotals.uninspected.toLocaleString()}kg</strong></span></div>
        </div>
        <div className="inspection-progress-table-wrap"><table className="inspection-progress-table">
          <thead><tr><th>産年</th><th>産地</th><th>銘柄</th><th>検査済み数量</th><th>未検査数量</th></tr></thead>
          <tbody>{inspectionProgressRows.map((row) => <tr key={`${row.fiscalYear}-${row.origin}-${row.brand}`}>
            <td>{displayCropYear(row.fiscalYear)}</td><td>{row.origin}</td><td>{row.brand}</td><td className="inspection-progress-inspected">{row.inspectedQuantity.toLocaleString()}kg</td><td className="inspection-progress-uninspected">{row.uninspectedQuantity.toLocaleString()}kg</td>
          </tr>)}
          {inspectionProgressRows.length === 0 && <tr><td colSpan={5} className="empty-state">検査記録は登録されていません</td></tr>}</tbody>
        </table></div>
        <div className="inspection-record-detail-lists">
          {renderInspectionDetailList('検査済み詳細一覧', inspectedDetailRows, 'inspected')}
          {renderInspectionDetailList('未検査詳細一覧', uninspectedDetailRows, 'uninspected')}
        </div>
      </section>}
      {summaryView === 'list' && <div className="inspection-summary-wrap"><table className="inspection-summary-table">
        <thead><tr>{SUMMARY_COLUMNS.map((column) => <InspectionSummaryColumnHeader key={column.key} column={column} sort={summarySort} values={summaryFilterValues[column.key]} selectedValues={summaryColumnFilters[column.key]} onSort={changeSummarySort} onFilterChange={changeSummaryColumnFilter} />)}{!readOnly && <th className="inspection-summary-actions-heading">操作</th>}</tr></thead>
        <tbody>{displayedSummary.map((row) => <tr key={row.registrationId} tabIndex={0} onClick={() => { onSelectedRecordTargetChange(null); onSelectedRegistrationChange(row.registrationId); onSelectedAuthorizationChange(row.authorizationId) }} onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) { onSelectedRecordTargetChange(null); onSelectedRegistrationChange(row.registrationId); onSelectedAuthorizationChange(row.authorizationId) } }}>
          <td className="numeric-cell">{row.registrationNo}</td><td>{row.purchaseDates}</td><td>{row.inspectionDates}</td><td><strong>{row.fullName}</strong></td><td>{row.origin}</td><td>{row.municipality}</td><td>{row.inspectionLocations}</td><td className="numeric-cell">{row.authorizationNo}</td><td>{row.brands}</td><td className="numeric-cell">{row.flexconCount}本</td><td className="numeric-cell">{row.paperBagCount}袋</td><td className="numeric-cell">{row.bulkQuantity.toLocaleString()}kg</td><td className="inspection-progress-inspected numeric-cell">{row.inspectedQuantity.toLocaleString()}kg</td><td className="inspection-progress-uninspected numeric-cell">{row.uninspectedQuantity.toLocaleString()}kg</td>
          {!readOnly && <td className="inspection-summary-actions"><button className="icon-button delete-icon" type="button" title="この登録行を削除" aria-label={`登録No. ${row.registrationNo}を削除`} disabled={busy} onClick={(event) => { event.stopPropagation(); void deleteInspectionRegistration(row) }}><Trash2 size={17} /></button></td>}
        </tr>)}
        {displayedSummary.length === 0 && <tr><td colSpan={readOnly ? 14 : 15} className="empty-state">該当する検査記録はありません</td></tr>}</tbody>
      </table></div>}
      {notice && <div className={`notice operation-log ${notice.type}`}>{notice.text}</div>}
    </div>
  }

  return <div className="producer-inspection-page">
    <div className="producer-inspection-heading">
      <button className="icon-button" type="button" title={readOnly ? '委任状一覧へ戻る' : '検査記録へ戻る'} aria-label={readOnly ? '委任状一覧へ戻る' : '検査記録へ戻る'} onClick={onBack}><ArrowLeft size={21} /></button>
      <div><h1>{selectedAuthorization.full_name}</h1><p>委任状№ {selectedAuthorization.authorization_no}　{[selectedAuthorization.prefecture, selectedAuthorization.municipality].filter(Boolean).join(' ')}{!readOnly && selectedRegistration ? `　登録No. ${selectedRegistration.registration_no}` : ''}</p></div>
      {readOnly && <div className="producer-inspection-actions">
        <button className="secondary-button" type="button" onClick={() => void createInspectionLedgerPdf()} disabled={inspectionLedgerBusy || gradingNoticeBusy}><ClipboardList size={18} />{inspectionLedgerBusy ? 'PDF作成中...' : '検査請求者別検査台帳'}</button>
        <button className="secondary-button" type="button" onClick={() => void createGradingNoticePdf()} disabled={gradingNoticeBusy || inspectionLedgerBusy}><FileText size={18} />{gradingNoticeBusy ? 'PDF作成中...' : '格付結果通知票'}</button>
      </div>}
    </div>
    {renderFlexconSection('推フレ', selectedStandardFlexcons, 'standard')}
    {renderFlexconSection('バラ', selectedBulkFlexcons, 'bulk')}
    <section className="section-band inspection-detail-section">
      <div className="section-title"><div><h2>紙袋</h2><span>{selectedPaperBags.length}件</span></div></div>
      <div className="inspection-detail-table-wrap"><table className="inspection-detail-table paper-detail-table">
        <thead><tr><th>年度</th><th>仕入日</th><th>検査日</th><th>検査員</th><th>検査場所</th><th>産地</th><th>銘柄</th><th>数量（袋）</th><th>総重量</th><th>水分</th><th>等級</th><th>理由</th>{!readOnly && <th></th>}</tr></thead>
        <tbody>{selectedPaperBags.map((item) => <tr id={`inspection-record-${item.id}`} className={[isInspectionResultComplete(item) ? 'inspection-complete-row' : '', selectedRecordTarget?.kind === 'paper' && selectedRecordTarget.id === item.id ? 'inspection-target-row' : ''].filter(Boolean).join(' ') || undefined} key={item.id}>{readOnly ? renderReadOnlyMetadataFields(item) : renderInlineMetadataFields('paper', item)}{readOnly ? renderReadOnlyProductFields(item) : renderInlineProductFields('paper', item)}<td>{(item.bag_count * 30).toLocaleString()}kg</td>{readOnly ? renderReadOnlyResultFields(item) : renderInlineResultFields('paper', item)}{!readOnly && <td className="inspection-row-actions inspection-row-actions-wide"><button className="icon-button" type="button" title="2行に分割" aria-label={`${item.brand ?? ''}の紙袋を2行に分割`} disabled={busy || item.bag_count < 2} onClick={() => beginSplitPaperBags(item)}><TableRowsSplit size={17} /></button><button className="icon-button delete-icon" type="button" title="削除" aria-label={`${item.brand ?? ''}の紙袋を削除`} onClick={() => void deletePaperBags(item)}><Trash2 size={17} /></button></td>}</tr>)}
        {selectedPaperBags.length === 0 && <tr><td colSpan={readOnly ? 12 : 13} className="empty-state">紙袋は登録されていません</td></tr>}</tbody>
      </table></div>
    </section>
    {!readOnly && certificateDialogOpen && <div className="modal-backdrop"><section className="registration-modal certificate-modal" role="dialog" aria-modal="true" aria-labelledby="certificate-dialog-title">
      <div className="modal-header"><div><h2 id="certificate-dialog-title">検査証明書作成</h2><p>{certificateKind === 'bulk' ? 'バラ' : '推フレ'}　{selectedAuthorization.full_name}　委任状№ {selectedAuthorization.authorization_no}</p></div><button className="icon-button" type="button" title="閉じる" aria-label="閉じる" onClick={closeCertificateDialog} disabled={certificateBusy}><X size={20} /></button></div>
      {!generatedCertificate ? <form className="certificate-range-form" onSubmit={(event) => void createCertificatePdf(event)}>
        <div className="certificate-range-fields">
          <label>開始№<input type="number" min="1" step="1" value={certificateRange.start} onChange={(event) => setCertificateRange((current) => ({ ...current, start: event.target.value }))} required autoFocus /></label>
          <span aria-hidden="true">から</span>
          <label>終了№<input type="number" min="1" step="1" value={certificateRange.end} onChange={(event) => setCertificateRange((current) => ({ ...current, end: event.target.value }))} required /></label>
        </div>
        <div className="certificate-range-summary">対象 {certificateTargets().length}本　印刷済み {certificateTargets().filter((item) => (item.certificate_print_count ?? 0) > 0).length}本{certificateKind === 'standard' && <><br />銘柄米は量目初期値 {weights.branded_rice.toLocaleString()}kg と一致するものだけが対象です。</>}</div>
        {certificateError && <div className="inline-error">{certificateError}</div>}
        <div className="modal-actions"><button className="primary-button" type="submit" disabled={certificateBusy}><FileText size={18} />{certificateBusy ? 'PDF作成中...' : 'PDFを作成'}</button><button className="secondary-button" type="button" onClick={closeCertificateDialog} disabled={certificateBusy}>取り消し</button></div>
      </form> : <div className="certificate-created-panel">
        <div className="certificate-created-message"><FileText size={28} /><div><strong>{generatedCertificate.count}ページのPDFを作成しました</strong><span>{generatedCertificate.previouslyPrintedCount > 0 ? `印刷済みのフレコンを${generatedCertificate.previouslyPrintedCount}本含みます。` : 'PDFの画面で印刷してください。'}</span></div></div>
        {certificateError && <div className="inline-error">{certificateError}</div>}
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={reopenCertificatePdf}><ExternalLink size={18} />PDFを開く</button><button className="primary-button" type="button" onClick={() => void markCertificatePrinted()} disabled={certificateBusy}><Printer size={18} />{certificateBusy ? '記録中...' : '印刷完了'}</button><button className="secondary-button" type="button" onClick={closeCertificateDialog} disabled={certificateBusy}>閉じる</button></div>
      </div>}
    </section></div>}
    {!readOnly && splitPaper && <div className="modal-backdrop"><section className="registration-modal paper-split-modal" role="dialog" aria-modal="true" aria-labelledby="paper-split-title">
      <div className="modal-header"><div><h2 id="paper-split-title">紙袋を2行に分割</h2><p>{splitPaper.brand}　元の数量 {splitPaper.bag_count}袋</p></div><button className="icon-button" type="button" title="閉じる" aria-label="閉じる" onClick={() => setSplitPaper(null)} disabled={busy}><X size={20} /></button></div>
      <form className="paper-split-form" onSubmit={(event) => void splitPaperBags(event)}>
        <label>1行目の数量（袋）<input type="number" min="1" step="1" value={splitCounts.first} onChange={(event) => setSplitCounts((current) => ({ ...current, first: event.target.value }))} required /></label>
        <label>2行目の数量（袋）<input type="number" min="1" step="1" value={splitCounts.second} onChange={(event) => setSplitCounts((current) => ({ ...current, second: event.target.value }))} required /></label>
        <div className="paper-split-total">合計 {(Number(splitCounts.first) || 0) + (Number(splitCounts.second) || 0)} / {splitPaper.bag_count}袋</div>
        <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy}><TableRowsSplit size={18} />{busy ? '分割中...' : '分割する'}</button><button className="secondary-button" type="button" onClick={() => setSplitPaper(null)} disabled={busy}>取り消し</button></div>
      </form>
    </section></div>}
    {gradingNoticeFailure && <div className="modal-backdrop"><section className="registration-modal grading-notice-failure-modal" role="alertdialog" aria-modal="true" aria-labelledby="grading-notice-failure-title" aria-describedby="grading-notice-failure-description">
      <div className="modal-header"><div><h2 id="grading-notice-failure-title"><CircleAlert size={22} />格付結果通知票を作成できません</h2></div><button className="icon-button" type="button" title="閉じる" aria-label="閉じる" onClick={() => setGradingNoticeFailure(null)}><X size={20} /></button></div>
      <p id="grading-notice-failure-description">{gradingNoticeFailure.summary}</p>
      <ul>{gradingNoticeFailure.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <div className="modal-actions"><button className="primary-button" type="button" autoFocus onClick={() => setGradingNoticeFailure(null)}>閉じる</button></div>
    </section></div>}
    {inspectionLedgerFailure && <div className="modal-backdrop"><section className="registration-modal grading-notice-failure-modal" role="alertdialog" aria-modal="true" aria-labelledby="inspection-ledger-failure-title" aria-describedby="inspection-ledger-failure-description">
      <div className="modal-header"><div><h2 id="inspection-ledger-failure-title"><CircleAlert size={22} />検査請求者別検査台帳を作成できません</h2></div><button className="icon-button" type="button" title="閉じる" aria-label="閉じる" onClick={() => setInspectionLedgerFailure(null)}><X size={20} /></button></div>
      <p id="inspection-ledger-failure-description">{inspectionLedgerFailure.summary}</p>
      <ul>{inspectionLedgerFailure.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <div className="modal-actions"><button className="primary-button" type="button" autoFocus onClick={() => setInspectionLedgerFailure(null)}>閉じる</button></div>
    </section></div>}
    {notice && <div className={`notice operation-log ${notice.type}`}>{notice.text}</div>}
  </div>
}
