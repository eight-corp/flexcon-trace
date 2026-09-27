import type { Worker } from '../types'

const STORAGE_KEY = 'business.session.v1'
const nativeFetch = window.fetch.bind(window)

export const MANAGEMENT_MENU_URL = 'https://eight-corp.github.io/garlic-liff-scanner/menu.html?openExternalBrowser=1'

type BusinessSession = {
  ok: boolean
  error?: string
  workerId: string
  workerName: string
  permissions: Record<string, Worker['role']>
}

class InvalidBusinessSessionError extends Error {}

function getToken(): string {
  try { return localStorage.getItem(STORAGE_KEY) ?? '' } catch { return '' }
}

function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

async function rpc<T>(name: string): Promise<T> {
  if (!supabaseUrl || !supabasePublishableKey) throw new Error('Supabaseの設定がありません。')
  const headers = new Headers({
    apikey: supabasePublishableKey,
    Authorization: `Bearer ${supabasePublishableKey}`,
    'Content-Type': 'application/json',
  })
  const token = getToken()
  if (token) headers.set('x-business-session', token)
  const response = await nativeFetch(`${supabaseUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: '{}' })
  const data = await response.json() as T & { ok?: boolean, error?: string, message?: string }
  if (response.ok && data.ok === false && name === 'business_session') {
    throw new InvalidBusinessSessionError(data.error ?? 'ログインしてください。')
  }
  if (!response.ok || data.ok === false) throw new Error(data.error ?? data.message ?? '認証を確認できません。')
  return data
}

export const businessAuthorizedFetch: typeof fetch = async (input, init = {}) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const token = getToken()
  if (token && supabaseUrl) {
    const target = new URL(input instanceof Request ? input.url : String(input), location.href)
    if (target.origin === new URL(supabaseUrl).origin) headers.set('x-business-session', token)
  }
  return nativeFetch(input, { ...init, headers })
}

export async function restoreBusinessSession(appId: 'rice_shipping' | 'purchase_statements' = 'rice_shipping'): Promise<Worker | null> {
  if (!getToken()) return null
  try {
    const session = await rpc<BusinessSession>('business_session')
    const role = session.permissions?.[appId]
    if (!role) return null
    return {
      worker_id: session.workerId,
      worker_name: session.workerName,
      role,
      display_order: 0,
      active: true,
      note: '',
    }
  } catch (error) {
    if (error instanceof InvalidBusinessSessionError) {
      setToken('')
      return null
    }
    throw error
  }
}

export function maintainBusinessSession(): () => void {
  let pending = false
  const renew = async () => {
    if (pending || document.visibilityState !== 'visible' || !getToken()) return
    pending = true
    try { await rpc<BusinessSession>('business_session') } catch {
      // Keep the current form mounted, including during a network interruption.
    } finally { pending = false }
  }
  const timer = window.setInterval(() => void renew(), 5 * 60 * 1000)
  const onResume = () => { void renew() }
  document.addEventListener('visibilitychange', onResume)
  window.addEventListener('online', onResume)
  return () => {
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', onResume)
    window.removeEventListener('online', onResume)
  }
}

export async function logoutBusinessSession(): Promise<void> {
  try { await rpc('business_logout') } finally { setToken('') }
}
