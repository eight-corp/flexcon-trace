import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CalendarModeProvider } from './lib/calendarMode'
import { registerSW } from 'virtual:pwa-register'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CalendarModeProvider><App /></CalendarModeProvider>
  </StrictMode>,
)

registerSW({
  immediate: true,
  onRegisteredSW(_scriptUrl, registration) {
    if (!registration) return
    const checkForUpdates = () => {
      if (document.visibilityState === 'visible') void registration.update().catch(() => {})
    }
    checkForUpdates()
    document.addEventListener('visibilitychange', checkForUpdates)
  },
})
