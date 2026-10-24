import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, BarChart3, ChevronDown, CircleAlert, CircleCheck, ClipboardList, ExternalLink, FileText, FilterX, List, Plus, Printer, Save, TableRowsSplit, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { loadAllRows } from '../lib/loadAllRows'
import { useReportingPeriod } from '../lib/reportingPeriodContext'
import { inspectionReportingDate, matchesReportingPeriod } from '../lib/reportingPeriod'
import { formatDisplayDate, formatJapaneseDateForFilename, type CalendarMode } from '../lib/japaneseEra'
import { useCalendarMode } from '../lib/calendarMode'
import { matchesFilterText } from '../lib/tableFilters'
import { JapaneseDateInput, JapaneseFiscalYearInput } from './JapaneseDateInput'
import { InspectionNumberInput } from './InspectionNumberInput'
import { TableColumnFilter } from './TableColumnFilter'
import { ToggleSwitch } from './ToggleSwitch'
import { formatPrefectureName } from '../lib/prefecture'
import { selectedInspectionGrade } from '../lib/inspectionGrade'
import { findWarehouseForInspectionLocation } from '../lib/inspectionWarehouse'
import { navigateInspectionField } from '../lib/inspectionFieldNavigation'
import { groupInspectionSummaryRecords, inspectionSummaryKindLabel, type InspectionSummaryKind } from '../lib/inspectionSummaryGroups'
import { inspectionAggregateDisplayValue, inspectionAggregateGroupKey, matchesInspectionAggregateFilters, type InspectionAggregateColumn, type InspectionAggregateFilters, type InspectionAggregateRow as InspectionProgressRow } from '../lib/inspectionAggregateFilters'
import { certificateDefaultRange } from '../lib/certificateDefaultRange'
import { certificateQuantityConfirmation } from '../lib/certificateQuantityConfirmation'
import { matchesInspectionPeriod, type InspectionPeriod } from '../lib/inspectionPeriod'
import type { AuthorizationRecord, FlexconInspection, InspectionOption, InspectionRegistration, InspectionWeight, PaperBagInspection } from '../types'

type Props = {
  workerId: string
  isAdmin: boolean
  readOnly: boolean
  selectedAuthorizationId: string | null
  selectedRegistrationId: string | null
  selectedRecordTarget: InspectionRecordTarget | null
  summaryState: InspectionSummaryState
  onSummaryStateChange: Dispatch<SetStateAction<InspectionSummaryState>>
  summaryScrollRef: RefObject<InspectionSummaryScroll>
  onSelectedAuthorizationChange: (authorizationId: string | null) => void
  onSelectedRegistrationChange: (registrationId: string | null) => void
  onSelectedRecordTargetChange: (target: InspectionRecordTarget | null) => void
  onBack: () => void
}
export type InspectionRecordTarget = { kind: 'flexcon' | 'paper'; id: string; highlightIds?: string[] }
type Notice = { type: 'success' | 'error'; text: string } | null
type AddGroupForm = {
  authorization_id: string
  producer_name: string
  fiscal_year: string
  purchase_date: string
  settlement_no: string
  inspection_date: string
  inspection_location: string
  brand: string
  flexcon_count: string
  flexcon_quantity_kg: string | null
  paper_bag_count: string
  bulk_quantity_kg: string
}
type InlineDetailDraft = {
  settlement_no: string
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
type DetailAdditionKind = 'standard' | 'paper' | 'bulk'
type DetailAdditionDraft = { registrationId: string; kind: DetailAdditionKind; form: AddGroupForm }
type BatchInspectionMetadata = {
  registration_id: string | null
  target_kind: 'all' | 'standard' | 'paper'
  date_scope: string
  start_no: string
  end_no: string
  overwrite: boolean
  inspection_date: string
  inspector_name: string
  inspection_location: string
  grade: string
}
const EMPTY_BATCH_METADATA: Omit<BatchInspectionMetadata, 'registration_id'> = {
  target_kind: 'all', date_scope: 'all', start_no: '', end_no: '', overwrite: false,
  inspection_date: '', inspector_name: '', inspection_location: '', grade: '',
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
  inspectionLocation: string
  moisture: number | null
  grade: string | null
  missingFields: string[]
  complete: boolean
}
type InspectionRegistrationSummaryRow = {
  partialPeriodGroup: boolean
  groupKey: string
  recordKind: InspectionSummaryKind
  registrationId: string
  registrationNo: number
  settlementNo: string
  authorizationId: string
  purchaseDates: string
  inspectionDates: string
  inspectionDate: string | null
  flexconIds: string[]
  paperBagIds: string[]
  fullName: string
  origin: string
  municipality: string
  inspectionLocations: string
  authorizationNo: string
  brands: string
  grade: string
  flexconCount: number
  paperBagCount: number
  bulkQuantity: number
  inspectedQuantity: number
  uninspectedQuantity: number
  inspectionStatus: '完了' | '未完了'
}
type SummarySortDirection = 'asc' | 'desc'
type SummaryColumn = 'settlementNo' | 'purchaseDates' | 'inspectionDates' | 'fullName' | 'origin' | 'municipality' | 'inspectionLocations' | 'authorizationNo' | 'brands' | 'recordKind' | 'grade' | 'flexconCount' | 'paperBagCount' | 'bulkQuantity' | 'inspectedQuantity' | 'uninspectedQuantity' | 'inspectionStatus'
export type InspectionSummaryState = {
  view: 'list' | 'aggregate'
  sort: { key: SummaryColumn; direction: SummarySortDirection } | null
  columnFilters: Partial<Record<SummaryColumn, string[]>>
  textFilters: Partial<Record<SummaryColumn, string>>
  calendarMode: CalendarMode
  period: InspectionPeriod
  aggregateFilters: InspectionAggregateFilters
}
export type InspectionSummaryScroll = { top: number; left: number; pageTop: number; pageLeft: number; mainTop: number; mainLeft: number }

const SUMMARY_COLUMNS: Array<{ key: SummaryColumn; label: string }> = [
  { key: 'inspectionStatus', label: '検査状況' },
  { key: 'authorizationNo', label: '委任状' },
  { key: 'settlementNo', label: '仕切り書' },
  { key: 'purchaseDates', label: '仕入日' },
  { key: 'inspectionDates', label: '検査日' },
  { key: 'fullName', label: '氏名' },
  { key: 'origin', label: '産地' },
  { key: 'municipality', label: '市町村名' },
  { key: 'inspectionLocations', label: '検査場所' },
  { key: 'brands', label: '銘柄' },
  { key: 'recordKind', label: '種類' },
  { key: 'grade', label: '等級' },
  { key: 'flexconCount', label: '推フレ数' },
  { key: 'paperBagCount', label: '紙袋数' },
  { key: 'bulkQuantity', label: 'バラ数量' },
  { key: 'inspectedQuantity', label: '検査済み数量' },
  { key: 'uninspectedQuantity', label: '未検査数量' },
]

const DEFAULT_BRANDED_RICE_WEIGHT = 1020
const DEFAULT_FEED_RICE_WEIGHT = 1000
const INLINE_DETAIL_SAVE_DELAY_MS = 2_000
const AUTHORIZATION_NO_COLLATOR = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })

