import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Filter } from 'lucide-react'
import { matchesFilterText } from '../lib/tableFilters'

type FilterPosition = { top?: number; bottom?: number; left: number; width: number; maxHeight: number }

type Props = {
  label: string
  values: string[]
  selectedValues: string[] | undefined
  onChange: (values: string[] | undefined) => void
  textValue: string
  onTextChange: (value: string) => void
  openRight?: boolean
}

export function TableColumnFilter({ label, values, selectedValues, onChange, textValue, onTextChange, openRight = false }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<FilterPosition | null>(null)
  const visibleValues = values.filter((value) => matchesFilterText(value, textValue))
  const allSelected = visibleValues.length > 0 && visibleValues.every((value) => selectedValues === undefined || selectedValues.includes(value))
  const toggleAll = () => {
    const current = selectedValues ?? values
    const next = allSelected
      ? current.filter((value) => !visibleValues.includes(value))
      : [...new Set([...current, ...visibleValues])]
    onChange(next.length === values.length ? undefined : next)
  }

  const placeMenu = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewport = window.visualViewport
    const viewportLeft = viewport?.offsetLeft ?? 0
    const viewportTop = viewport?.offsetTop ?? 0
    const viewportWidth = viewport?.width ?? window.innerWidth
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight)
    const width = Math.min(230, viewportWidth - 16)
    const left = Math.min(Math.max(openRight ? rect.left : rect.right - width, viewportLeft + 8), viewportLeft + viewportWidth - width - 8)
    const below = viewportBottom - rect.bottom - 8
    const above = rect.top - viewportTop - 8
    const showAbove = below < 180 && above > below
    setPosition({
      left,
      width,
      maxHeight: Math.min(320, Math.max(80, showAbove ? above - 4 : below - 4)),
      ...(showAbove
        ? { bottom: Math.max(window.innerHeight - rect.top + 4, window.innerHeight - viewportBottom + 8) }
        : { top: Math.max(viewportTop + 8, Math.min(rect.bottom + 4, viewportBottom - 80)) }),
    })
  }, [openRight])

  useEffect(() => {
    if (!position) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !buttonRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setPosition(null)
    }
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      if (menuRef.current?.contains(document.activeElement)) {
        placeMenu()
        return
      }
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
    window.addEventListener('resize', placeMenu)
    window.visualViewport?.addEventListener('resize', placeMenu)
    window.visualViewport?.addEventListener('scroll', placeMenu)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('scroll', closeOnScroll, true)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', placeMenu)
      window.visualViewport?.removeEventListener('resize', placeMenu)
      window.visualViewport?.removeEventListener('scroll', placeMenu)
    }
  }, [position, placeMenu])

  const toggle = () => {
    if (position) {
      setPosition(null)
      return
    }
    placeMenu()
  }

  return <div className={`shipment-column-filter ${selectedValues === undefined && !textValue.trim() ? '' : 'active'}`}>
    <button ref={buttonRef} type="button" className="shipment-column-filter-trigger" title={`${label}を絞り込む`} aria-label={`${label}を絞り込む`} aria-expanded={position !== null} onClick={toggle}><Filter size={14} /></button>
    {position && createPortal(<div ref={menuRef} className="shipment-filter-menu shipment-filter-menu-floating" style={position}>
      <strong>{label}</strong>
      <input className="shipment-filter-search" type="search" value={textValue} onChange={(event) => onTextChange(event.target.value)} placeholder="文字で絞り込み" aria-label={`${label}を文字で絞り込む`} />
      <label><input type="checkbox" checked={allSelected} disabled={visibleValues.length === 0} onChange={toggleAll} />{textValue.trim() ? '一致した候補をすべて選択' : 'すべて'}</label>
      <div className="shipment-filter-values" style={{ maxHeight: Math.max(40, position.maxHeight - 132) }}>
        {visibleValues.map((value) => {
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
        {visibleValues.length === 0 && <span className="shipment-filter-empty">一致する候補がありません</span>}
      </div>
    </div>, document.body)}
  </div>
}
