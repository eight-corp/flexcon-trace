import { useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { formatJapaneseDate, JAPANESE_ERAS, parseJapaneseDate, type JapaneseEraName } from '../lib/japaneseEra'

type DateProps = {
  value: string
  onChange: (value: string) => void
  className?: string
  disabled?: boolean
  required?: boolean
  'aria-label'?: string
  'aria-invalid'?: boolean
}

export function JapaneseDateInput({ value, onChange, className, disabled, required, 'aria-label': ariaLabel, 'aria-invalid': ariaInvalid }: DateProps) {
  const [draft, setDraft] = useState<{ source: string; text: string; invalid: boolean } | null>(null)
  const text = draft?.source === value ? draft.text : formatJapaneseDate(value)
  const invalid = draft?.source === value && draft.invalid

  const commit = () => {
    if (!text.trim()) { setDraft(null); onChange(''); return }
    const date = parseJapaneseDate(text)
    if (!date) { setDraft({ source: value, text, invalid: true }); return }
    setDraft(null)
    if (date !== value) onChange(date)
  }

  return <span className={`japanese-date-input ${className ?? ''}`}>
    <input type="text" value={text} placeholder="令和8/09/24" aria-label={ariaLabel} aria-invalid={invalid || ariaInvalid} aria-required={required} disabled={disabled} onChange={(event) => setDraft({ source: value, text: event.target.value, invalid: false })} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} />
    <span className="japanese-date-picker"><CalendarDays size={17} aria-hidden="true" /><input type="date" value={value} aria-label={`${ariaLabel ?? '日付'}をカレンダーから選択`} tabIndex={0} disabled={disabled} onChange={(event) => { setDraft(null); onChange(event.target.value) }} /></span>
    {invalid && <span className="japanese-date-error" role="alert">和暦の日付を確認してください</span>}
  </span>
}

export function JapaneseDateTimeInput(props: DateProps) {
  const date = props.value.slice(0, 10)
  const time = props.value.slice(11, 16)
  return <span className={`japanese-datetime-input ${props.className ?? ''}`}>
    <JapaneseDateInput value={date} onChange={(next) => props.onChange(next ? `${next}T${time || '00:00'}` : '')} disabled={props.disabled} required={props.required} aria-label={props['aria-label']} aria-invalid={props['aria-invalid']} />
    <input type="time" value={time} aria-label="時刻" disabled={props.disabled} onChange={(event) => { if (date) props.onChange(`${date}T${event.target.value}`) }} />
  </span>
}

type YearProps = { value: string; onChange: (value: string) => void; disabled?: boolean; required?: boolean }

export function JapaneseCropYearInput({ value, onChange, disabled, required }: YearProps) {
  const year = Number(value)
  const era = JAPANESE_ERAS.find((item) => year >= item.firstYear) ?? JAPANESE_ERAS[0]
  const eraYear = value && year >= 1868 ? year - era.firstYear + 1 : ''
  const [emptyEra, setEmptyEra] = useState<JapaneseEraName>('令和')
  const selectedEra = value ? era.name : emptyEra
  const firstYear = JAPANESE_ERAS.find((item) => item.name === selectedEra)!.firstYear
  return <span className="japanese-crop-year-input"><select aria-label="元号" value={selectedEra} disabled={disabled} onChange={(event) => { const next = event.target.value as JapaneseEraName; setEmptyEra(next); if (eraYear) onChange(String(JAPANESE_ERAS.find((item) => item.name === next)!.firstYear + Number(eraYear) - 1)) }}>{JAPANESE_ERAS.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select><input type="number" min="1" max="99" step="1" inputMode="numeric" aria-label="産年" value={eraYear} disabled={disabled} required={required} onChange={(event) => onChange(event.target.value ? String(firstYear + Number(event.target.value) - 1) : '')} /><span>年産</span></span>
}
