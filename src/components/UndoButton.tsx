import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Undo2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { BUSINESS_WRITES_CHANGED, pendingBusinessWrites, undoActionLabel, waitForBusinessWrites } from '../lib/businessOperations'
import { useCalendarMode } from '../lib/calendarMode'

type UndoStatus = { available: boolean; operationId?: string; action?: string; createdAt?: string; reason?: string }

export function UndoButton({ workerId, onUndone }: { workerId: string; onUndone: () => void }) {
  const { formatDateTime } = useCalendarMode()
  const [writes, setWrites] = useState(pendingBusinessWrites)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState<UndoStatus | null>(null)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const box = anchorRef.current?.getBoundingClientRect()
      if (box) setPosition((current) => current?.left === box.left && current?.top === box.top ? current : { left: box.left, top: box.top })
    }
    place()
    const observer = new ResizeObserver(place)
    if (anchorRef.current) observer.observe(anchorRef.current)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
    }
  }, [])
  useEffect(() => {
    const update = () => setWrites(pendingBusinessWrites())
    window.addEventListener(BUSINESS_WRITES_CHANGED, update)
    return () => window.removeEventListener(BUSINESS_WRITES_CHANGED, update)
  }, [])

  const prepare = async () => {
    if (busy || writes) return
    setBusy(true); setNotice(null)
    try {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      await waitForBusinessWrites()
      const { data, error } = await supabase.rpc('flexcon_get_undo_status', { p_worker_id: workerId })
      if (error) throw new Error(error.message)
      const status = data as UndoStatus
      if (!status?.available || !status.operationId) throw new Error(status?.reason || '取り消せる操作はありません。')
      setTarget(status)
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '取り消す操作を確認できませんでした。' })
    } finally { setBusy(false) }
  }

  const undo = async () => {
    if (busy || !target?.operationId) return
    setBusy(true)
    try {
      const { error } = await supabase.rpc('flexcon_undo_last_operation', { p_worker_id: workerId, p_operation_id: target.operationId })
      if (error) throw new Error(error.message)
      setTarget(null)
      onUndone()
      setNotice({ type: 'success', text: '直前の操作を取り消しました。' })
    } catch (error) {
      setTarget(null)
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '取り消しに失敗しました。' })
    } finally { setBusy(false) }
  }

  return <>
    <span className="global-undo-slot" ref={anchorRef} aria-hidden="true" />
    {position && createPortal(<button style={position} className="icon-button global-undo-button" type="button" title="直前の操作を取り消す" aria-label="直前の操作を取り消す" disabled={busy || writes > 0} onPointerDown={(event) => event.preventDefault()} onClick={() => void prepare()}><Undo2 size={20} /></button>, document.body)}
    {notice && createPortal(<div className={`notice ${notice.type} global-undo-notice`} role={notice.type === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" type="button" aria-label="通知を閉じる" title="閉じる" onClick={() => setNotice(null)}><X size={16} /></button></div>, document.body)}
    {target && createPortal(<div className="modal-backdrop global-undo-backdrop"><section className="registration-modal global-undo-modal" role="dialog" aria-modal="true" aria-labelledby="undo-title" onKeyDown={(event) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); setTarget(null) }
      if (event.key !== 'Tab') return
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const destination = event.shiftKey && document.activeElement === buttons[0] ? buttons.at(-1) : !event.shiftKey && document.activeElement === buttons.at(-1) ? buttons[0] : undefined
      if (destination) { event.preventDefault(); destination.focus() }
    }}>
      <div className="modal-header"><h2 id="undo-title">直前の操作を取り消す</h2><button className="icon-button" type="button" aria-label="取り消しを中止" title="閉じる" disabled={busy} onClick={() => setTarget(null)}><X size={20} /></button></div>
      <p>「{undoActionLabel(target.action ?? '')}」を取り消しますか？</p>
      {target.createdAt && <p>{formatDateTime(target.createdAt)}</p>}
      <p>入力中の画面も再読み込みされます。</p>
      <div className="button-row"><button className="secondary-button" type="button" autoFocus disabled={busy} onClick={() => setTarget(null)}>戻る</button><button className="primary-button" type="button" disabled={busy} onClick={() => void undo()}><Undo2 size={17} />{busy ? '取消中...' : '取り消す'}</button></div>
    </section></div>, document.body)}
  </>
}
