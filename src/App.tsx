import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { History, LogOut, MapPinned, ScanLine, Wheat } from 'lucide-react'
import { AuthScreen } from './components/AuthScreen'
import { DestinationManager } from './components/DestinationManager'
import { ShipmentHistory } from './components/ShipmentHistory'
import { ShipmentScanner } from './components/ShipmentScanner'
import { supabase } from './lib/supabase'
import './App.css'

type Tab = 'scan' | 'history' | 'destinations'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('scan')
  const [historyVersion, setHistoryVersion] = useState(0)

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setLoading(false)
    })

    return () => data.subscription.unsubscribe()
  }, [])

  if (loading) {
    return (
      <main className="loading-screen">
        <Wheat size={34} aria-hidden="true" />
        <span>読み込み中...</span>
      </main>
    )
  }

  if (!session) return <AuthScreen />

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark"><Wheat size={21} aria-hidden="true" /></span>
          <div>
            <strong>フレコントレース</strong>
            <small>玄米出荷管理</small>
          </div>
        </div>
        <button
          className="icon-button"
          type="button"
          title="ログアウト"
          aria-label="ログアウト"
          onClick={() => void supabase.auth.signOut()}
        >
          <LogOut size={20} />
        </button>
      </header>

      <main className="app-main">
        {tab === 'scan' && (
          <ShipmentScanner
            userId={session.user.id}
            onRegistered={() => setHistoryVersion((value) => value + 1)}
          />
        )}
        {tab === 'history' && <ShipmentHistory refreshKey={historyVersion} />}
        {tab === 'destinations' && <DestinationManager userId={session.user.id} />}
      </main>

      <nav className="bottom-nav" aria-label="メインメニュー">
        <button className={tab === 'scan' ? 'active' : ''} onClick={() => setTab('scan')}>
          <ScanLine size={22} /><span>出荷読取</span>
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <History size={22} /><span>出荷履歴</span>
        </button>
        <button className={tab === 'destinations' ? 'active' : ''} onClick={() => setTab('destinations')}>
          <MapPinned size={22} /><span>納品先</span>
        </button>
      </nav>
    </div>
  )
}

export default App
