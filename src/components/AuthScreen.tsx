import { useState } from 'react'
import { LogIn, Wheat } from 'lucide-react'
import { supabase } from '../lib/supabase'

export function AuthScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) setMessage('メールアドレスまたはパスワードが正しくありません。')
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
          <label>パスワード<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" minLength={8} required /></label>
          <button className="primary-button full-width" type="submit" disabled={busy}>
            <LogIn size={19} />
            {busy ? '処理中...' : 'ログイン'}
          </button>
        </form>
      </section>
    </main>
  )
}
