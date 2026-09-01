import { supabase } from './supabase'
import type { Worker } from '../types'

const LOGIN_STORAGE_KEY = 'flexcon.workerLogin.v1'

export async function loadActiveWorkers(): Promise<Worker[]> {
  const { data, error } = await supabase
    .from('workers')
    .select('worker_id, worker_name, role, display_order, active, note')
    .eq('active', true)
    .order('display_order')
    .order('worker_id')

  if (error) throw error
  return (data ?? []) as Worker[]
}

export function getWorkerPin(worker: Worker): string {
  const match = worker.note.trim().match(/(?:PIN|pin|ＰＩＮ|暗証番号)\s*[:：=]\s*([0-9A-Za-z_-]+)/)
  return match?.[1] ?? ''
}

export function saveWorkerSession(worker: Worker): void {
  localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify({
    workerId: worker.worker_id,
    workerName: worker.worker_name,
    loggedInAt: new Date().toISOString(),
  }))
}

export function clearWorkerSession(): void {
  localStorage.removeItem(LOGIN_STORAGE_KEY)
}

export async function restoreWorkerSession(): Promise<Worker | null> {
  try {
    const saved = JSON.parse(localStorage.getItem(LOGIN_STORAGE_KEY) ?? '{}') as { workerId?: string }
    if (!saved.workerId) return null
    const workers = await loadActiveWorkers()
    const worker = workers.find((item) => item.worker_id === saved.workerId) ?? null
    if (!worker) clearWorkerSession()
    return worker
  } catch {
    clearWorkerSession()
    return null
  }
}
