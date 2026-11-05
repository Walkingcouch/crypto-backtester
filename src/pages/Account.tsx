import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

export default function Account() {
  const { session, name, refreshName } = useAuth()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [display, setDisplay] = useState(name)
  const [savedName, setSavedName] = useState(false)
  useEffect(() => setDisplay(name), [name])

  if (!supabase) return <main className="page"><div className="card empty">Accounts aren't configured on this deployment.</div></main>

  if (!session) return (
    <main className="page">
      <div className="card" style={{ maxWidth: 420, margin: '24px auto' }}>
        <h1>Sign in</h1>
        <p className="muted">Enter your email and we'll send a sign-in link. No password needed. New emails get an account automatically.</p>
        {err && <div className="notice err">{err}</div>}
        {sent ? <div className="notice ok">Check <b>{email}</b> for a sign-in link. Open it on this device. It can take a minute; check spam too.</div> : (
          <form onSubmit={async e => {
            e.preventDefault(); setBusy(true); setErr(null)
            const { error } = await supabase!.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + '/account' } })
            setBusy(false)
            if (error) setErr(error.message); else setSent(true)
          }}>
            <label className="field"><span>Email</span><input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></label>
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Sending…' : 'Send sign-in link'}</button>
          </form>
        )}
      </div>
    </main>
  )

  return (
    <main className="page">
      <div className="card" style={{ maxWidth: 460, margin: '24px auto' }}>
        <h1>Your profile</h1>
        <p className="muted small">Signed in as {session.user.email}</p>
        {err && <div className="notice err">{err}</div>}
        <form onSubmit={async e => {
          e.preventDefault(); setErr(null)
          const { error } = await supabase!.from('profiles').update({ display_name: display.trim() }).eq('id', session.user.id)
          if (error) setErr(error.message); else { setSavedName(true); refreshName() }
        }}>
          <label className="field"><span>Display name</span>
            <input value={display} maxLength={40} onChange={e => { setDisplay(e.target.value); setSavedName(false) }} />
            <span className="hint">Shown next to your saved runs and test reveals.</span>
          </label>
          <div className="flex">
            <button className="btn btn-primary">Save name</button>
            {savedName && <span className="tag green">Saved</span>}
            <span className="spacer" />
            <button type="button" className="btn btn-ghost" onClick={() => supabase!.auth.signOut()}>Sign out</button>
          </div>
        </form>
      </div>
    </main>
  )
}
