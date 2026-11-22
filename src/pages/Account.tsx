import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { signOut, useAuth } from '../lib/auth'
import { AppLockSettings } from '../components/AppLock'

// Signing in: the email has a link AND a 6-digit code. Typing the code signs in right here. If the
// link is used instead (it opens a new tab), this tab notices the sign-in and carries on by itself,
// and the new tab says it can be closed.
const PENDING = 'signin-pending'
const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private mode */ } }

export default function Account() {
  const { session, name, refreshName } = useAuth()
  const nav = useNavigate()
  const loc = useLocation() as { state?: { from?: string } }
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [display, setDisplay] = useState(name)
  const [savedName, setSavedName] = useState(false)
  const [linkTab, setLinkTab] = useState(false)
  useEffect(() => setDisplay(name), [name])

  // when the session appears: the tab that asked carries on where it was; the email-link tab says so
  useEffect(() => {
    if (!session) return
    const raw = get(PENDING)
    if (!raw) return
    let p: { from?: string; at?: number; tab?: string } = {}
    try { p = JSON.parse(raw) } catch { /* */ }
    if (Date.now() - (p.at || 0) > 60 * 60_000) { set(PENDING, null); return }
    if (sent && p.tab === TAB) { set(PENDING, null); nav(p.from || '/', { replace: true }) }        // the asking tab
    else if (!sent) { setLinkTab(true); setTimeout(() => { try { window.close() } catch { /* */ } }, 1500) }   // the link tab
  }, [session, sent, nav])

  if (!supabase) return <main className="page"><div className="card empty">Accounts aren't configured on this deployment.</div></main>

  if (session && linkTab) return (
    <main className="page">
      <div className="card" style={{ maxWidth: 420, margin: '24px auto', textAlign: 'center' }}>
        <h1>You're signed in</h1>
        <p>Your other tab has signed in too and carried on where you were. You can close this tab.</p>
        <button className="btn btn-ghost" onClick={() => { setLinkTab(false); set(PENDING, null) }}>Stay on this tab instead</button>
      </div>
    </main>
  )

  if (!session) return (
    <main className="page">
      <div className="card" style={{ maxWidth: 420, margin: '24px auto' }}>
        <h1>Sign in</h1>
        <p className="muted">Enter your email and we'll send a sign-in code and link. No password needed. New emails get an account automatically.</p>
        {err && <div className="notice err">{err}</div>}
        {sent ? (
          <>
            <div className="notice ok">Sent to <b>{email}</b>. It can take a minute; check spam too.</div>
            <form onSubmit={async e => {
              e.preventDefault(); setBusy(true); setErr(null)
              const { error } = await supabase!.auth.verifyOtp({ email, token: code.trim(), type: 'email' })
              setBusy(false)
              if (error) setErr(error.message.includes('expired') || error.message.includes('invalid') ? 'That code is wrong or has expired. Check the latest email, or send a new one.' : error.message)
            }}>
              <label className="field"><span>Type the 6-digit code from the email</span>
                <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" maxLength={8} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" autoFocus /></label>
              <button className="btn btn-primary btn-block" disabled={busy || code.length < 6}>{busy ? 'Checking…' : 'Sign in'}</button>
            </form>
            <p className="muted small" style={{ marginTop: 10 }}>Or tap the link in the email. It opens a new tab, and <b>this tab signs in by itself</b> and carries on where you were (the new tab can be closed).</p>
            <button className="btn btn-ghost btn-sm" onClick={() => { setSent(false); setCode(''); setErr(null) }}>Use a different email / send again</button>
          </>
        ) : (
          <form onSubmit={async e => {
            e.preventDefault(); setBusy(true); setErr(null)
            set(PENDING, JSON.stringify({ from: loc.state?.from || (document.referrer && new URL(document.referrer).origin === location.origin ? new URL(document.referrer).pathname + new URL(document.referrer).search : '/'), at: Date.now(), tab: TAB }))
            const { error } = await supabase!.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + '/account' } })
            setBusy(false)
            if (error) { setErr(error.message); set(PENDING, null) } else setSent(true)
          }}>
            <label className="field"><span>Email</span><input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></label>
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Sending…' : 'Send sign-in code'}</button>
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
            <button type="button" className="btn btn-ghost" onClick={() => void signOut()}>Sign out</button>
          </div>
        </form>
      </div>
      <AppLockSettings uid={session.user.id} email={session.user.email || ''} />
    </main>
  )
}

/** Identifies this browser tab (so the email-link tab and the asking tab can tell themselves apart). */
const TAB = (() => { try { return sessionStorage.getItem('tab-id') || (sessionStorage.setItem('tab-id', Math.random().toString(36).slice(2)), sessionStorage.getItem('tab-id')!) } catch { return Math.random().toString(36).slice(2) } })()
