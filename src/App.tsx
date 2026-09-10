import { useEffect, useState } from 'react'
import { ClipboardList, FileSignature, History, House, LogOut, ScanLine, Settings2, Wheat } from 'lucide-react'
import { AuthorizationManager } from './components/AuthorizationManager'
import { InspectionRecordManager, type InspectionRecordTarget } from './components/InspectionRecordManager'
import { InspectionOptionManager } from './components/InspectionOptionManager'
import { ShipmentHistory } from './components/ShipmentHistory'
import { ShipmentScanner } from './components/ShipmentScanner'
import { logoutBusinessSession, MANAGEMENT_MENU_URL, restoreBusinessSession } from './lib/businessAuth'
import type { Worker } from './types'
import './App.css'

type Tab = 'scan' | 'history' | 'authorizations' | 'inspections' | 'master'

function App() {
  const [worker, setWorker] = useState<Worker | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('scan')
  const [historyVersion, setHistoryVersion] = useState(0)
  const [inspectionAuthorizationId, setInspectionAuthorizationId] = useState<string | null>(null)
  const [inspectionRegistrationId, setInspectionRegistrationId] = useState<string | null>(null)
  const [inspectionRecordTarget, setInspectionRecordTarget] = useState<InspectionRecordTarget | null>(null)
  const [inspectionReadOnly, setInspectionReadOnly] = useState(false)

  useEffect(() => {
    void restoreBusinessSession()
      .then((sessionWorker) => {
        if (!sessionWorker) {
          window.location.replace(MANAGEMENT_MENU_URL)
          return
        }
        setWorker(sessionWorker)
        if (sessionWorker.role === 'viewer') setTab('history')
      })
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

  if (!worker) {
    return (
      <main className="loading-screen">
        <Wheat size={34} aria-hidden="true" />
        <span>業務管理メニューへ移動します...</span>
      </main>
    )
  }

  const logout = async () => {
    try { await logoutBusinessSession() } finally { window.location.replace(MANAGEMENT_MENU_URL) }
  }

  const returnToMenu = () => { window.location.href = MANAGEMENT_MENU_URL }
  const canOperate = worker.role !== 'viewer'
  const isAdmin = worker.role === 'admin'
  const roleName = isAdmin ? '管理者' : canOperate ? '作業者' : '閲覧者'

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark"><Wheat size={21} aria-hidden="true" /></span>
          <div>
            <strong>(株)エイト 米穀出荷管理</strong>
            <small>{roleName} / {worker.worker_name}</small>
          </div>
        </div>
        <div className="header-actions">
          <button className="menu-button" type="button" title="業務管理メニューへ" aria-label="業務管理メニューへ" onClick={returnToMenu}>
            <House size={20} />
            <span>メニュー</span>
          </button>
          <button className="icon-button" type="button" title="ログアウト" aria-label="ログアウト" onClick={() => void logout()}>
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className={`app-main ${tab === 'history' || tab === 'authorizations' || tab === 'inspections' ? 'app-main-wide' : ''}`}>
        {tab === 'scan' && canOperate && (
          <ShipmentScanner
            key={worker.worker_id}
            workerId={worker.worker_id}
            workerName={worker.worker_name}
            onRegistered={() => setHistoryVersion((value) => value + 1)}
          />
        )}
        {tab === 'history' && <ShipmentHistory refreshKey={historyVersion} workerId={worker.worker_id} isAdmin={worker.role === 'admin'} />}
        {tab === 'authorizations' && canOperate && (
          <AuthorizationManager
            workerId={worker.worker_id}
            onOpenInspections={(authorizationId) => {
              setInspectionAuthorizationId(authorizationId)
              setInspectionRegistrationId(null)
              setInspectionRecordTarget(null)
              setInspectionReadOnly(true)
              setTab('inspections')
            }}
          />
        )}
        {tab === 'inspections' && canOperate && (
          <div className="inspection-workspace">
            <div className="inspection-workspace-content">
              <InspectionRecordManager
                key={`${inspectionReadOnly ? 'readonly' : 'editable'}-${inspectionAuthorizationId ?? 'inspection-summary'}-${inspectionRegistrationId ?? 'all'}`}
                workerId={worker.worker_id}
                readOnly={inspectionReadOnly}
                selectedAuthorizationId={inspectionAuthorizationId}
                selectedRegistrationId={inspectionRegistrationId}
                selectedRecordTarget={inspectionRecordTarget}
                onSelectedAuthorizationChange={setInspectionAuthorizationId}
                onSelectedRegistrationChange={setInspectionRegistrationId}
                onSelectedRecordTargetChange={setInspectionRecordTarget}
                onBack={() => {
                  setInspectionAuthorizationId(null)
                  setInspectionRegistrationId(null)
                  setInspectionRecordTarget(null)
                  if (inspectionReadOnly) setTab('authorizations')
                }}
              />
            </div>
          </div>
        )}
        {tab === 'master' && isAdmin && <InspectionOptionManager workerId={worker.worker_id} />}
      </main>

      <nav className="bottom-nav" aria-label="メインメニュー" style={{ gridTemplateColumns: `repeat(${isAdmin ? 5 : canOperate ? 4 : 1}, 1fr)` }}>
        {canOperate && <button className={tab === 'scan' ? 'active' : ''} onClick={() => setTab('scan')}>
          <ScanLine size={22} /><span>出荷作業</span>
        </button>}
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <History size={22} /><span>出荷履歴</span>
        </button>
        {canOperate && <button className={tab === 'authorizations' ? 'active' : ''} onClick={() => setTab('authorizations')}>
          <FileSignature size={22} /><span>委任状一覧</span>
        </button>}
        {canOperate && <button className={tab === 'inspections' ? 'active' : ''} onClick={() => { setInspectionAuthorizationId(null); setInspectionRegistrationId(null); setInspectionRecordTarget(null); setInspectionReadOnly(false); setTab('inspections') }}>
          <ClipboardList size={22} /><span>検査記録</span>
        </button>}
        {isAdmin && <button className={tab === 'master' ? 'active' : ''} onClick={() => setTab('master')}>
          <Settings2 size={22} /><span>マスタ</span>
        </button>}
      </nav>
    </div>
  )
}

export default App
