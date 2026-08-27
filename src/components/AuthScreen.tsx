import { useState } from 'react'
import { LogIn, UserPlus, Wheat } from 'lucide-react'
import { supabase } from '../lib/supabase'

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    const result = mode === 'login'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password })

    if (result.error) setMessage(result.error.message)
    else if (mode === 'signup' && !result.data.session) setMessage('確認メールを送信しました。メール内のリンクを開いてください。')
    setBusy(false)
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-brand">
          <span className="brand-mark"><Wheat size={22} /></span>
          <div><h1>フレコントレース</h1><p>玄米フレコン出荷管理</p></div>
        </div>
        {message && <div className={message.includes('送信') ? 'notice success' : 'notice error'}>{message}</div>}
        <form className="form-grid" onSubmit={submit}>
          <label>メールアドレス<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label>
          <label>パスワード<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} required /></label>
          <button className="primary-button full-width" type="submit" disabled={busy}>
            {mode === 'login' ? <LogIn size={19} /> : <UserPlus size={19} />}
            {busy ? '処理中...' : mode === 'login' ? 'ログイン' : 'アカウント作成'}
          </button>
        </form>
        <div className="auth-switch">
          {mode === 'login' ? '初めて利用する場合' : 'アカウントをお持ちの場合'}
          <button className="text-button" type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMessage('') }}>
            {mode === 'login' ? 'アカウント作成' : 'ログイン'}
          </button>
        </div>
      </section>
    </main>
  )
}
