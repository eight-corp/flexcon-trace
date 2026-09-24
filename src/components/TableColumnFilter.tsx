import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Filter } from 'lucide-react'

type FilterPosition = { top?: number; bottom?: number; left: number; maxHeight: number }

type Props = {
  label: string
  values: string[]
  selectedValues: string[] | undefined
  onChange: (values: string[] | undefined) => void
  openRight?: boolean
}

export function TableColumnFilter({ label, values, selectedValues, onChange, openRight = false }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<FilterPosition | null>(null)
  const allSelected = selectedValues === undefined || selectedValues.length === values.length

  useEffect(() => {
    if (!position) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !buttonRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setPosition(null)
    }
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      setPosition(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPosition(null)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('scroll', closeOnScroll, true)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('scroll', closeOnScroll, true)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', close)
    }
    function close() { setPosition(null) }
  }, [position])

  const toggle = () => {
    if (position) {
      setPosition(null)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(230, window.innerWidth - 16)
    const left = Math.min(Math.max(openRight ? rect.left : rect.right - width, 8), window.innerWidth - width - 8)
    const below = window.innerHeight - rect.bottom - 8
    const above = rect.top - 8
    const showAbove = below < 300 && above > below
    setPosition({
      left,
      maxHeight: Math.min(320, Math.max(80, showAbove ? above - 4 : below - 4)),
      ...(showAbove ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    })
  }

  return <div className={`shipment-column-filter ${selectedValues === undefined ? '' : 'active'}`}>
    <button ref={buttonRef} type="button" className="shipment-column-filter-trigger" title={`${label}を絞り込む`} aria-label={`${label}を絞り込む`} aria-expanded={position !== null} onClick={toggle}><Filter size={14} /></button>
    {position && createPortal(<div ref={menuRef} className="shipment-filter-menu shipment-filter-menu-floating" style={position}>
      <strong>{label}</strong>
      <label><input type="checkbox" checked={allSelected} onChange={() => onChange(allSelected ? [] : undefined)} />すべて</label>
      <div className="shipment-filter-values" style={{ maxHeight: Math.max(40, position.maxHeight - 92) }}>
        {values.map((value) => {
          const checked = selectedValues === undefined || selectedValues.includes(value)
          return <label key={value}>
            <input type="checkbox" checked={checked} onChange={() => {
              const current = selectedValues ?? values
              const next = checked ? current.filter((item) => item !== value) : [...current, value]
              onChange(next.length === values.length ? undefined : next)
            }} />
            {value || '（空白）'}
          </label>
        })}
      </div>
    </div>, document.body)}
  </div>
}
