import { History, Truck } from 'lucide-react'
import { ShipmentHistory } from './ShipmentHistory'
import { ShipmentRecord } from './ShipmentRecord'

type Props = {
  view: 'register' | 'history'
  onViewChange: (view: 'register' | 'history') => void
  workerId: string
  workerName: string
  canOperate: boolean
  isAdmin: boolean
  refreshKey: number
  onRegistered: () => void
  onOpenQrScanner?: () => void
}

export function ShipmentWorkspace({ view, onViewChange, workerId, workerName, canOperate, isAdmin, refreshKey, onRegistered, onOpenQrScanner }: Props) {
  return <>
    <div className="shipment-record-tabs" role="tablist" aria-label="出荷記録の表示" onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
      if (current < 0) return
      event.preventDefault()
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      tabs[index].focus()
      tabs[index].click()
    }}>
      {canOperate && <button id="shipment-register-tab" type="button" role="tab" aria-controls="shipment-register-panel" aria-selected={view === 'register'} tabIndex={view === 'register' ? 0 : -1} className={view === 'register' ? 'active' : ''} onClick={() => onViewChange('register')}><Truck size={18} />登録</button>}
      <button id="shipment-history-tab" type="button" role="tab" aria-controls="shipment-history-panel" aria-selected={view === 'history'} tabIndex={view === 'history' ? 0 : -1} className={view === 'history' ? 'active' : ''} onClick={() => onViewChange('history')}><History size={18} />履歴</button>
    </div>
    {canOperate && <div id="shipment-register-panel" role="tabpanel" aria-labelledby="shipment-register-tab" hidden={view !== 'register'}>
      <ShipmentRecord workerId={workerId} workerName={workerName} onRegistered={onRegistered} onOpenQrScanner={onOpenQrScanner} />
    </div>}
    <div id="shipment-history-panel" role="tabpanel" aria-labelledby="shipment-history-tab" hidden={view !== 'history'}>
      <ShipmentHistory active={view === 'history'} refreshKey={refreshKey} workerId={workerId} canEdit={canOperate} isAdmin={isAdmin} />
    </div>
  </>
}
