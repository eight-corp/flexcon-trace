import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CalendarModeProvider } from './lib/calendarMode'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CalendarModeProvider><App /></CalendarModeProvider>
  </StrictMode>,
)
