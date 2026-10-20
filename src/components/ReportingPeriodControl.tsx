import { useState } from 'react'
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import { JapaneseDateInput } from './JapaneseDateInput'
import { useCalendarMode } from '../lib/calendarMode'
import { currentReportingPeriod, reportingYearPeriod, validReportingPeriod, type ReportingPeriod } from '../lib/reportingPeriod'

export function ReportingPeriodControl({ value, onChange }: { value: ReportingPeriod; onChange: (period: ReportingPeriod) => void }) {
  const { formatCropYear } = useCalendarMode()
  const [draft, setDraft] = useState(value)
  const currentYear = Number(currentReportingPeriod().start.slice(0, 4))
  const startYear = Number(value.start.slice(0, 4))
  const annualPeriod = reportingYearPeriod(startYear)
  const selectedYear = value.start === annualPeriod.start && value.end === annualPeriod.end ? startYear : null
  const selectValue = !value.start && !value.end ? 'all' : selectedYear === null ? 'custom' : String(selectedYear)
  const years = Array.from({ length: Math.max(currentYear + 2, selectedYear ?? 0) - Math.min(2019, selectedYear ?? 2019) + 1 }, (_, index) => Math.max(currentYear + 2, selectedYear ?? 0) - index)
  const change = (period: ReportingPeriod) => { setDraft(period); onChange(period) }
  const invalid = !validReportingPeriod(draft)
  return <div className="reporting-period-bar" role="region" aria-label="共通の表示期間">
    <div className="reporting-period-year">
      <span>表示期間</span>
      <button className="icon-button" type="button" aria-label="前年度" title="前年度" disabled={selectedYear === null} onClick={() => { if (selectedYear !== null) change(reportingYearPeriod(selectedYear - 1)) }}><ChevronLeft size={18} /></button>
      <select aria-label="表示年度" value={selectValue} onChange={event => {
        const selected = event.target.value
        if (selected === 'all') change({ start: '', end: '' })
        else if (selected !== 'custom') change(reportingYearPeriod(Number(selected)))
      }}>
        {years.map(year => <option key={year} value={year}>{formatCropYear(year).replace(/年産$/, '年度')}</option>)}
        <option value="all">全期間</option>
        <option value="custom" disabled>期間指定</option>
      </select>
      <button className="icon-button" type="button" aria-label="翌年度" title="翌年度" disabled={selectedYear === null} onClick={() => { if (selectedYear !== null) change(reportingYearPeriod(selectedYear + 1)) }}><ChevronRight size={18} /></button>
      <button className="icon-button" type="button" aria-label="今年度に戻す" title="今年度に戻す" onClick={() => change(currentReportingPeriod())}><RotateCcw size={16} /></button>
    </div>
    <div className="reporting-period-dates">
      <JapaneseDateInput aria-label="共通期間の開始日" placeholder="指定なし" value={draft.start} onChange={start => { const next = { ...draft, start }; setDraft(next); if (validReportingPeriod(next)) onChange(next) }} />
      <span>〜</span>
      <JapaneseDateInput aria-label="共通期間の終了日" placeholder="指定なし" value={draft.end} onChange={end => { const next = { ...draft, end }; setDraft(next); if (validReportingPeriod(next)) onChange(next) }} />
    </div>
    {invalid && <span className="reporting-period-error" role="alert">開始日は終了日以前にしてください。</span>}
  </div>
}
