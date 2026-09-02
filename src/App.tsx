import { useEffect, useState } from 'react'
import { FileSignature, History, LogOut, MapPinned, ScanLine, Truck, Wheat } from 'lucide-react'
import { AuthScreen } from './components/AuthScreen'
import { AuthorizationManager } from './components/AuthorizationManager'
import { DestinationManager } from './components/DestinationManager'
import { ShipmentHistory } from './components/ShipmentHistory'
import { ShipmentScanner } from './components/ShipmentScanner'
import { TransportManager } from './components/TransportManager'
import { clearWorkerSession, restoreWorkerSession } from './lib/workerAuth'
import type { Worker } from './types'
import './App.css'

type Tab = 'scan' | 'history' | 'destinations' | 'transport' | 'authorizations'

function App() {
  const [worker, setWorker] = useState<Worker | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('scan')
  const [historyVersion, setHistoryVersion] = useState(0)

  useEffect(() => {
    void restoreWorkerSession()
      .then(setWorker)
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <main className="loading-screen">
        <Wheat size={34} aria-hidden="true" />
        <span>読み込み中...</span>
      </main>
    )
  }

  if (!worker) return <AuthScreen onLogin={setWorker} />

  const logout = () => {
    clearWorkerSession()
    setWorker(null)
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark"><Wheat size={21} aria-hidden="true" /></span>
          <div>
            <strong>フレコントレース</strong>
            <small>玄米出荷管理 / {worker.worker_name}</small>
          </div>
        </div>
        <button
          className="icon-button"
          type="button"
          title="ログアウト"
          aria-label="ログアウト"
          onClick={logout}
        >
          <LogOut size={20} />
        </button>
      </header>

      <main className="app-main">
        {tab === 'scan' && (
          <ShipmentScanner
            workerId={worker.worker_id}
            workerName={worker.worker_name}
            onRegistered={() => setHistoryVersion((value) => value + 1)}
          />
        )}
        {tab === 'history' && <ShipmentHistory refreshKey={historyVersion} workerId={worker.worker_id} isAdmin={worker.role === 'admin'} />}
        {tab === 'destinations' && <DestinationManager workerId={worker.worker_id} />}
        {tab === 'transport' && <TransportManager workerId={worker.worker_id} />}
        {tab === 'authorizations' && <AuthorizationManager workerId={worker.worker_id} />}
      </main>

      <nav className="bottom-nav" aria-label="メインメニュー">
        <button className={tab === 'scan' ? 'active' : ''} onClick={() => setTab('scan')}>
          <ScanLine size={22} /><span>QR読取</span>
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <History size={22} /><span>出荷履歴</span>
        </button>
        <button className={tab === 'destinations' ? 'active' : ''} onClick={() => setTab('destinations')}>
          <MapPinned size={22} /><span>納品先</span>
        </button>
        <button className={tab === 'transport' ? 'active' : ''} onClick={() => setTab('transport')}>
          <Truck size={22} /><span>運送会社</span>
        </button>
        <button className={tab === 'authorizations' ? 'active' : ''} onClick={() => setTab('authorizations')}>
          <FileSignature size={22} /><span>委任状一覧</span>
        </button>
      </nav>
    </div>
  )
}

export default App
