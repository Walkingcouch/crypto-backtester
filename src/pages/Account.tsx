import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { arrivedByLink, supabase } from '../lib/supabase'
import { handOff, signOut, useAuth } from '../lib/auth'
import { codeOf, emailId, post as relayPost, sealFor, startWaiting } from '../lib/relay'
import { AppLockSettings } from '../components/AppLock'

// Signing in: the email has a link AND a 6-digit code. Typing the code signs in right here. If the
// link is used instead (it opens a new tab), this tab notices the sign-in and carries on by itself,
// and the new tab says it can be closed. If the link is opened on ANOTHER device or browser, that
// device asks to approve (with a matching 4-digit code) and the waiting page signs in by itself.
const PENDING = 'signin-pending'
// opened from an iPhone/iPad Home Screen icon: its own storage, separate from Safari's
const STANDALONE = typeof window !== 'undefined' && ((navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches)
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
  const [myCode, setMyCode] = useState('')
  const [approve, setApprove] = useState<null | { pub: JsonWebKey; device: string; at: number; code: string }>(null)
  const [handed, setHanded] = useState<false | { code: string | null }>(false)
  // the link opened here: if ANOTHER screen is waiting (its request isn't this browser's own), ask to
  // approve it; otherwise this is the same browser and the asking tab picks the sign-in up itself
  const [linkChecked, setLinkChecked] = useState(!arrivedByLink)
  useEffect(() => {
    if (!session || !arrivedByLink || linkChecked) return
    void relayPost({ action: 'peek' }, session.access_token).then(async r => {
      let mine: { relay?: { priv: JsonWebKey }; at?: number } = {}
      try { mine = JSON.parse(get(PENDING) || '{}') } catch { /* */ }
      const own = mine.relay?.priv?.n && r.pub?.n === mine.relay.priv.n && Date.now() - (mine.at || 0) < 15 * 60_000
      if (r.waiting && r.pub && !own) setApprove({ pub: r.pub, device: r.device, at: r.at, code: await codeOf(r.pub) })
      setLinkChecked(true)
    }).catch(() => setLinkChecked(true))
  }, [session, linkChecked])
  useEffect(() => setDisplay(name), [name])

  // when the session appears: the tab that asked carries on where it was; the email-link tab says so
  useEffect(() => {
    if (!session || !linkChecked || approve) return
    const raw = get(PENDING)
    if (!raw) return
    let p: { from?: string; at?: number; tab?: string } = {}
    try { p = JSON.parse(raw) } catch { /* */ }
    if (Date.now() - (p.at || 0) > 60 * 60_000) { set(PENDING, null); return }
    if (p.tab !== TAB && !arrivedByLink) return                                         // an old request from another tab
    if (p.tab === TAB) { set(PENDING, null); nav(p.from || '/', { replace: true }) }        // the asking tab (also after a reload)
    else { setLinkTab(true); setTimeout(() => { try { window.close() } catch { /* */ } }, 1500) }   // the link tab
  }, [session, nav, linkChecked, approve])

  if (!supabase) return <main className="page"><div className="card empty">Accounts aren't configured on this deployment.</div></main>

  if (handed) return (
    <main className="page">
      <div className="card" style={{ maxWidth: 420, margin: '24px auto', textAlign: 'center' }}>
        <h1>Approved</h1>
        <p>Your other screen should sign in by itself within a few seconds.</p>
        {handed.code && <>
          <p className="muted small" style={{ marginBottom: 4 }}>If it doesn't, type this code there:</p>
          <div className="mono" style={{ fontSize: 36, fontWeight: 700, letterSpacing: 8, margin: '4px 0 12px' }}>{handed.code}</div>
          <p className="muted small">Works once, for 30 minutes.</p>
        </>}
      </div>
    </main>
  )
  if (session && approve) return (
    <main className="page">
      <div className="card" style={{ maxWidth: 420, margin: '24px auto', textAlign: 'center' }}>
        <h1>Approve this sign-in?</h1>
        <p>{approve.device} asked to sign in as <b>{session.user.email}</b> {Math.max(1, Math.round((Date.now() - approve.at) / 60_000))} min ago.</p>
        <p className="muted small">Check that screen shows this code:</p>
        <div className="mono" style={{ fontSize: 34, fontWeight: 700, letterSpacing: 8, margin: '8px 0 16px' }}>{approve.code}</div>
        {err && <div className="notice err">{err}</div>}
        <button className="btn btn-primary btn-block" disabled={busy} onClick={async () => {
          setBusy(true); setErr(null)
          try {
            const box = await sealFor(approve.pub, session.refresh_token)
            const r = await relayPost({ action: 'approve', box, rt: session.refresh_token }, session.access_token)
            if (!r.ok) throw new Error(r.error || 'approval failed')
            await handOff(); setApprove(null); setHanded({ code: r.code || null })
          } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
        }}>{busy ? 'Approving…' : 'Yes, the code matches: sign that screen in'}</button>
        <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={async () => { await relayPost({ action: 'decline' }, session.access_token); setApprove(null) }}>Not me / sign in on this device instead</button>
      </div>
    </main>
  )

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
            {myCode && <div className="flex small" style={{ gap: 8, alignItems: 'center', margin: '8px 0' }}><span className="spinner" aria-hidden="true" /> Waiting for you to approve… <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.dispatchEvent(new Event('signin:check'))}>Check now</button></div>}
            {myCode && (STANDALONE
              ? <div className="notice info"><b>Using the Home Screen app?</b> Tap the link in the email. It opens in Safari, which asks you to approve this sign-in with the code <b className="mono" style={{ fontSize: 16, letterSpacing: 2 }}>{myCode}</b>. Approve, then come back to this app: it signs in by itself within a few seconds, or type the 6-digit code Safari shows into the box below.</div>
              : <p className="small">No code in the email, or opening it on <b>another phone or computer</b>? Tap the link there and approve: this page signs in by itself, or type the 6-digit code it shows below. It will show the code <b className="mono" style={{ fontSize: 16, letterSpacing: 2 }}>{myCode}</b>; only approve if it matches.</p>)}
            <form onSubmit={async e => {
              e.preventDefault(); setBusy(true); setErr(null)
              // a 6-digit code from the approval screen (hand-over) first, then the email's own code
              if (/^\d{6}$/.test(code.trim())) {
                const h = await relayPost({ action: 'redeem', id: await emailId(email), code: code.trim() })
                if (h.rt) {
                  const { error: e2 } = await supabase!.auth.refreshSession({ refresh_token: h.rt })
                  setBusy(false)
                  if (e2) setErr(e2.message)
                  return
                }
                if (h.error && !/no approved sign-in/.test(h.error)) { setBusy(false); setErr(`Approval code: ${h.error}`); return }
              }
              const { error } = await supabase!.auth.verifyOtp({ email, token: code.trim(), type: 'email' })
              setBusy(false)
              if (error) setErr(error.message.includes('expired') || error.message.includes('invalid') ? 'That code is wrong or has expired. Check the latest email, or send a new one.' : error.message)
            }}>
              <label className="field"><span>Type the 6-digit code from the approval screen (or from the email)</span>
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
            try {
              const w = await startWaiting(email)
              const cur = JSON.parse(get(PENDING) || '{}')
              set(PENDING, JSON.stringify({ ...cur, relay: { id: w.id, priv: w.priv } })); setMyCode(w.code)
            } catch { /* approving elsewhere won't work, the code and same-browser link still do */ }
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
