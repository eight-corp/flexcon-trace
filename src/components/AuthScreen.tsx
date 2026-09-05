import { useEffect, useState } from 'react'
import { LogIn, Wheat } from 'lucide-react'
import { getWorkerPin, loadActiveWorkers, saveWorkerSession } from '../lib/workerAuth'
import type { Worker } from '../types'

export function AuthScreen({ onLogin }: { onLogin: (worker: Worker) => void }) {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [workerId, setWorkerId] = useState('')
  const [pin, setPin] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    void loadActiveWorkers()
      .then((items) => {
        setWorkers(items)
        setWorkerId(items[0]?.worker_id ?? '')
        if (items.length === 0) setMessage('利用可能な作業者が登録されていません。')
      })
      .catch(() => setMessage('作業者一覧を取得できません。Supabaseの設定を確認してください。'))
      .finally(() => setBusy(false))
  }, [])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setMessage('')
    const worker = workers.find((item) => item.worker_id === workerId)
    if (!worker) return setMessage('作業者を選択してください。')
    const configuredPin = getWorkerPin(worker)
    if (!configuredPin) return setMessage('この作業者にはPINが設定されていません。にんにく冷蔵庫管理の作業者マスタで設定してください。')
    if (!pin.trim()) return setMessage('PINを入力してください。')
    if (pin.trim() !== configuredPin) return setMessage('PINが違います。')
    saveWorkerSession(worker)
    setPin('')
    onLogin(worker)
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-brand">
          <span className="brand-mark"><Wheat size={22} /></span>
          <div><h1>(株)エイト 米穀出荷管理</h1><p>玄米フレコン出荷管理</p></div>
        </div>
        {message && <div className="notice error">{message}</div>}
        <form className="form-grid" onSubmit={submit}>
          <label>作業者
            <select value={workerId} onChange={(e) => setWorkerId(e.target.value)} disabled={busy || workers.length === 0} required>
              {workers.map((worker) => <option key={worker.worker_id} value={worker.worker_id}>{worker.worker_name}</option>)}
            </select>
          </label>
          <label>PIN<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="current-password" required /></label>
          <button className="primary-button full-width" type="submit" disabled={busy || workers.length === 0}>
            <LogIn size={19} />
            {busy ? '読み込み中...' : 'ログイン'}
          </button>
        </form>
      </section>
    </main>
  )
}
