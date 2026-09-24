import { createContext, useContext, useState, type ReactNode } from 'react'
import { formatDisplayCropYear, formatDisplayDate, formatDisplayDateTime, type CalendarMode } from './japaneseEra'

const STORAGE_KEY = 'flexcon-calendar-mode'

const CalendarModeContext = createContext<{
  mode: CalendarMode
  setMode: (mode: CalendarMode) => void
} | null>(null)

export function CalendarModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<CalendarMode>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'seireki' ? 'seireki' : 'wareki' } catch { return 'wareki' }
  })
  const setMode = (next: CalendarMode) => {
    setModeState(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* Browser storage may be unavailable. */ }
  }
  return <CalendarModeContext.Provider value={{ mode, setMode }}>{children}</CalendarModeContext.Provider>
}

export function useCalendarMode() {
  const context = useContext(CalendarModeContext)
  if (!context) throw new Error('CalendarModeProvider is required')
  return {
    ...context,
    formatDate: (value: string | null | undefined) => formatDisplayDate(value, context.mode),
    formatDateTime: (value: string | null | undefined) => formatDisplayDateTime(value, context.mode),
    formatCropYear: (value: number | string | null | undefined) => formatDisplayCropYear(value, context.mode),
  }
}
