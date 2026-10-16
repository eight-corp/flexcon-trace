import { useLayoutEffect, useRef, useState, type InputHTMLAttributes } from 'react'
import { formatInspectionMoisture, formatInspectionQuantity } from '../lib/inspectionNumberFormat'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'> & {
  value: string
  format: 'moisture' | 'quantity'
  onValueChange: (value: string) => void
}

export function InspectionNumberInput({ value, format, onValueChange, onBlur, ...props }: Props) {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const caretRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const position = caretRef.current
    if (position !== null && inputRef.current === document.activeElement) inputRef.current?.setSelectionRange(position, position)
    caretRef.current = null
  })
  const displayValue = format === 'moisture' ? formatInspectionMoisture(value) : formatInspectionQuantity(value)
  return <input {...props} ref={inputRef} type="text" inputMode={format === 'moisture' ? 'decimal' : 'numeric'}
    value={editing ? value : displayValue}
    onBlur={(event) => { setEditing(false); onBlur?.(event) }}
    onChange={(event) => {
      const input = event.currentTarget
      if (format === 'quantity') caretRef.current = input.value.slice(0, input.selectionStart ?? 0).replaceAll(',', '').length
      setEditing(true)
      onValueChange(format === 'quantity' ? input.value.replaceAll(',', '') : input.value)
    }}
  />
}