function currentFiscalYear() { return new Date().getFullYear() - 2018 }
function westernYear(fiscalYear: number) { return fiscalYear >= 2000 ? fiscalYear : fiscalYear + 2018 }
function today() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}
function emptyAddGroupForm(): AddGroupForm {
  const date = today()
  return {
    authorization_id: '',
    producer_name: '',
    fiscal_year: String(currentFiscalYear()),
    purchase_date: date,
    settlement_no: '',
    inspection_date: date,
    inspection_location: '',
    brand: '',
    flexcon_count: '',
    flexcon_quantity_kg: null,
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
  const selectedGrade = selectedInspectionGrade(grade)
  return Boolean(selectedGrade) && (isFeedRiceBrand(brand) ? selectedGrade === '合格' : selectedGrade !== '合格')
}
function isInspectionResultComplete(item: FlexconInspection | PaperBagInspection) {
  const grade = selectedInspectionGrade(item.grade)
  const reasonOptional = grade === '1等' || grade === '合格'
  const quantity = 'quantity_kg' in item ? item.quantity_kg : item.bag_count
  return item.fiscal_year > 0
    && Boolean(item.purchase_date)
    && Boolean(item.inspection_date)
    && Boolean(item.inspector_name?.trim())
    && Boolean(item.inspection_location?.trim())
    && Boolean(item.brand?.trim())
    && quantity > 0
    && item.moisture !== null
    && Boolean(grade)
    && isGradeAllowedForBrand(item.brand ?? '', grade)
    && (reasonOptional || Boolean(item.reason?.trim()))
}
function incompleteInspectionFields(item: FlexconInspection | PaperBagInspection) {
  const fields: string[] = []
  const grade = selectedInspectionGrade(item.grade)
  const quantity = 'quantity_kg' in item ? item.quantity_kg : item.bag_count
  if (item.fiscal_year <= 0) fields.push('年度')
  if (!item.purchase_date) fields.push('仕入日')
  if (!item.inspection_date) fields.push('検査日')
  if (!item.inspector_name?.trim()) fields.push('検査員')
  if (!item.inspection_location?.trim()) fields.push('検査場所')
  if (!item.brand?.trim()) fields.push('銘柄')
  if (quantity <= 0) fields.push('数量')
  if (item.moisture === null) fields.push('水分')
  if (!grade) {
    fields.push('等級')
  } else if (!isGradeAllowedForBrand(item.brand ?? '', grade)) {
    fields.push('銘柄に対応する等級')
  }
  if (grade && grade !== '1等' && grade !== '合格' && !item.reason?.trim()) fields.push('理由')
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
function joinDistinct(values: Array<string | null | undefined>, formatter: (value: string) => string = (value) => value) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)).map(formatter))].join('、')
}
function summaryDisplayValue(row: InspectionRegistrationSummaryRow, key: SummaryColumn) {
  if (key === 'recordKind') return inspectionSummaryKindLabel(row.recordKind)
  if (key === 'flexconCount') return `${row.flexconCount.toLocaleString()}本`
  if (key === 'paperBagCount') return `${row.paperBagCount.toLocaleString()}袋`
  if (key === 'bulkQuantity' || key === 'inspectedQuantity' || key === 'uninspectedQuantity') return `${row[key].toLocaleString()}kg`
  return String(row[key] ?? '')
}
function summarySortValue(row: InspectionRegistrationSummaryRow, key: SummaryColumn) {
  if (key === 'recordKind') return inspectionSummaryKindLabel(row.recordKind)
  if (key === 'flexconCount' || key === 'paperBagCount' || key === 'bulkQuantity' || key === 'inspectedQuantity' || key === 'uninspectedQuantity') return row[key]
  return String(row[key] ?? '')
}
function InspectionSummaryColumnHeader({
  column,
  sort,
  values,
  selectedValues,
  textValue,
  onSort,
  onFilterChange,
  onTextChange,
}: {
  column: { key: SummaryColumn; label: string }
  sort: { key: SummaryColumn; direction: SummarySortDirection } | null
  values: string[]
  selectedValues: string[] | undefined
  textValue: string
  onSort: (key: SummaryColumn) => void
  onFilterChange: (key: SummaryColumn, values: string[] | undefined) => void
  onTextChange: (key: SummaryColumn, value: string) => void
}) {
  return <th className={`inspection-summary-column-heading inspection-summary-column-${column.key}`}>
    <div className="shipment-column-heading">
      <button type="button" className="shipment-column-sort" onClick={() => onSort(column.key)}>
        <span>{column.label}</span>
        {sort?.key === column.key && (sort.direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
      </button>
      <TableColumnFilter label={column.label} values={values} selectedValues={selectedValues} onChange={(next) => onFilterChange(column.key, next)} textValue={textValue} onTextChange={(next) => onTextChange(column.key, next)} openRight={column.key === 'inspectionStatus' || column.key === 'authorizationNo'} />
    </div>
  </th>
}
function brandTypeForPrefecture(prefecture: string | null): 'brand_aomori' | 'brand_iwate' | null {
  const normalized = (prefecture ?? '').trim().replace(/県$/, '')
  if (normalized === '青森') return 'brand_aomori'
  if (normalized === '岩手') return 'brand_iwate'
  return null
}
export function InspectionRecordManager({ workerId, isAdmin, readOnly, selectedAuthorizationId, selectedRegistrationId, selectedRecordTarget, summaryState, onSummaryStateChange, summaryScrollRef, onSelectedAuthorizationChange, onSelectedRegistrationChange, onSelectedRecordTargetChange, onBack }: Props) {
  const reportingPeriod = useReportingPeriod()
  const highlightedRecordIds = useMemo(() => new Set(selectedRecordTarget ? [selectedRecordTarget.id, ...(selectedRecordTarget.highlightIds ?? [])] : []), [selectedRecordTarget])
  const { mode: calendarMode, formatDate: displayDate, formatCropYear: displayCropYear } = useCalendarMode()
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
  const [batchMetadataDraft, setBatchMetadataDraft] = useState<BatchInspectionMetadata>({ registration_id: null, ...EMPTY_BATCH_METADATA })
  const [batchMetadataBusy, setBatchMetadataBusy] = useState(false)
  const batchMetadataBusyRef = useRef(false)
  const [splitPaper, setSplitPaper] = useState<PaperBagInspection | null>(null)
  const [splitCounts, setSplitCounts] = useState({ first: '', second: '' })
  const [detailAddition, setDetailAddition] = useState<DetailAdditionDraft | null>(null)
  const { view: summaryView, sort: summarySort, columnFilters: summaryColumnFilters, textFilters: summaryTextFilters } = summaryState
  const hasSummaryFilters = SUMMARY_COLUMNS.some((column) => summaryColumnFilters[column.key] !== undefined || Boolean(summaryTextFilters[column.key]))
  const aggregateFilters = summaryState.aggregateFilters
  const hasAggregateFilters = Object.values(aggregateFilters.columnFilters).some(value => value !== undefined) || Object.values(aggregateFilters.textFilters).some(value => Boolean(value?.trim()))
  const changeAggregateColumnFilter = (key: InspectionAggregateColumn, values: string[] | undefined) => onSummaryStateChange(current => ({
    ...current, aggregateFilters: { ...current.aggregateFilters, columnFilters: { ...current.aggregateFilters.columnFilters, [key]: values } },
  }))
  const changeAggregateTextFilter = (key: InspectionAggregateColumn, value: string) => onSummaryStateChange(current => ({
    ...current, aggregateFilters: { ...current.aggregateFilters, textFilters: { ...current.aggregateFilters.textFilters, [key]: value } },
  }))
  const clearAggregateFilters = () => onSummaryStateChange(current => ({ ...current, aggregateFilters: { columnFilters: {}, textFilters: {} } }))
  const inspectionPeriod = summaryState.period
  const invalidInspectionPeriod = Boolean(inspectionPeriod.start && inspectionPeriod.end && inspectionPeriod.start > inspectionPeriod.end)
  const changeInspectionPeriod = (values: Partial<InspectionPeriod>) => onSummaryStateChange((current) => ({ ...current, period: { ...current.period, ...values } }))
  const setSummaryView = (view: InspectionSummaryState['view']) => onSummaryStateChange((current) => ({ ...current, view }))
  const summaryWrapRef = useRef<HTMLDivElement>(null)
  const [recordsLoaded, setRecordsLoaded] = useState(false)
  useEffect(() => {
    if (summaryState.calendarMode === calendarMode) return
    onSummaryStateChange((current) => ({
      ...current, calendarMode,
      columnFilters: { ...current.columnFilters, purchaseDates: undefined, inspectionDates: undefined },
      textFilters: { ...current.textFilters, purchaseDates: undefined, inspectionDates: undefined },
      aggregateFilters: {
        columnFilters: { ...current.aggregateFilters.columnFilters, fiscalYear: undefined },
        textFilters: { ...current.aggregateFilters.textFilters, fiscalYear: undefined },
      },
    }))
  }, [calendarMode, summaryState.calendarMode, onSummaryStateChange])
  // Restore after loading so an empty table cannot clamp the saved position.
  useLayoutEffect(() => {
    if (!recordsLoaded || selectedAuthorizationId || summaryView !== 'list') return
    const wrap = summaryWrapRef.current
    if (!wrap) return
    const saved = summaryScrollRef.current
    wrap.scrollTop = saved.top
    wrap.scrollLeft = saved.left
    const main = wrap.closest('main')
    if (main) { main.scrollTop = saved.mainTop; main.scrollLeft = saved.mainLeft }
    window.scrollTo(saved.pageLeft, saved.pageTop)
  }, [recordsLoaded, selectedAuthorizationId, summaryView, summaryScrollRef])
  const rememberSummaryPosition = () => {
    const wrap = summaryWrapRef.current
    if (!wrap || !recordsLoaded) return
    const main = wrap.closest('main')
    summaryScrollRef.current = { top: wrap.scrollTop, left: wrap.scrollLeft, pageTop: window.scrollY, pageLeft: window.scrollX, mainTop: main?.scrollTop ?? 0, mainLeft: main?.scrollLeft ?? 0 }
  }
  const [notice, setNotice] = useState<Notice>(null)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [certificateDialogOpen, setCertificateDialogOpen] = useState(false)
  const [certificateKind, setCertificateKind] = useState<CertificateKind>('standard')
  const [certificateRange, setCertificateRange] = useState({ start: '', count: '' })
  const [certificateManagementQr, setCertificateManagementQr] = useState(false)
  const [certificateBusy, setCertificateBusy] = useState(false)
  const [certificateError, setCertificateError] = useState('')
  const [generatedCertificate, setGeneratedCertificate] = useState<GeneratedCertificate | null>(null)
  const [gradingNoticeBusy, setGradingNoticeBusy] = useState(false)
  const [gradingNoticeFailure, setGradingNoticeFailure] = useState<GradingNoticeFailure | null>(null)
  const [inspectionLedgerBusy, setInspectionLedgerBusy] = useState(false)
  const [inspectionLedgerFailure, setInspectionLedgerFailure] = useState<GradingNoticeFailure | null>(null)
  const detailDraftsRef = useRef<Record<string, InlineDetailDraft>>({})
  const detailDraftRevisions = useRef(new Map<string, number>())
  const detailSaveTimers = useRef(new Map<string, number>())
  const detailSaveChains = useRef(new Map<string, Promise<boolean>>())
  const scrolledRecordTargetRef = useRef<string | null>(null)

  const cancelScheduledInlineDetailSave = (itemId: string) => {
    const timer = detailSaveTimers.current.get(itemId)
    if (timer === undefined) return
    window.clearTimeout(timer)
    detailSaveTimers.current.delete(itemId)
  }

  useEffect(() => () => {
    detailSaveTimers.current.forEach((timer) => window.clearTimeout(timer))
    detailSaveTimers.current.clear()
  }, [])

  useEffect(() => {
    const load = async () => {
      // The API caps each response; lists and totals need every page of related records.
      const [authorizationResult, registrationResult, flexconResult, paperResult, optionResult, weightResult] = await Promise.all([
        loadAllRows((from, to) => supabase.from('flexcon_authorizations').select('*').order('authorization_no').order('id').range(from, to)),
        loadAllRows((from, to) => supabase.from('flexcon_inspection_registrations').select('*').order('registration_no').order('id').range(from, to)),
        loadAllRows((from, to) => supabase.from('flexcon_inspection_flexcons').select('*').order('purchase_date', { ascending: false }).order('flexcon_no').order('id').range(from, to)),
        loadAllRows((from, to) => supabase.from('flexcon_inspection_paper_bags').select('*').order('purchase_date', { ascending: false }).order('created_at').order('id').range(from, to)),
        supabase.from('flexcon_inspection_options').select('*').order('sort_order').order('name'),
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
      setRecordsLoaded(true)
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
    .filter((item) => item.authorization_id === selectedAuthorizationId)
    .sort((left, right) => left.flexcon_no - right.flexcon_no)
  const selectedStandardFlexcons = selectedFlexcons.filter((item) => flexconRecordKind(item, weights) === 'standard')
  const selectedBulkFlexcons = selectedFlexcons.filter((item) => flexconRecordKind(item, weights) === 'bulk')
  const selectedPaperBags = paperBags.filter((item) => item.authorization_id === selectedAuthorizationId)
  const selectedRegistration = registrations.find((item) => item.id === selectedRegistrationId) ?? null
  const certificateFlexconsFor = (kind: CertificateKind) => kind === 'bulk' ? selectedBulkFlexcons : selectedStandardFlexcons
  const selectedRegistrationRecords: Array<FlexconInspection | PaperBagInspection> = [...selectedFlexcons, ...selectedPaperBags]
  const batchMetadata = batchMetadataDraft.registration_id === selectedRegistrationId ? batchMetadataDraft : {
    registration_id: selectedRegistrationId,
    ...EMPTY_BATCH_METADATA,
  }
  const batchStartNo = batchMetadata.start_no.trim() === '' ? null : Number(batchMetadata.start_no)
  const batchEndNo = batchMetadata.end_no.trim() === '' ? null : Number(batchMetadata.end_no)
  const batchEligibleRecords = [...selectedStandardFlexcons, ...selectedPaperBags]
    .filter((item) => item.registration_id === selectedRegistrationId)
  const batchRecordDate = (item: FlexconInspection | PaperBagInspection) => detailDrafts[item.id]?.inspection_date ?? item.inspection_date ?? ''
  const batchDateOptions = [...new Set(batchEligibleRecords.map(batchRecordDate).filter(Boolean))].sort()
  if (batchMetadata.date_scope !== 'all' && batchMetadata.date_scope !== 'undated' && !batchDateOptions.includes(batchMetadata.date_scope)) batchDateOptions.push(batchMetadata.date_scope)
  const batchHasUndated = batchEligibleRecords.some((item) => !batchRecordDate(item)) || batchMetadata.date_scope === 'undated'
  const batchTargetRecords: Array<FlexconInspection | PaperBagInspection> = (batchMetadata.target_kind === 'paper' ? selectedPaperBags : [
    ...selectedStandardFlexcons.filter((item) => batchMetadata.target_kind === 'all' || (
      (batchStartNo === null || item.flexcon_no >= batchStartNo) && (batchEndNo === null || item.flexcon_no <= batchEndNo)
    )),
    ...(batchMetadata.target_kind === 'all' ? selectedPaperBags : []),
  ]).filter((item) => item.registration_id === selectedRegistrationId && (
    batchMetadata.date_scope === 'all' || batchRecordDate(item) === (batchMetadata.date_scope === 'undated' ? '' : batchMetadata.date_scope)
  ))
  const changeBatchMetadata = (values: Partial<BatchInspectionMetadata>) => {
    setBatchMetadataDraft({ ...batchMetadata, registration_id: selectedRegistrationId, ...values })
  }

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
    return registrations.flatMap((registration): InspectionRegistrationSummaryRow[] => {
      const authorization = authorizationById.get(registration.authorization_id)
      if (!authorization) return []
      const registeredFlexcons = flexconsByRegistration.get(registration.id) ?? []
      const registeredPaperBags = paperBagsByRegistration.get(registration.id) ?? []
      const registrationRecords: Array<FlexconInspection | PaperBagInspection> = [...registeredFlexcons, ...registeredPaperBags]
      return groupInspectionSummaryRecords(registrationRecords, item => 'quantity_kg' in item ? flexconRecordKind(item, weights) : 'paper').flatMap(({ key, inspectionDate, brand, kind, records: allRecords }): InspectionRegistrationSummaryRow[] => {
        const records = allRecords.filter(item => matchesReportingPeriod(inspectionReportingDate(item), reportingPeriod))
        if (records.length === 0) return []
        const dateFlexcons = records.filter((item): item is FlexconInspection => 'quantity_kg' in item)
        const datePaperBags = records.filter((item): item is PaperBagInspection => !('quantity_kg' in item))
        const grade = joinDistinct(records.map((item) => selectedInspectionGrade(item.grade) || '未入力'))
        const standardFlexcons = dateFlexcons.filter((item) => flexconRecordKind(item, weights) === 'standard')
        const bulkFlexcons = dateFlexcons.filter((item) => flexconRecordKind(item, weights) === 'bulk')
        const quantityFor = (item: FlexconInspection | PaperBagInspection) => (
          'quantity_kg' in item ? item.quantity_kg : item.bag_count * 30
        )
        return [{
          partialPeriodGroup: records.length !== allRecords.length,
          groupKey: JSON.stringify([registration.id, key]),
          recordKind: kind,
          registrationId: registration.id,
          registrationNo: registration.registration_no,
          settlementNo: joinDistinct(records.map((item) => item.settlement_no ?? registration.settlement_no)),
          authorizationId: authorization.id,
          purchaseDates: joinDistinct(records.map((item) => item.purchase_date), (value) => formatDisplayDate(value, calendarMode)),
          inspectionDate,
          flexconIds: dateFlexcons.map((item) => item.id),
          paperBagIds: datePaperBags.map((item) => item.id),
          inspectionDates: inspectionDate ? formatDisplayDate(inspectionDate, calendarMode) : '',
          fullName: authorization.full_name,
          origin: formatPrefectureName(authorization.prefecture),
          municipality: authorization.municipality ?? '',
          inspectionLocations: joinDistinct(records.map((item) => item.inspection_location)),
          authorizationNo: authorization.authorization_no,
          brands: brand,
          grade,
          flexconCount: standardFlexcons.length,
          paperBagCount: datePaperBags.reduce((total, item) => total + item.bag_count, 0),
          bulkQuantity: bulkFlexcons.reduce((total, item) => total + item.quantity_kg, 0),
          inspectedQuantity: records.filter(isInspectionResultComplete).reduce((total, item) => total + quantityFor(item), 0),
          uninspectedQuantity: records.filter((item) => !isInspectionResultComplete(item)).reduce((total, item) => total + quantityFor(item), 0),
          inspectionStatus: records.every(isInspectionResultComplete) ? '完了' : '未完了',
        }]
      })
    }).sort((left, right) => left.registrationNo - right.registrationNo)
  }, [authorizations, flexcons, paperBags, registrations, weights, calendarMode, reportingPeriod])
  const summaryFilterValues = useMemo(() => Object.fromEntries(SUMMARY_COLUMNS.map((column) => [
    column.key,
    Array.from(new Set(summaryRows.map((row) => summaryDisplayValue(row, column.key)))).sort((left, right) => left.localeCompare(right, 'ja', { numeric: true })),
  ])) as Record<SummaryColumn, string[]>, [summaryRows])
  const displayedSummary = useMemo(() => {
    const rows = summaryRows.filter((row) => {
      return SUMMARY_COLUMNS.every((column) => {
        const selected = summaryColumnFilters[column.key]
        const value = summaryDisplayValue(row, column.key)
        return (selected === undefined || selected.includes(value)) && matchesFilterText(value, summaryTextFilters[column.key] ?? '')
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
  }, [summaryColumnFilters, summaryTextFilters, summaryRows, summarySort])
  const changeSummarySort = (key: SummaryColumn) => {
    onSummaryStateChange((current) => ({ ...current, sort: !current.sort || current.sort.key !== key
      ? { key, direction: 'asc' } : current.sort.direction === 'asc' ? { key, direction: 'desc' } : null }))
  }
  const changeSummaryColumnFilter = (key: SummaryColumn, values: string[] | undefined) => {
    onSummaryStateChange((current) => {
      const next = { ...current.columnFilters }
      if (values === undefined) delete next[key]
      else next[key] = values
      return { ...current, columnFilters: next }
    })
  }

  const deleteInspectionRegistration = async (row: InspectionRegistrationSummaryRow) => {
    if (busy || row.partialPeriodGroup) return
    const inspectionDateLabel = row.inspectionDate ? formatDisplayDate(row.inspectionDate, calendarMode) : '検査日未設定'
    const groupLabel = `${row.brands || '銘柄未設定'}・${inspectionSummaryKindLabel(row.recordKind)}`
    const details = [
      `推フレ ${row.flexconCount}本`,
      `紙袋 ${row.paperBagCount}袋`,
      `バラ ${row.bulkQuantity.toLocaleString()}kg`,
    ].join('、')
    if (!window.confirm(`${row.fullName}（委任状№ ${row.authorizationNo}）の${inspectionDateLabel}（${groupLabel}）の行を削除しますか？\n${details}\n\nこの行の明細だけを削除します。同じ検査日でも他の銘柄・種類の記録は削除しません。他の検査日の記録も削除しません。`)) return

    setBusy(true)
    setNotice(null)
    const { error } = await supabase.rpc('flexcon_delete_inspection_summary_group', {
      p_worker_id: workerId,
      p_registration_id: row.registrationId,
      p_inspection_date: row.inspectionDate,
      p_brand: row.brands,
      p_record_kind: row.recordKind,
      p_flexcon_ids: row.flexconIds,
      p_paper_bag_ids: row.paperBagIds,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })

    setNotice({ type: 'success', text: `${row.fullName}の${inspectionDateLabel}（${groupLabel}）の行を削除しました。` })
    setVersion((value) => value + 1)
  }

  const dateFilteredRecords = useMemo(() => {
    const columns = ['purchaseDates', 'inspectionDates'] as const
    if (!columns.some((key) => summaryColumnFilters[key] !== undefined || Boolean(summaryTextFilters[key]?.trim()))) return null
    const ids = { flexcons: new Set<string>(), paperBags: new Set<string>() }
    for (const row of summaryRows) {
      if (!columns.every((key) => {
        const selected = summaryColumnFilters[key]
        const value = summaryDisplayValue(row, key)
        return (selected === undefined || selected.includes(value)) && matchesFilterText(value, summaryTextFilters[key] ?? '')
      })) continue
      row.flexconIds.forEach(id => ids.flexcons.add(id))
      row.paperBagIds.forEach(id => ids.paperBags.add(id))
    }
    return ids
  }, [summaryRows, summaryColumnFilters, summaryTextFilters])
  const periodFlexcons = useMemo(() => flexcons.filter((item) => (
    (!dateFilteredRecords || dateFilteredRecords.flexcons.has(item.id))
    && matchesReportingPeriod(inspectionReportingDate(item), reportingPeriod)
    && matchesInspectionPeriod(item, inspectionPeriod)
  )), [flexcons, dateFilteredRecords, inspectionPeriod, reportingPeriod])
  const periodPaperBags = useMemo(() => paperBags.filter((item) => (
    (!dateFilteredRecords || dateFilteredRecords.paperBags.has(item.id))
    && matchesReportingPeriod(inspectionReportingDate(item), reportingPeriod)
    && matchesInspectionPeriod(item, inspectionPeriod)
  )), [paperBags, dateFilteredRecords, inspectionPeriod, reportingPeriod])
  const inspectionProgressRows = useMemo(() => {
    const authorizationById = new Map(authorizations.map((authorization) => [authorization.id, authorization]))
    const grouped = new Map<string, InspectionProgressRow>()
    const addRecord = (item: FlexconInspection | PaperBagInspection, quantity: number, kind: InspectionProgressRow['kind']) => {
      const authorization = authorizationById.get(item.authorization_id)
      const origin = formatPrefectureName(authorization?.prefecture) || '産地未登録'
      const brand = item.brand?.trim() || '銘柄未登録'
      const key = JSON.stringify([kind, item.fiscal_year, origin, brand])
      const row = grouped.get(key) ?? {
        kind,
        fiscalYear: item.fiscal_year,
        origin,
        brand,
        inspectedByGrade: {},
        inspectedQuantity: 0,
        uninspectedQuantity: 0,
      }
      if (isInspectionResultComplete(item)) {
        const grade = selectedInspectionGrade(item.grade)
        row.inspectedQuantity += quantity
        if (grade) row.inspectedByGrade[grade] = (row.inspectedByGrade[grade] ?? 0) + quantity
      } else {
        row.uninspectedQuantity += quantity
      }
      grouped.set(key, row)
    }
    periodFlexcons.forEach((item) => addRecord(item, item.quantity_kg, 'flexcon'))
    periodPaperBags.forEach((item) => addRecord(item, item.bag_count * 30, 'paper'))
    return [...grouped.values()].sort((left, right) => (
      right.fiscalYear - left.fiscalYear
      || left.origin.localeCompare(right.origin, 'ja', { numeric: true })
      || left.brand.localeCompare(right.brand, 'ja', { numeric: true })
    ))
  }, [authorizations, periodFlexcons, periodPaperBags])
  const inspectionAggregateGrades = useMemo(() => {
    const masterGrades = inspectionOptions
      .filter((item) => item.active && item.option_type === 'grade')
      .map((item) => item.name.trim())
      .filter((grade) => Boolean(selectedInspectionGrade(grade)))
    const usedGrades = [...periodFlexcons, ...periodPaperBags]
      .filter(isInspectionResultComplete)
      .map((item) => selectedInspectionGrade(item.grade))
      .filter(Boolean)
    const filteredGrades = [...Object.keys(aggregateFilters.columnFilters), ...Object.keys(aggregateFilters.textFilters)]
      .filter(key => key.startsWith('grade:') && (aggregateFilters.columnFilters[key as InspectionAggregateColumn] !== undefined || aggregateFilters.textFilters[key as InspectionAggregateColumn]?.trim()))
      .map(key => key.slice('grade:'.length))
    return [...new Set([...masterGrades, ...usedGrades, ...filteredGrades])]
  }, [periodFlexcons, inspectionOptions, periodPaperBags, aggregateFilters])
  const aggregateColumns: Array<{ key: InspectionAggregateColumn; label: string; numeric?: boolean }> = [
    { key: 'fiscalYear', label: '産年' }, { key: 'origin', label: '産地' }, { key: 'brand', label: '銘柄' },
    ...inspectionAggregateGrades.map(grade => ({ key: `grade:${grade}` as const, label: grade, numeric: true })),
    { key: 'inspectedQuantity', label: '検査済み合計', numeric: true }, { key: 'uninspectedQuantity', label: '未検査数量', numeric: true },
  ]
  const displayedProgressRows = useMemo(() => inspectionProgressRows.filter(row => matchesInspectionAggregateFilters(row, aggregateFilters, calendarMode)), [inspectionProgressRows, aggregateFilters, calendarMode])
  const displayedAggregateGroups = useMemo(() => new Set(displayedProgressRows.map(inspectionAggregateGroupKey)), [displayedProgressRows])
  const inspectionProgressTotals = useMemo(() => displayedProgressRows.reduce((totals, row) => ({
    inspected: totals.inspected + row.inspectedQuantity,
    uninspected: totals.uninspected + row.uninspectedQuantity,
  }), { inspected: 0, uninspected: 0 }), [displayedProgressRows])
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
        inspectionLocation: item.inspection_location ?? '',
        moisture: item.moisture === null ? null : Number(item.moisture),
        grade: selectedInspectionGrade(item.grade) || null,
        missingFields: incompleteInspectionFields(item),
        complete: isInspectionResultComplete(item),
      }
    }
    const rows: InspectionDetailRow[] = [
      ...periodFlexcons.map((item) => ({
        ...commonDetail(item),
        kind: 'flexcon' as const,
        recordNo: item.flexcon_no,
        quantityKg: item.quantity_kg,
        quantityLabel: `${item.quantity_kg.toLocaleString()}kg`,
      })),
      ...periodPaperBags.map((item) => ({
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
  }, [authorizations, periodFlexcons, periodPaperBags])

  const locationOptions = inspectionOptions.filter((item) => item.active && item.option_type === 'location')
  const inspectorOptions = inspectionOptions.filter((item) => item.active && item.option_type === 'inspector')
  const gradeOptions = inspectionOptions.filter((item) => item.active && item.option_type === 'grade' && Boolean(selectedInspectionGrade(item.name)))
  const batchGradeTargets = batchTargetRecords.filter((item) => batchMetadata.overwrite || !(detailDrafts[item.id]?.grade ?? item.grade)?.trim())
  const batchGradeOptions = gradeOptions.filter((option) => batchGradeTargets.every((item) => isGradeAllowedForBrand(detailDrafts[item.id]?.brand ?? item.brand ?? '', option.name)))
  const reasonOptions = inspectionOptions.filter((item) => item.active && item.option_type === 'grade_reason')
  const selectedBrandType = brandTypeForPrefecture(selectedAuthorization?.prefecture ?? null)
  const brandOptions = inspectionOptions.filter((item) => item.active && (item.option_type === selectedBrandType || item.option_type === 'brand'))
  const additionFlexconQuantity = (form: AddGroupForm) => form.flexcon_quantity_kg ?? String(isFeedRiceBrand(form.brand) ? weights.feed_rice : weights.branded_rice)
  const addInspectionGroup = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!addAuthorization || busy) return setNotice({ type: 'error', text: '委任状一覧に登録されている生産者名を選択してください。' })
    const flexconCount = Number(addGroupForm.flexcon_count || 0)
    const paperBagCount = Number(addGroupForm.paper_bag_count || 0)
    const bulkQuantityKg = Number(addGroupForm.bulk_quantity_kg || 0)
    if (!addGroupForm.purchase_date) return setNotice({ type: 'error', text: '仕入日を入力してください。' })
    if (addGroupForm.settlement_no.trim().length > 80) return setNotice({ type: 'error', text: '仕切書№は80文字以内で入力してください。' })
    if (!locationOptions.some((option) => option.name === addGroupForm.inspection_location)) return setNotice({ type: 'error', text: '検査場所を選択してください。' })
    const warehouse = findWarehouseForInspectionLocation(addGroupForm.inspection_location, inspectionOptions)
    if (!warehouse) return setNotice({ type: 'error', text: '選択した検査場所と同じ名前の有効な倉庫がありません。マスタの倉庫を確認してください。' })
    if (!addGroupForm.brand) return setNotice({ type: 'error', text: '銘柄を選択してください。' })
    if (!Number.isInteger(bulkQuantityKg) || bulkQuantityKg < 0) return setNotice({ type: 'error', text: 'バラは0kg以上の整数で入力してください。' })
    if (flexconCount <= 0 && paperBagCount <= 0 && bulkQuantityKg <= 0) return setNotice({ type: 'error', text: 'フレコン本数、紙袋数、バラのいずれかを入力してください。' })
    const flexconQuantity = Number(additionFlexconQuantity(addGroupForm))
    if (flexconCount > 0 && (!Number.isInteger(flexconQuantity) || flexconQuantity < 1 || flexconQuantity > 2147483647)) return setNotice({ type: 'error', text: '推フレの数量は1kg以上の整数で入力してください。' })
    setBusy(true); setNotice(null)
    const { data, error } = await supabase.rpc('flexcon_add_inspection_group_with_warehouse', {
      p_worker_id: workerId,
      p_authorization_id: addAuthorization.id,
      p_fiscal_year: Number(addGroupForm.fiscal_year),
      p_purchase_date: addGroupForm.purchase_date,
      p_settlement_no: addGroupForm.settlement_no.trim(),
      p_inspection_date: addGroupForm.inspection_date || null,
      p_inspection_location: addGroupForm.inspection_location,
      p_warehouse_id: warehouse.id,
      p_brand: addGroupForm.brand,
      p_flexcon_count: flexconCount,
      p_paper_bag_count: paperBagCount,
      p_flexcon_quantity_kg: flexconCount > 0 ? flexconQuantity : null,
      p_bulk_quantity_kg: bulkQuantityKg,
    })
    setBusy(false)
    if (error) return setNotice({ type: 'error', text: error.message })
    setAddGroupForm(emptyAddGroupForm())
    setAddGroupFormOpen(false)
    setProducerPickerOpen(false)
    const registrationNo = Number((data as { registration_no?: unknown } | null)?.registration_no)
    let registrationId = (data as { registration_id?: string } | null)?.registration_id ?? null
    if (!registrationId && Number.isFinite(registrationNo)) {
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
    rememberSummaryPosition()
    onSelectedRecordTargetChange(null)
    onSelectedRegistrationChange(registrationId)
    onSelectedAuthorizationChange(addAuthorization.id)
  }
  const changeSummaryTextFilter = (key: SummaryColumn, value: string) => onSummaryStateChange((current) => {
    const next = { ...current.textFilters }
    if (value) next[key] = value
    else delete next[key]
    return { ...current, textFilters: next }
  })
  const openSummaryRecord = (row: InspectionRegistrationSummaryRow) => {
    rememberSummaryPosition()
    const flexconIds = new Set(row.flexconIds)
    const firstFlexcon = flexcons.filter(item => flexconIds.has(item.id)).sort((left, right) => left.flexcon_no - right.flexcon_no)[0]
    const paperBagIds = new Set(row.paperBagIds)
    const firstPaperBag = paperBags.find(item => paperBagIds.has(item.id))
    onSelectedRecordTargetChange(firstFlexcon ? { kind: 'flexcon', id: firstFlexcon.id, highlightIds: row.flexconIds } : firstPaperBag ? { kind: 'paper', id: firstPaperBag.id, highlightIds: row.paperBagIds } : null)
    onSelectedRegistrationChange(row.registrationId)
    onSelectedAuthorizationChange(row.authorizationId)
  }
  const clearSummaryFilters = () => onSummaryStateChange((current) => ({ ...current, columnFilters: {}, textFilters: {} }))

  const applyBatchMetadata = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedRegistration || batchMetadataBusyRef.current) return
    if (batchMetadata.target_kind === 'standard') {
      if ([batchStartNo, batchEndNo].some((value) => value !== null && (!Number.isInteger(value) || value < 1 || value > 2147483647))) return setNotice({ type: 'error', text: '番号範囲は1以上の整数で入力してください。' })
      if (batchStartNo !== null && batchEndNo !== null && batchStartNo > batchEndNo) return setNotice({ type: 'error', text: '開始№は終了№以下にしてください。' })
    }
    if (batchTargetRecords.length === 0) return setNotice({ type: 'error', text: '指定した対象・対象検査日・番号範囲に明細がありません。' })
    const selectedFields = [
      batchMetadata.inspection_date && '検査日',
      batchMetadata.inspector_name && '検査員',
      batchMetadata.inspection_location && '検査場所',
      batchMetadata.grade && '等級',
    ].filter(Boolean)
    if (selectedFields.length === 0) return setNotice({ type: 'error', text: '反映する項目を1つ以上入力してください。' })
    if (batchMetadata.grade && !batchGradeTargets.every((item) => isGradeAllowedForBrand(detailDrafts[item.id]?.brand ?? item.brand ?? '', batchMetadata.grade))) return setNotice({ type: 'error', text: '対象の明細の銘柄に設定できない等級が選択されています。' })

    batchMetadataBusyRef.current = true
    setBatchMetadataBusy(true)
    setNotice(null)
    try {
      detailSaveTimers.current.forEach((timer) => window.clearTimeout(timer))
      detailSaveTimers.current.clear()
      const pendingResults = await Promise.all(detailSaveChains.current.values())
      if (pendingResults.some((saved) => !saved)) return
      for (const item of selectedRegistrationRecords) {
        if (!detailDraftsRef.current[item.id]) continue
        const saved = await saveInlineDetail('quantity_kg' in item ? 'flexcon' : 'paper', item, {}, true)
        if (!saved) return
      }
      const { data, error } = await supabase.rpc('flexcon_set_inspection_registration_metadata_scope', {
        p_worker_id: workerId,
        p_registration_id: selectedRegistration.id,
        p_inspection_date: batchMetadata.inspection_date || null,
        p_inspector_name: batchMetadata.inspector_name || null,
        p_inspection_location: batchMetadata.inspection_location || null,
        p_grade: batchMetadata.grade || null,
        p_target_kind: batchMetadata.target_kind,
        p_start_no: batchMetadata.target_kind === 'standard' ? batchStartNo : null,
        p_end_no: batchMetadata.target_kind === 'standard' ? batchEndNo : null,
        p_overwrite: batchMetadata.overwrite,
        p_target_inspection_date: batchMetadata.date_scope === 'all' || batchMetadata.date_scope === 'undated' ? null : batchMetadata.date_scope,
        p_only_undated: batchMetadata.date_scope === 'undated',
      })
      if (error) return setNotice({ type: 'error', text: error.message })

      detailDraftsRef.current = {}
      setDetailDrafts({})
      setBatchMetadataDraft({ ...batchMetadata, registration_id: selectedRegistration.id, inspection_date: '', inspector_name: '', inspection_location: '', grade: '' })
      setNotice({ type: 'success', text: `${Number(data)}件の明細の${selectedFields.join('・')}を${batchMetadata.overwrite ? '上書き' : '未設定のみ更新'}しました。` })
      setVersion((value) => value + 1)
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '一括設定に失敗しました。' })
    } finally { batchMetadataBusyRef.current = false; setBatchMetadataBusy(false) }
  }

  const detailDraft = (item: FlexconInspection | PaperBagInspection): InlineDetailDraft => detailDrafts[item.id] ?? {
    settlement_no: item.settlement_no ?? '',
    fiscal_year: String(item.fiscal_year),
    purchase_date: item.purchase_date,
    inspection_date: item.inspection_date ?? '',
    inspector_name: item.inspector_name ?? '',
    inspection_location: item.inspection_location ?? '',
    brand: item.brand ?? '',
    quantity: String('quantity_kg' in item ? item.quantity_kg : item.bag_count),
    grade: selectedInspectionGrade(item.grade),
    reason: item.reason ?? '',
    moisture: item.moisture === null ? '' : String(item.moisture),
  }
  const currentDetailDraft = (item: FlexconInspection | PaperBagInspection) => detailDraftsRef.current[item.id] ?? detailDraft(item)
  const changeDetailDraft = (item: FlexconInspection | PaperBagInspection, values: Partial<InlineDetailDraft>) => {
    const nextDraft = { ...currentDetailDraft(item), ...values }
    detailDraftRevisions.current.set(item.id, (detailDraftRevisions.current.get(item.id) ?? 0) + 1)
    detailDraftsRef.current = { ...detailDraftsRef.current, [item.id]: nextDraft }
    setDetailDrafts((current) => ({ ...current, [item.id]: nextDraft }))
    return nextDraft
  }
  const saveInlineDetail = async (
    detailKind: 'flexcon' | 'paper',
    item: FlexconInspection | PaperBagInspection,
    values: Partial<InlineDetailDraft> = {},
    allowDuringBatch = false,
  ) => {
    if (!selectedAuthorization || busy || (batchMetadataBusyRef.current && !allowDuringBatch)) return false
    cancelScheduledInlineDetailSave(item.id)
    const draft = { ...currentDetailDraft(item), ...values }
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
    if (draft.settlement_no.trim().length > 80) return setNotice({ type: 'error', text: '仕切書№は80文字以内で入力してください。' })
    if (!Number.isInteger(quantity) || quantity <= 0) return setNotice({ type: 'error', text: detailKind === 'flexcon' ? '数量は1kg以上の整数で入力してください。' : '紙袋数は1以上の整数で入力してください。' })
    if (moisture !== null && (!Number.isFinite(moisture) || moisture < 0 || moisture > 100)) return setNotice({ type: 'error', text: '水分は0から100の範囲で入力してください。' })
    changeDetailDraft(item, draft)
    const revision = detailDraftRevisions.current.get(item.id)
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
      const { error } = await supabase.rpc('flexcon_save_inspection_detail_with_settlement', {
        ...common, p_detail_kind: detailKind, p_detail_id: item.id,
        p_flexcon_no: detailKind === 'flexcon' ? (item as FlexconInspection).flexcon_no : null,
        p_quantity: quantity, p_settlement_no: draft.settlement_no.trim(),
      })
      if (error) {
        setNotice({ type: 'error', text: error.message })
        return false
      }
      const savedValues = {
        settlement_no: draft.settlement_no.trim(),
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
      // An older response must not mark a newer edit (even the same value) as saved.
      if (detailDraftRevisions.current.get(item.id) === revision) {
        const nextDrafts = { ...detailDraftsRef.current }
        delete nextDrafts[item.id]
        detailDraftsRef.current = nextDrafts
      }
      setDetailDrafts((current) => {
        if (detailDraftRevisions.current.get(item.id) !== revision) return current
        const next = { ...current }
        delete next[item.id]
        return next
      })
      setNotice({ type: 'success', text: detailKind === 'flexcon' ? 'フレコン検査記録を保存しました。' : '紙袋検査記録を保存しました。' })
      return true
    }
    const previousSave = detailSaveChains.current.get(item.id) ?? Promise.resolve(true)
    const saveTask = previousSave.catch(() => undefined).then(runSave)
    detailSaveChains.current.set(item.id, saveTask)
    const saved = await saveTask
    if (detailSaveChains.current.get(item.id) === saveTask) detailSaveChains.current.delete(item.id)
    return saved
  }

  const scheduleInlineDetailSave = (
    detailKind: 'flexcon' | 'paper',
    item: FlexconInspection | PaperBagInspection,
    values: Partial<InlineDetailDraft>,
  ) => {
    changeDetailDraft(item, values)
    cancelScheduledInlineDetailSave(item.id)
    const timer = window.setTimeout(() => {
      detailSaveTimers.current.delete(item.id)
      void saveInlineDetail(detailKind, item)
    }, INLINE_DETAIL_SAVE_DELAY_MS)
    detailSaveTimers.current.set(item.id, timer)
  }

  const renderInlineMetadataFields = (detailKind: 'flexcon' | 'paper', item: FlexconInspection | PaperBagInspection) => {
    const draft = detailDraft(item)
    const save = (values: Partial<InlineDetailDraft> = {}) => void saveInlineDetail(detailKind, item, values)
    return <>
      <td className="inspection-inline-cell inspection-year-cell"><JapaneseFiscalYearInput textInput className={!draft.fiscal_year || Number(draft.fiscal_year) <= 0 ? 'inspection-missing' : ''} value={draft.fiscal_year} disabled={busy || batchMetadataBusy} onChange={(fiscal_year) => scheduleInlineDetailSave(detailKind, item, { fiscal_year })} onBlur={() => save()} /></td>
      <td className="inspection-inline-cell inspection-date-cell"><JapaneseDateInput className={!draft.purchase_date ? 'inspection-missing' : ''} value={draft.purchase_date} aria-label="仕入日" disabled={busy || batchMetadataBusy} onChange={(purchase_date) => { changeDetailDraft(item, { purchase_date }); save({ purchase_date }) }} /></td>
      <td className="inspection-inline-cell"><input value={draft.settlement_no} aria-label="仕切り書" maxLength={80} disabled={busy || batchMetadataBusy} onChange={(event) => scheduleInlineDetailSave(detailKind, item, { settlement_no: event.target.value })} onBlur={() => save()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></td>
      <td className="inspection-inline-cell inspection-date-cell"><JapaneseDateInput className={!draft.inspection_date ? 'inspection-missing' : ''} value={draft.inspection_date} aria-label="検査日" disabled={busy || batchMetadataBusy} onChange={(inspection_date) => { changeDetailDraft(item, { inspection_date }); save({ inspection_date }) }} /></td>
      <td className="inspection-inline-cell inspection-inspector-cell"><select className={!draft.inspector_name ? 'inspection-missing' : ''} value={draft.inspector_name} aria-label="検査員" disabled={busy || batchMetadataBusy} onChange={(event) => { const inspector_name = event.target.value; changeDetailDraft(item, { inspector_name }); save({ inspector_name }) }}><option value="">未選択</option>{inspectorOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
      <td className="inspection-inline-cell inspection-location-cell"><select className={!draft.inspection_location ? 'inspection-missing' : ''} value={draft.inspection_location} aria-label="検査場所" disabled={busy || batchMetadataBusy} onChange={(event) => { const inspection_location = event.target.value; changeDetailDraft(item, { inspection_location }); save({ inspection_location }) }}><option value="">未選択</option>{locationOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
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
      <td className="inspection-inline-cell"><InspectionNumberInput format="moisture" className={[draft.moisture === '' ? 'inspection-missing' : '', isHighMoisture(draft.moisture) ? 'moisture-high' : '', !Number.isFinite(Number(draft.moisture)) ? 'moisture-invalid' : ''].filter(Boolean).join(' ')} value={draft.moisture} aria-label="水分" disabled={busy || batchMetadataBusy} onValueChange={(moisture) => scheduleInlineDetailSave(detailKind, item, { moisture })} onBlur={() => save()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></td>
      <td className="inspection-inline-cell"><select className={!draft.grade ? 'inspection-missing' : ''} value={draft.grade} aria-label="等級" disabled={busy || batchMetadataBusy} onChange={(event) => { const grade = event.target.value; const reason = grade === '1等' || grade === '合格' ? '' : draft.reason; changeDetailDraft(item, { grade, reason }); save({ grade, reason }) }}><option value="">未選択</option>{availableGradeOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
      <td className="inspection-inline-cell inspection-inline-reason-cell"><select className={!reasonForbidden && Boolean(draft.grade) && !draft.reason ? 'inspection-missing' : ''} value={reasonForbidden ? '' : draft.reason} aria-label="理由" disabled={busy || batchMetadataBusy || reasonForbidden} title={reasonForbidden ? '1等と合格には理由を入力できません' : undefined} onChange={(event) => { const reason = event.target.value; changeDetailDraft(item, { reason }); save({ reason }) }}><option value="">未選択</option>{reasonOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
    </>
  }
  const renderInlineProductFields = (detailKind: 'flexcon' | 'paper', item: FlexconInspection | PaperBagInspection) => {
    const draft = detailDraft(item)
    const save = (values: Partial<InlineDetailDraft> = {}) => void saveInlineDetail(detailKind, item, values)
    return <>
      <td className="inspection-inline-cell inspection-brand-cell"><select className={!draft.brand ? 'inspection-missing' : ''} value={draft.brand} aria-label="銘柄" disabled={busy || batchMetadataBusy} onChange={(event) => { const brand = event.target.value; const grade = isGradeAllowedForBrand(brand, draft.grade) ? draft.grade : ''; const reason = grade ? draft.reason : ''; changeDetailDraft(item, { brand, grade, reason }); save({ brand, grade, reason }) }}><option value="">未選択</option>{brandOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></td>
      <td className="inspection-inline-cell inspection-quantity-cell"><InspectionNumberInput format="quantity" className={!draft.quantity || Number(draft.quantity) <= 0 ? 'inspection-missing' : ''} value={draft.quantity} aria-label={detailKind === 'flexcon' ? '数量（kg）' : '数量（袋）'} disabled={busy || batchMetadataBusy} onValueChange={(quantity) => scheduleInlineDetailSave(detailKind, item, { quantity })} onBlur={() => save()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></td>
    </>
  }
  const renderReadOnlyMetadataFields = (item: FlexconInspection | PaperBagInspection) => <>
    <td>{displayCropYear(item.fiscal_year).replace('年産', '年度')}</td>
    <td>{displayDate(item.purchase_date)}</td>
    <td>{item.settlement_no ?? ''}</td>
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
    <td className={selectedInspectionGrade(item.grade) ? undefined : 'inspection-missing'}>{selectedInspectionGrade(item.grade)}</td>
    <td className={selectedInspectionGrade(item.grade) && item.grade !== '1等' && item.grade !== '合格' && !item.reason ? 'inspection-missing' : undefined}>{selectedInspectionGrade(item.grade) ? item.reason ?? '' : ''}</td>
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
  const addInspectionDetail = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedRegistration || !detailAddition || detailAddition.registrationId !== selectedRegistration.id || busy) return
    const form = detailAddition.form
    const counts = [form.flexcon_count, form.paper_bag_count, form.bulk_quantity_kg].map((value) => Number(value || 0))
    const flexconQuantity = Number(additionFlexconQuantity(form))
    if (counts[0] > 0 && (!Number.isInteger(flexconQuantity) || flexconQuantity < 1 || flexconQuantity > 2147483647)) return setNotice({ type: 'error', text: '推フレの数量は1kg以上の整数で入力してください。' })
    if (counts.some((value) => !Number.isInteger(value) || value < 0) || counts.every((value) => value === 0)) return setNotice({ type: 'error', text: '推フレ数・紙袋数・バラは0以上の整数で、いずれかを1以上入力してください。' })
    if (!form.purchase_date) return setNotice({ type: 'error', text: '仕入日を入力してください。' })
    if (!form.brand) return setNotice({ type: 'error', text: '銘柄を選択してください。' })
    if (!locationOptions.some((item) => item.name === form.inspection_location)) return setNotice({ type: 'error', text: '検査場所を選択してください。' })
    setBusy(true); setNotice(null)
    try {
      const { error } = await supabase.rpc('flexcon_append_inspection_registration', {
        p_worker_id: workerId, p_registration_id: selectedRegistration.id,
        p_fiscal_year: Number(form.fiscal_year), p_purchase_date: form.purchase_date,
        p_settlement_no: form.settlement_no.trim(), p_inspection_date: form.inspection_date || null,
        p_inspection_location: form.inspection_location, p_brand: form.brand,
        p_flexcon_count: counts[0], p_paper_bag_count: counts[1], p_bulk_quantity_kg: counts[2],
        p_flexcon_quantity_kg: counts[0] > 0 ? flexconQuantity : null,
      })
      if (error) throw error
      setDetailAddition(null)
      onSelectedRecordTargetChange(null)
      setNotice({ type: 'success', text: '検査対象を追加しました。' })
      setVersion((value) => value + 1)
    } catch (error) {
      setNotice({ type: 'error', text: error && typeof error === 'object' && 'message' in error ? String(error.message) : '追加できませんでした。通信状態を確認してください。' })
    } finally { setBusy(false) }
  }
  const openCertificateDialog = (kind: CertificateKind) => {
    const candidates = certificateFlexconsFor(kind)
    if (candidates.length === 0) return
    if (generatedCertificate) URL.revokeObjectURL(generatedCertificate.url)
    setGeneratedCertificate(null)
    setCertificateError('')
    setCertificateKind(kind)
    setCertificateRange(certificateDefaultRange(candidates))
    setCertificateManagementQr(false)
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
    const count = Number(certificateRange.count)
    if (!Number.isInteger(start) || !Number.isInteger(count) || count <= 0) return []
    return certificateFlexconsFor(certificateKind).filter((item) => item.flexcon_no >= start).slice(0, count)
  }
  const createCertificatePdf = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedAuthorization || certificateBusy) return
    const start = Number(certificateRange.start)
    const count = Number(certificateRange.count)
    if (!Number.isInteger(start) || !Number.isInteger(count) || start <= 0 || count <= 0) {
      setCertificateError('開始№と枚数は1以上の整数で入力してください。')
      return
    }
    const targets = certificateTargets()
    if (targets.length === 0) {
      setCertificateError('開始№以降に印刷できるフレコンがありません。')
      return
    }
    if (targets.length < count) {
      setCertificateError(`開始№以降の印刷対象は${targets.length}枚です。枚数を${targets.length}以下にしてください。`)
      return
    }
    const quantityConfirmation = certificateKind === 'standard' ? certificateQuantityConfirmation(targets, weights) : null
    if (quantityConfirmation && !window.confirm(quantityConfirmation)) return

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
        includeManagementQr: isAdmin && certificateManagementQr,
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
      const end = targets[targets.length - 1].flexcon_no
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
        ...targetFlexcons.map((item) => ({
          ...commonRecord(item),
          kind: 'flexcon' as const,
          quantityCount: 1,
          quantityKg: item.quantity_kg,
          weightKg: item.quantity_kg,
        })),
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
        anchor.download = `検査請求者別検査台帳_${selectedAuthorization.authorization_no}_${formatJapaneseDateForFilename(today())}.pdf`
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
        anchor.download = `格付結果通知票_${selectedAuthorization.authorization_no}_${formatJapaneseDateForFilename(today())}.pdf`
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
        <thead><tr><th>産年</th><th>産地</th><th>銘柄</th><th>種別</th><th>№</th><th>数量</th><th>委任状№</th><th>氏名</th><th>仕入日</th><th>検査日</th><th>検査場所</th><th>水分</th><th>等級</th><th>未記入</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={`${row.kind}-${row.id}`} tabIndex={0} onClick={() => openInspectionDetail(row)} onKeyDown={(event) => { if (event.key === 'Enter') openInspectionDetail(row) }}>
          <td>{displayCropYear(row.fiscalYear)}</td><td>{row.origin}</td><td>{row.brand}</td><td>{row.kind === 'flexcon' ? 'フレコン' : '紙袋'}</td><td>{row.recordNo ?? '-'}</td><td>{row.quantityLabel}</td><td>{row.authorizationNo}</td><td><strong>{row.fullName}</strong></td><td>{displayDate(row.purchaseDate)}</td><td>{displayDate(row.inspectionDate)}</td><td>{row.inspectionLocation}</td><td>{row.moisture === null ? '' : `${row.moisture.toFixed(1)}%`}</td><td>{row.grade ?? ''}</td><td>{row.missingFields.join('、')}</td>
        </tr>)}
        {rows.length === 0 && <tr><td colSpan={14} className="empty-state">該当する検査記録はありません</td></tr>}</tbody>
      </table></div>
    </details>
  }
  const renderInspectionAggregate = (kind: InspectionProgressRow['kind'], title: string) => {
    const rows = displayedProgressRows.filter((row) => row.kind === kind)
    const details = inspectionDetailRows.filter((row) => row.kind === kind && displayedAggregateGroups.has(inspectionAggregateGroupKey(row)))
    const totals = rows.reduce((total, row) => ({
      inspected: total.inspected + row.inspectedQuantity,
      uninspected: total.uninspected + row.uninspectedQuantity,
    }), { inspected: 0, uninspected: 0 })
    return <section className="inspection-aggregate-kind" data-kind={kind} aria-label={`${title}の集計`}>
      <div className="section-title">
        <div><h3>{title}</h3>{kind === 'flexcon' && <span>推フレ・バラ</span>}</div>
        <div className="inspection-progress-totals"><span>検査済み <strong>{totals.inspected.toLocaleString()}kg</strong></span><span>未検査 <strong>{totals.uninspected.toLocaleString()}kg</strong></span></div>
      </div>
      <div className="inspection-progress-table-wrap"><table className="inspection-progress-table">
        <thead><tr>{aggregateColumns.map(column => <th key={column.key} className={column.numeric ? 'numeric-cell' : undefined}><div className="shipment-column-heading inspection-aggregate-column-heading"><span>{column.label}</span><TableColumnFilter label={column.label} values={[...new Set(inspectionProgressRows.map(row => inspectionAggregateDisplayValue(row, column.key, calendarMode)))].sort((left, right) => left.localeCompare(right, 'ja', { numeric: true }))} selectedValues={aggregateFilters.columnFilters[column.key]} onChange={values => changeAggregateColumnFilter(column.key, values)} textValue={aggregateFilters.textFilters[column.key] ?? ''} onTextChange={value => changeAggregateTextFilter(column.key, value)} openRight={column.key === 'fiscalYear' || column.key === 'origin'} /></div></th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={JSON.stringify([row.fiscalYear, row.origin, row.brand])}>
          <td>{displayCropYear(row.fiscalYear)}</td><td>{row.origin}</td><td>{row.brand}</td>{inspectionAggregateGrades.map((grade) => <td className="inspection-progress-grade numeric-cell" key={grade}>{row.inspectedByGrade[grade] ? `${row.inspectedByGrade[grade].toLocaleString()}kg` : ''}</td>)}<td className="inspection-progress-inspected numeric-cell">{row.inspectedQuantity.toLocaleString()}kg</td><td className="inspection-progress-uninspected numeric-cell">{row.uninspectedQuantity.toLocaleString()}kg</td>
        </tr>)}
        {rows.length === 0 && <tr><td colSpan={inspectionAggregateGrades.length + 5} className="empty-state">該当する検査記録はありません</td></tr>}</tbody>
      </table></div>
      <div className="inspection-record-detail-lists">
        {renderInspectionDetailList('検査済み詳細一覧', details.filter((row) => row.complete), 'inspected')}
        {renderInspectionDetailList('未検査詳細一覧', details.filter((row) => !row.complete), 'uninspected')}
      </div>
    </section>
  }
  const openDetailAddition = (kind: DetailAdditionKind) => {
    if (!selectedRegistration || !selectedAuthorization) return
    const base = [...selectedStandardFlexcons, ...selectedBulkFlexcons, ...selectedPaperBags][0]
    setNotice(null)
    setDetailAddition({ registrationId: selectedRegistration.id, kind, form: {
      ...emptyAddGroupForm(), authorization_id: selectedAuthorization.id, producer_name: selectedAuthorization.full_name,
      fiscal_year: base ? String(base.fiscal_year) : String(currentFiscalYear()),
      settlement_no: '',
      inspection_location: base?.inspection_location ?? '', brand: base?.brand ?? '',
      flexcon_count: kind === 'standard' ? '1' : '',
    } })
  }
  const toggleAddGroupForm = () => {
    setProducerPickerOpen(false)
    if (!addGroupFormOpen) {
      const date = today()
      setAddGroupForm(current => ({ ...current, purchase_date: date, inspection_date: date }))
    }
    setAddGroupFormOpen(current => !current)
  }
  const renderAdditionFields = (form: AddGroupForm, change: (values: Partial<AddGroupForm>) => void, authorization: AuthorizationRecord | null) => {
    const brandType = brandTypeForPrefecture(authorization?.prefecture ?? null)
    const brands = inspectionOptions.filter((item) => item.active && (item.option_type === brandType || item.option_type === 'brand'))
    const missingAmount = ![form.flexcon_count, form.paper_bag_count, form.bulk_quantity_kg].some((value) => Number(value) > 0)
    const missingFlexconQuantity = Number(form.flexcon_count) > 0 && (!additionFlexconQuantity(form).trim() || Number(additionFlexconQuantity(form)) <= 0)
    return <>
      <label>年度<JapaneseFiscalYearInput className={!form.fiscal_year ? 'inspection-missing' : undefined} value={form.fiscal_year} onChange={(fiscal_year) => change({ fiscal_year })} required /></label>
      <label>仕入日<JapaneseDateInput className={!form.purchase_date ? 'inspection-missing' : undefined} value={form.purchase_date} onChange={(purchase_date) => change({ purchase_date })} required /></label>
      <label>仕切書№<input value={form.settlement_no} maxLength={80} onChange={(event) => change({ settlement_no: event.target.value })} /></label>
      <label>検査日<JapaneseDateInput value={form.inspection_date} onChange={(inspection_date) => change({ inspection_date })} /></label>
      <label>検査場所<select className={!form.inspection_location ? 'inspection-missing' : undefined} value={form.inspection_location} onChange={(event) => change({ inspection_location: event.target.value })} required><option value="">選択してください</option>{locationOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
      <label>産地<input value={formatPrefectureName(authorization?.prefecture) || ''} readOnly aria-label="産地" /></label>
      <label>銘柄<select className={!form.brand ? 'inspection-missing' : undefined} value={form.brand} onChange={(event) => change({ brand: event.target.value, flexcon_quantity_kg: null })} required disabled={!authorization}><option value="">選択してください</option>{brands.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
      <label>推フレ数<input className={missingAmount ? 'inspection-missing' : undefined} type="number" min="0" max="999" step="1" value={form.flexcon_count} onChange={(event) => change({ flexcon_count: event.target.value })} placeholder="0" /></label>
      <label>数量（kg/本）<InspectionNumberInput className={missingFlexconQuantity ? 'inspection-missing' : undefined} format="quantity" value={additionFlexconQuantity(form)} onValueChange={(flexcon_quantity_kg) => change({ flexcon_quantity_kg })} required={Number(form.flexcon_count) > 0} /></label>
      <label>紙袋数<input className={missingAmount ? 'inspection-missing' : undefined} type="number" min="0" step="1" value={form.paper_bag_count} onChange={(event) => change({ paper_bag_count: event.target.value })} placeholder="0" /></label>
      <label>バラ（kg）<input className={missingAmount ? 'inspection-missing' : undefined} type="number" min="0" step="1" value={form.bulk_quantity_kg} onChange={(event) => change({ bulk_quantity_kg: event.target.value })} placeholder="0" /></label>
    </>
  }
  const renderDetailAddition = (kind: DetailAdditionKind) => {
    if (readOnly || !selectedRegistration) return null
    if (detailAddition?.registrationId !== selectedRegistration.id || detailAddition.kind !== kind) return <div className="inspection-detail-add-row inspection-detail-add-trigger">
      <button className="secondary-button" type="button" disabled={busy} onClick={() => openDetailAddition(kind)}><Plus size={17} />追加</button>
    </div>
    return <div className="inspection-detail-add-row">
      {notice?.type === 'error' && <div className="notice error" role="alert">{notice.text}</div>}
      <form className="inspection-group-add inspection-summary-add inspection-detail-add-form" noValidate onSubmit={(event) => void addInspectionDetail(event)}>
      <label>生産者名<input value={selectedAuthorization?.full_name ?? ''} readOnly /></label>
      {renderAdditionFields(detailAddition.form, (values) => setDetailAddition((current) => current ? { ...current, form: { ...current.form, ...values } } : null), selectedAuthorization)}
      <div className="button-row inspection-detail-add-actions">
      <button className="icon-button" type="button" title="追加を取り消す" aria-label="追加を取り消す" onClick={() => setDetailAddition(null)} disabled={busy}><X size={18} /></button>
      <button className="primary-button" type="submit" disabled={busy}><Plus size={17} />追加</button>
      </div>
    </form></div>
  }
  const renderFlexconSection = (title: string, items: FlexconInspection[], certificateSectionKind: CertificateKind) => items.length === 0 && (readOnly || !selectedRegistration) ? null : <section className="section-band inspection-detail-section">
    <div className="section-title"><div><h2>{title}</h2><span>{items.length}本</span></div>{!readOnly && <div className="button-row">{items.length > 0 && <span className="certificate-status-key"><span aria-hidden="true" />印刷済み</span>}<button className="secondary-button certificate-create-button" type="button" disabled={certificateFlexconsFor(certificateSectionKind).length === 0} onClick={() => openCertificateDialog(certificateSectionKind)}><FileText size={18} />検査証明書作成</button></div>}</div>
    <div className="inspection-detail-table-wrap"><table className="inspection-detail-table" onKeyDownCapture={navigateInspectionField}>
      <thead><tr><th>№</th><th>年度</th><th>仕入日</th><th>仕切り書</th><th>検査日</th><th>検査員</th><th>検査場所</th><th>産地</th><th>銘柄</th><th>数量（kg）</th><th>水分</th><th>等級</th><th>理由</th>{!readOnly && <th></th>}</tr></thead>
      <tbody>{items.map((item) => <tr id={`inspection-record-${item.id}`} className={[(item.certificate_print_count ?? 0) > 0 ? 'certificate-printed-row' : '', !detailDrafts[item.id] && isInspectionResultComplete(item) ? 'inspection-complete-row' : '', selectedRecordTarget?.kind === 'flexcon' && highlightedRecordIds.has(item.id) ? 'inspection-target-row' : ''].filter(Boolean).join(' ') || undefined} title={(item.certificate_print_count ?? 0) > 0 ? `印刷済み（${item.certificate_print_count}回）` : '未印刷'} key={item.id}><td>{item.flexcon_no}</td>{readOnly ? renderReadOnlyMetadataFields(item) : renderInlineMetadataFields('flexcon', item)}{readOnly ? renderReadOnlyProductFields(item) : renderInlineProductFields('flexcon', item)}{readOnly ? renderReadOnlyResultFields(item) : renderInlineResultFields('flexcon', item)}{!readOnly && <td className="inspection-row-actions"><button className="icon-button delete-icon" type="button" title="削除" aria-label={`№${item.flexcon_no}を削除`} onClick={() => void deleteFlexcon(item)}><Trash2 size={17} /></button></td>}</tr>)}
      {items.length === 0 && <tr><td colSpan={readOnly ? 13 : 14} className="empty-state">登録されていません</td></tr>}
      </tbody>
    </table>{renderDetailAddition(certificateSectionKind)}</div>
  </section>

  if (!selectedAuthorization) {
    return <div className="inspection-page">
      <div className="page-heading inspection-summary-heading"><p>生産者詳細で追加した順番に検査記録を表示します。</p><div className="inspection-summary-heading-actions"><button className="secondary-button inspection-summary-add-button" type="button" title={summaryView === 'list' ? '一覧の絞り込みをクリア' : '集計の絞り込みをクリア'} disabled={summaryView === 'list' ? !hasSummaryFilters : !hasAggregateFilters} onClick={summaryView === 'list' ? clearSummaryFilters : clearAggregateFilters}><FilterX size={16} />絞り込み解除</button>{summaryView === 'list' && !readOnly && <button className={`inspection-summary-add-button ${addGroupFormOpen ? 'secondary-button' : 'primary-button'}`} type="button" aria-expanded={addGroupFormOpen} onClick={toggleAddGroupForm}>{addGroupFormOpen ? <><X size={16} />閉じる</> : <><Plus size={16} />追加</>}</button>}</div></div>
      <div className="inspection-record-tabs inspection-summary-tabs" role="tablist" aria-label="検査記録の表示">
        <button type="button" role="tab" aria-selected={summaryView === 'list'} className={summaryView === 'list' ? 'active' : ''} onClick={() => setSummaryView('list')}><List size={18} />一覧</button>
        <button type="button" role="tab" aria-selected={summaryView === 'aggregate'} className={summaryView === 'aggregate' ? 'active' : ''} onClick={() => { setProducerPickerOpen(false); setAddGroupFormOpen(false); setSummaryView('aggregate') }}><BarChart3 size={18} />集計</button>
      </div>
      {summaryView === 'list' && <>
      {!readOnly && addGroupFormOpen && <form className="inspection-group-add inspection-summary-add section-band" noValidate onSubmit={(event) => void addInspectionGroup(event)}>
        {notice?.type === 'error' && <div className="notice error" role="alert">{notice.text}</div>}
        <div className="inspection-producer-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setProducerPickerOpen(false) }}>
          <label>生産者名<input className={!addAuthorization ? 'inspection-missing' : undefined} value={addGroupForm.producer_name} onFocus={() => setProducerPickerOpen(true)} onChange={(event) => { const producerName = event.target.value; const exactMatches = authorizations.filter((item) => item.full_name.trim() === producerName.trim()); setAddGroupForm((current) => ({ ...current, authorization_id: exactMatches.length === 1 ? exactMatches[0].id : '', producer_name: producerName, brand: '', flexcon_quantity_kg: null })); setProducerPickerOpen(true) }} placeholder="氏名・委任状No.で絞り込み" autoComplete="off" role="combobox" aria-expanded={producerPickerOpen} aria-controls="inspection-producer-candidates" required /></label>
          {producerPickerOpen && <div id="inspection-producer-candidates" className="inspection-producer-candidates" role="listbox">
            {producerCandidates.map((item) => <button type="button" role="option" aria-selected={item.id === addGroupForm.authorization_id} key={item.id} onClick={() => { setAddGroupForm((current) => ({ ...current, authorization_id: item.id, producer_name: item.full_name, brand: '', flexcon_quantity_kg: null })); setProducerPickerOpen(false) }}><span>No. {item.authorization_no}</span><strong>{item.full_name}<small>{item.address?.trim() || [formatPrefectureName(item.prefecture), item.municipality].filter(Boolean).join(' ') || '住所未登録'}</small></strong></button>)}
            {producerCandidates.length === 0 && <span className="empty-state">該当する生産者がありません</span>}
          </div>}
        </div>
        {renderAdditionFields(addGroupForm, (values) => setAddGroupForm((current) => ({ ...current, ...values })), addAuthorization)}
        <button className="primary-button" type="submit" disabled={busy}><Plus size={18} />{busy ? '追加中...' : '追加'}</button>
      </form>}
      </>}
      {summaryView === 'aggregate' && <section className="inspection-progress-section inspection-summary-aggregate section-band">
        <div className="section-title">
          <div><h2>検査数量</h2><span>産年・産地・銘柄別</span></div>
          <div className="inspection-progress-period">
            <label>基準<select aria-label="期間の基準日" value={inspectionPeriod.basis} onChange={(event) => changeInspectionPeriod({ basis: event.target.value as InspectionPeriod['basis'] })}><option value="inspection">検査日</option><option value="purchase">仕入日</option></select></label>
            <label>開始<JapaneseDateInput value={inspectionPeriod.start} aria-label="期間の開始日" onChange={(start) => changeInspectionPeriod({ start })} /></label>
            <label>終了<JapaneseDateInput value={inspectionPeriod.end} aria-label="期間の終了日" onChange={(end) => changeInspectionPeriod({ end })} /></label>
            <button className="icon-button" type="button" title="期間をクリア" aria-label="期間をクリア" disabled={!inspectionPeriod.start && !inspectionPeriod.end} onClick={() => changeInspectionPeriod({ start: '', end: '' })}><X size={17} /></button>
          </div>
          <div className="inspection-progress-totals"><span>検査済み <strong>{inspectionProgressTotals.inspected.toLocaleString()}kg</strong></span><span>未検査 <strong>{inspectionProgressTotals.uninspected.toLocaleString()}kg</strong></span></div>
        </div>
        {invalidInspectionPeriod && <div className="inline-error" role="alert">開始日は終了日以前にしてください。</div>}
        {renderInspectionAggregate('flexcon', 'フレコン')}
        {renderInspectionAggregate('paper', '紙袋')}
      </section>}
      {summaryView === 'list' && <div className="inspection-summary-wrap" ref={summaryWrapRef} onScroll={rememberSummaryPosition}><table className="inspection-summary-table">
        <thead><tr>{SUMMARY_COLUMNS.map((column) => <InspectionSummaryColumnHeader key={column.key} column={column} sort={summarySort} values={summaryFilterValues[column.key]} selectedValues={summaryColumnFilters[column.key]} textValue={summaryTextFilters[column.key] ?? ''} onSort={changeSummarySort} onFilterChange={changeSummaryColumnFilter} onTextChange={changeSummaryTextFilter} />)}{!readOnly && <th className="inspection-summary-actions-heading">操作</th>}</tr></thead>
        <tbody>{displayedSummary.map((row, index) => <tr className={index > 0 && displayedSummary[index - 1].registrationId !== row.registrationId ? 'inspection-summary-registration-start' : undefined} key={row.groupKey} tabIndex={0} onClick={() => openSummaryRecord(row)} onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) openSummaryRecord(row) }}>
          <td><span className={`inspection-completion-status ${row.inspectionStatus === '完了' ? 'complete' : 'incomplete'}`}>{row.inspectionStatus === '完了' ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}{row.inspectionStatus}</span></td>
          <td className="numeric-cell">{row.authorizationNo}</td><td>{row.settlementNo}</td><td>{row.purchaseDates}</td><td>{row.inspectionDates}</td><td><strong>{row.fullName}</strong></td><td>{row.origin}</td><td>{row.municipality}</td><td>{row.inspectionLocations}</td><td>{row.brands}</td><td>{inspectionSummaryKindLabel(row.recordKind)}</td><td>{row.grade}</td><td className="numeric-cell">{row.flexconCount.toLocaleString()}本</td><td className="numeric-cell">{row.paperBagCount.toLocaleString()}袋</td><td className="numeric-cell">{row.bulkQuantity.toLocaleString()}kg</td><td className="inspection-progress-inspected numeric-cell">{row.inspectedQuantity.toLocaleString()}kg</td><td className="inspection-progress-uninspected numeric-cell">{row.uninspectedQuantity.toLocaleString()}kg</td>
          {!readOnly && <td className="inspection-summary-actions"><button className="icon-button delete-icon" type="button" title={row.partialPeriodGroup ? '期間外の同じグループがあります。明細から削除してください。' : 'この行だけを削除'} aria-label={`${row.fullName}・${row.inspectionDates || '検査日未設定'}・${row.brands || '銘柄未設定'}・${inspectionSummaryKindLabel(row.recordKind)}の行を削除`} disabled={busy || row.partialPeriodGroup} onClick={(event) => { event.stopPropagation(); void deleteInspectionRegistration(row) }}><Trash2 size={17} /></button></td>}
        </tr>)}
        {displayedSummary.length === 0 && <tr><td colSpan={SUMMARY_COLUMNS.length + (readOnly ? 0 : 1)} className="empty-state">該当する検査記録はありません</td></tr>}</tbody>
      </table></div>}
      {notice && <div className={`notice operation-log ${notice.type}`}>{notice.text}</div>}
    </div>
  }

  return <div className="producer-inspection-page">
    <div className="producer-inspection-heading">
      <button className="icon-button" type="button" title={readOnly ? '委任状一覧へ戻る' : '検査記録へ戻る'} aria-label={readOnly ? '委任状一覧へ戻る' : '検査記録へ戻る'} onClick={onBack}><ArrowLeft size={21} /></button>
      <div><h1>{selectedAuthorization.full_name}</h1><p>委任状№ {selectedAuthorization.authorization_no}　{[selectedAuthorization.prefecture, selectedAuthorization.municipality].filter(Boolean).join(' ')}{!readOnly && selectedRegistration ? `　登録No. ${selectedRegistration.registration_no}` : ''}　全期間の明細</p></div>
      {readOnly && <div className="producer-inspection-actions">
        <button className="secondary-button" type="button" onClick={() => void createInspectionLedgerPdf()} disabled={inspectionLedgerBusy || gradingNoticeBusy}><ClipboardList size={18} />{inspectionLedgerBusy ? 'PDF作成中...' : '検査請求者別検査台帳'}</button>
        <button className="secondary-button" type="button" onClick={() => void createGradingNoticePdf()} disabled={gradingNoticeBusy || inspectionLedgerBusy}><FileText size={18} />{gradingNoticeBusy ? 'PDF作成中...' : '格付結果通知票'}</button>
      </div>}
    </div>
    {!readOnly && selectedRegistration && <section className="section-band inspection-batch-metadata">
      <form className="inspection-batch-metadata-form" onSubmit={(event) => void applyBatchMetadata(event)}>
        <h2>一括設定</h2>
        <label className="batch-target">対象<select aria-label="対象" value={batchMetadata.target_kind} disabled={batchMetadataBusy} onChange={(event) => changeBatchMetadata({ target_kind: event.target.value as BatchInspectionMetadata['target_kind'], start_no: '', end_no: '', grade: '' })}><option value="all">推フレ・紙袋</option><option value="standard">推フレ</option><option value="paper">紙袋</option></select></label>
        <label className="batch-date-scope">対象検査日<select aria-label="対象検査日" value={batchMetadata.date_scope} disabled={batchMetadataBusy} onChange={(event) => changeBatchMetadata({ date_scope: event.target.value, grade: '' })}><option value="all">全体</option>{batchDateOptions.map((date) => <option key={date} value={date}>{displayDate(date)}</option>)}{batchHasUndated && <option value="undated">未設定</option>}</select></label>
        <div className="batch-number-range"><label>№<input aria-label="開始№" type="text" inputMode="numeric" value={batchMetadata.start_no} disabled={batchMetadataBusy || batchMetadata.target_kind !== 'standard'} onChange={(event) => changeBatchMetadata({ start_no: event.target.value, grade: '' })} /></label><span>～</span><input aria-label="終了№" type="text" inputMode="numeric" value={batchMetadata.end_no} disabled={batchMetadataBusy || batchMetadata.target_kind !== 'standard'} onChange={(event) => changeBatchMetadata({ end_no: event.target.value, grade: '' })} /></div>
        <label>検査日<JapaneseDateInput value={batchMetadata.inspection_date} placeholder="変更なし" disabled={batchMetadataBusy} onChange={(inspection_date) => changeBatchMetadata({ inspection_date })} /></label>
        <label>検査員<select value={batchMetadata.inspector_name} disabled={batchMetadataBusy} onChange={(event) => changeBatchMetadata({ inspector_name: event.target.value })}><option value="">変更なし</option>{inspectorOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></label>
        <label>検査場所<select value={batchMetadata.inspection_location} disabled={batchMetadataBusy} onChange={(event) => changeBatchMetadata({ inspection_location: event.target.value })}><option value="">変更なし</option>{locationOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></label>
        <label>等級<select value={batchMetadata.grade} disabled={batchMetadataBusy} onChange={(event) => changeBatchMetadata({ grade: event.target.value })}><option value="">変更なし</option>{batchGradeOptions.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></label>
        <label className="batch-overwrite"><input type="checkbox" checked={batchMetadata.overwrite} disabled={batchMetadataBusy} onChange={(event) => changeBatchMetadata({ overwrite: event.target.checked, grade: '' })} />上書きする</label>
        <button className="primary-button" type="submit" disabled={batchMetadataBusy}><Save size={16} />{batchMetadataBusy ? '設定中...' : 'まとめて反映'}</button>
      </form>
    </section>}
    {renderFlexconSection('推フレ', selectedStandardFlexcons, 'standard')}
    {renderFlexconSection('バラ', selectedBulkFlexcons, 'bulk')}
    {(selectedPaperBags.length > 0 || (!readOnly && selectedRegistration)) && <section className="section-band inspection-detail-section">
      <div className="section-title"><div><h2>紙袋</h2><span>{selectedPaperBags.reduce((total, item) => total + item.bag_count, 0).toLocaleString()}袋 / {selectedPaperBags.length.toLocaleString()}件</span></div></div>
      <div className="inspection-detail-table-wrap"><table className="inspection-detail-table paper-detail-table" onKeyDownCapture={navigateInspectionField}>
        <thead><tr><th>年度</th><th>仕入日</th><th>仕切り書</th><th>検査日</th><th>検査員</th><th>検査場所</th><th>産地</th><th>銘柄</th><th>数量（袋）</th><th>総重量</th><th>水分</th><th>等級</th><th>理由</th>{!readOnly && <th></th>}</tr></thead>
        <tbody>{selectedPaperBags.map((item) => <tr id={`inspection-record-${item.id}`} className={[!detailDrafts[item.id] && isInspectionResultComplete(item) ? 'inspection-complete-row' : '', selectedRecordTarget?.kind === 'paper' && highlightedRecordIds.has(item.id) ? 'inspection-target-row' : ''].filter(Boolean).join(' ') || undefined} key={item.id}>{readOnly ? renderReadOnlyMetadataFields(item) : renderInlineMetadataFields('paper', item)}{readOnly ? renderReadOnlyProductFields(item) : renderInlineProductFields('paper', item)}<td>{(item.bag_count * 30).toLocaleString()}kg</td>{readOnly ? renderReadOnlyResultFields(item) : renderInlineResultFields('paper', item)}{!readOnly && <td className="inspection-row-actions inspection-row-actions-wide"><button className="icon-button" type="button" title="2行に分割" aria-label={`${item.brand ?? ''}の紙袋を2行に分割`} disabled={busy || item.bag_count < 2} onClick={() => beginSplitPaperBags(item)}><TableRowsSplit size={17} /></button><button className="icon-button delete-icon" type="button" title="削除" aria-label={`${item.brand ?? ''}の紙袋を削除`} onClick={() => void deletePaperBags(item)}><Trash2 size={17} /></button></td>}</tr>)}
        {selectedPaperBags.length === 0 && <tr><td colSpan={readOnly ? 13 : 14} className="empty-state">登録されていません</td></tr>}
        </tbody>
      </table>{renderDetailAddition('paper')}</div>
    </section>}
    {!readOnly && certificateDialogOpen && <div className="modal-backdrop"><section className="registration-modal certificate-modal" role="dialog" aria-modal="true" aria-labelledby="certificate-dialog-title">
      <div className="modal-header"><div><h2 id="certificate-dialog-title">検査証明書作成</h2><p>{certificateKind === 'bulk' ? 'バラ' : '推フレ'}　{selectedAuthorization.full_name}　委任状№ {selectedAuthorization.authorization_no}</p></div><button className="icon-button" type="button" title="閉じる" aria-label="閉じる" onClick={closeCertificateDialog} disabled={certificateBusy}><X size={20} /></button></div>
      {!generatedCertificate ? <form className="certificate-range-form" onSubmit={(event) => void createCertificatePdf(event)}>
        <div className="certificate-range-fields">
          <label>開始№<input type="number" min="1" step="1" value={certificateRange.start} onChange={(event) => setCertificateRange((current) => ({ ...current, start: event.target.value }))} required autoFocus /></label>
          <span aria-hidden="true">から</span>
          <label>枚数<input type="number" min="1" step="1" value={certificateRange.count} onChange={(event) => setCertificateRange((current) => ({ ...current, count: event.target.value }))} required /></label>
        </div>
        {isAdmin && <div className="switch-field"><span>QRコードを付ける</span><ToggleSwitch checked={certificateManagementQr} label="QRコードを付ける" onChange={() => setCertificateManagementQr((current) => !current)} disabled={certificateBusy} /></div>}
        <div className="certificate-range-summary">{!certificateRange.start && !certificateRange.count && certificateFlexconsFor(certificateKind).every((item) => (item.certificate_print_count ?? 0) > 0) ? 'すべて印刷済み' : <>対象 {certificateTargets().length}本　印刷済み {certificateTargets().filter((item) => (item.certificate_print_count ?? 0) > 0).length}本</>}</div>
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
