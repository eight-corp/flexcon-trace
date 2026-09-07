import { useEffect, useState } from 'react'
import { Blend, ClipboardList, FileSignature, History, LogOut, ScanLine, Settings2, Wheat } from 'lucide-react'
import { AuthScreen } from './components/AuthScreen'
import { AuthorizationManager } from './components/AuthorizationManager'
import { InspectionRecordManager, type InspectionRecordTarget } from './components/InspectionRecordManager'
import { InspectionOptionManager } from './components/InspectionOptionManager'
import { MixedFlexconManager } from './components/MixedFlexconManager'
import { ShipmentHistory } from './components/ShipmentHistory'
import { ShipmentScanner } from './components/ShipmentScanner'
import { clearWorkerSession, restoreWorkerSession } from './lib/workerAuth'
import type { Worker } from './types'
import './App.css'

type Tab = 'scan' | 'history' | 'authorizations' | 'inspections' | 'master'
type InspectionView = 'single' | 'mixed'

function App() {
  const [worker, setWorker] = useState<Worker | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('scan')
  const [historyVersion, setHistoryVersion] = useState(0)
  const [inspectionAuthorizationId, setInspectionAuthorizationId] = useState<string | null>(null)
  const [inspectionRecordTarget, setInspectionRecordTarget] = useState<InspectionRecordTarget | null>(null)
  const [inspectionView, setInspectionView] = useState<InspectionView>('single')

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
            <strong>(株)エイト 米穀出荷管理</strong>
            <small>作業者 / {worker.worker_name}</small>
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

      <main className={`app-main ${tab === 'history' || tab === 'authorizations' || tab === 'inspections' ? 'app-main-wide' : ''}`}>
        {tab === 'scan' && (
          <ShipmentScanner
            key={worker.worker_id}
            workerId={worker.worker_id}
            workerName={worker.worker_name}
            onRegistered={() => setHistoryVersion((value) => value + 1)}
          />
        )}
        {tab === 'history' && <ShipmentHistory refreshKey={historyVersion} workerId={worker.worker_id} isAdmin={worker.role === 'admin'} />}
        {tab === 'authorizations' && (
          <AuthorizationManager
            workerId={worker.worker_id}
            onOpenInspections={(authorizationId) => {
              setInspectionAuthorizationId(authorizationId)
              setInspectionRecordTarget(null)
              setInspectionView('single')
              setTab('inspections')
            }}
          />
        )}
        {tab === 'inspections' && (
          <div className="inspection-workspace">
            <div className="inspection-record-tabs" role="tablist" aria-label="検査記録の種類">
              <button type="button" role="tab" aria-selected={inspectionView === 'single'} className={inspectionView === 'single' ? 'active' : ''} onClick={() => setInspectionView('single')}><ClipboardList size={18} />単一フレコン</button>
              <button type="button" role="tab" aria-selected={inspectionView === 'mixed'} className={inspectionView === 'mixed' ? 'active' : ''} onClick={() => { setInspectionRecordTarget(null); setInspectionView('mixed') }}><Blend size={18} />混在フレコン</button>
            </div>
            <div className="inspection-workspace-content">
              {inspectionView === 'single' ? (
                <InspectionRecordManager
                  key={inspectionAuthorizationId ?? 'inspection-summary'}
                  workerId={worker.worker_id}
                  selectedAuthorizationId={inspectionAuthorizationId}
                  selectedRecordTarget={inspectionRecordTarget}
                  onSelectedAuthorizationChange={setInspectionAuthorizationId}
                  onSelectedRecordTargetChange={setInspectionRecordTarget}
                />
              ) : <MixedFlexconManager workerId={worker.worker_id} />}
            </div>
          </div>
        )}
        {tab === 'master' && <InspectionOptionManager workerId={worker.worker_id} />}
      </main>

      <nav className="bottom-nav" aria-label="メインメニュー">
        <button className={tab === 'scan' ? 'active' : ''} onClick={() => setTab('scan')}>
          <ScanLine size={22} /><span>出荷作業</span>
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <History size={22} /><span>出荷履歴</span>
        </button>
        <button className={tab === 'authorizations' ? 'active' : ''} onClick={() => setTab('authorizations')}>
          <FileSignature size={22} /><span>委任状一覧</span>
        </button>
        <button className={tab === 'inspections' ? 'active' : ''} onClick={() => { setInspectionAuthorizationId(null); setInspectionRecordTarget(null); setInspectionView('single'); setTab('inspections') }}>
          <ClipboardList size={22} /><span>検査記録</span>
        </button>
        <button className={tab === 'master' ? 'active' : ''} onClick={() => setTab('master')}>
          <Settings2 size={22} /><span>マスタ</span>
        </button>
      </nav>
    </div>
  )
}

export default App
