import { useEffect, useRef, useState, type ReactNode } from 'react'
import { signOut, syncBackup, useAuth } from '../lib/auth'
import {
  AFTER_CHOICES, bioAvailable, enrolBio, lastActive, lockSettings, markActive, MAX_FAILS, pinSettings, resetFails, saveLock, shouldLock, tryUnlock, validPin, type LockSettings,
} from '../lib/applock'

/** Covers the whole site with the lock screen when the signed-in person has an app lock and was away too long. */
export function LockGate({ children }: { children: ReactNode }) {
  const { session, ready } = useAuth()
  const uid = session?.user.id
  const [locked, setLocked] = useState(false)
  const first = useRef(true)

  // on load with a saved sign-in: lock if away too long. A fresh sign-in (email code) counts as unlocking.
  useEffect(() => {
    if (!ready) return
    if (!uid) { first.current = false; return }
    if (first.current) setLocked(shouldLock(uid))
    else { markActive(); resetFails(uid); setLocked(false) }      // signing in with the email code proves it's you
    first.current = false
  }, [ready, uid])

  useEffect(() => {
    if (!uid || locked) return
    let lastMark = 0
    const touch = () => { const n = Date.now(); if (n - lastMark > 10_000) { lastMark = n; markActive() } }
    const check = () => { if (document.visibilityState === 'visible' && shouldLock(uid)) setLocked(true) }
    const onVis = () => { if (document.visibilityState === 'hidden') markActive(); else check() }
    const idle = setInterval(() => {                     // locks while left open too, unless "every time I come back"
      const s = lockSettings(uid)
      if (s && s.afterMin > 0 && document.visibilityState === 'visible') check()
    }, 15_000)
    const evs = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const
    evs.forEach(e => window.addEventListener(e, touch, { passive: true }))
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', check)
    markActive()
    return () => { clearInterval(idle); evs.forEach(e => window.removeEventListener(e, touch)); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', check) }
  }, [uid, locked])

  // "Lock now" from the account page
  useEffect(() => {
    const lockNow = () => setLocked(!!uid && !!lockSettings(uid))
    window.addEventListener('applock:lock', lockNow)
    return () => window.removeEventListener('applock:lock', lockNow)
  }, [uid])

  if (uid && locked) return <LockScreen uid={uid} email={session!.user.email || ''} onUnlock={() => setLocked(false)} />
  return <>{children}</>
}

function LockScreen({ uid, email, onUnlock }: { uid: string; email: string; onUnlock: () => void }) {
  const s = lockSettings(uid)
  const [pin, setPin] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const done = async (r: Awaited<ReturnType<typeof tryUnlock>>, bio: boolean) => {
    if (r.result === 'ok') return onUnlock()
    if (r.result === 'locked-out') { setMsg('Too many wrong passcodes. Signing you out: sign in again with your email code.'); setTimeout(() => void signOut(), 1500); return }
    setMsg(bio ? "That didn't unlock. Try again, or use the device's passcode when it asks." : `Wrong passcode. ${r.left} ${r.left === 1 ? 'try' : 'tries'} left before you're signed out.`)
  }
  const bio = async () => { setBusy(true); setMsg(null); try { await done(await tryUnlock(uid, { bio: true }), true) } finally { setBusy(false) } }
  if (!s) { onUnlock(); return null }
  return (
    <main className="page lock-screen">
      <div className="card" style={{ maxWidth: 380, margin: '12vh auto', textAlign: 'center' }}>
        <div className="lock-icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
        </div>
        <h1 style={{ fontSize: 22, margin: '8px 0 4px' }}>Backtester is locked</h1>
        <p className="muted small" style={{ marginTop: 0 }}>Signed in as {email}{lastActive() ? ` · last used ${new Date(lastActive()).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</p>
        {msg && <div className="notice err small" style={{ textAlign: 'left' }}>{msg}</div>}
        {s.method === 'bio' ? (
          <button className="btn btn-primary btn-block" disabled={busy} onClick={bio} autoFocus>{busy ? 'Waiting for your device…' : 'Unlock with Face ID, fingerprint or passcode'}</button>
        ) : (
          <form onSubmit={async e => { e.preventDefault(); setBusy(true); setMsg(null); try { await done(await tryUnlock(uid, { pin }), false); setPin('') } finally { setBusy(false) } }}>
            <label className="field" style={{ textAlign: 'left' }}><span>Passcode</span>
              <input type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]*" maxLength={12} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} autoFocus /></label>
            <button className="btn btn-primary btn-block" disabled={busy || pin.length < 6}>{busy ? 'Checking…' : 'Unlock'}</button>
          </form>
        )}
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => void signOut()}>Can't unlock? Sign out</button>
      </div>
    </main>
  )
}

/** Account page: turn the app lock on, choose how and when it locks, or turn it off. */
export function AppLockSettings({ uid, email }: { uid: string; email: string }) {
  const [s, setS] = useState<LockSettings | null>(() => lockSettings(uid))
  const [canBio, setCanBio] = useState<boolean | null>(null)
  const [mode, setMode] = useState<'pin' | null>(null)
  const [pin, setPin] = useState(''), [pin2, setPin2] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void bioAvailable().then(setCanBio) }, [])
  const store = (x: LockSettings | null) => { saveLock(uid, x); setS(x); syncBackup() }

  const useBio = async () => {
    setBusy(true); setMsg(null)
    try {
      const credId = await enrolBio(uid, email)
      store({ method: 'bio', credId, afterMin: s?.afterMin ?? 5, created: Date.now() })
      setMsg({ ok: true, text: 'App lock is on. Your device will ask for your face, fingerprint or passcode.' })
    } catch (e) { setMsg({ ok: false, text: (e as Error).name === 'NotAllowedError' ? 'Cancelled, nothing changed.' : `Couldn't set it up on this device (${(e as Error).message}). You can use a passcode instead.` }) }
    finally { setBusy(false) }
  }
  const usePin = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(null)
    if (!validPin(pin)) return setMsg({ ok: false, text: 'Use 6 to 12 digits, not all the same and not a straight run like 123456.' })
    if (pin !== pin2) return setMsg({ ok: false, text: "The two passcodes don't match." })
    setBusy(true)
    store({ method: 'pin', ...(await pinSettings(pin)), afterMin: s?.afterMin ?? 5, created: Date.now() })
    setBusy(false); setMode(null); setPin(''); setPin2('')
    setMsg({ ok: true, text: 'App lock is on with your passcode.' })
  }
  const turnOff = async () => {
    setBusy(true); setMsg(null)
    try {
      if (s?.method === 'bio') {
        const r = await tryUnlock(uid, { bio: true })
        if (r.result !== 'ok') return setMsg({ ok: false, text: 'Confirm with your device to turn the lock off.' })
      } else {
        const p = window.prompt('Enter your passcode to turn the lock off') ?? ''
        const r = await tryUnlock(uid, { pin: p })
        if (r.result === 'locked-out') { void signOut(); return }
        if (r.result !== 'ok') return setMsg({ ok: false, text: `Wrong passcode (${r.left} tries left).` })
      }
      store(null); setMsg({ ok: true, text: 'App lock is off on this device.' })
    } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ maxWidth: 460, margin: '16px auto' }}>
      <h2 style={{ marginTop: 0 }}>App lock</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Locks the site on this device when you've been away, like a banking app. You stay signed in; you just prove it's you to open it again. {MAX_FAILS} wrong passcodes signs you out.</p>
      {msg && <div className={`notice ${msg.ok ? 'info' : 'err'} small`}>{msg.text}</div>}
      {s ? <>
        <p className="small"><span className="tag green">On</span> {s.method === 'bio' ? 'Face ID / fingerprint / device passcode' : 'Passcode'}</p>
        <label className="field"><span>Lock</span>
          <select value={s.afterMin} onChange={e => store({ ...s, afterMin: +e.target.value })}>{AFTER_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <div className="flex" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => window.dispatchEvent(new Event('applock:lock'))}>Lock now</button>
          {s.method === 'pin' && canBio && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={useBio}>Switch to Face ID / fingerprint</button>}
          {s.method === 'bio' && <button className="btn btn-ghost btn-sm" onClick={() => setMode('pin')}>Switch to a passcode</button>}
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={turnOff}>Turn off</button>
        </div>
      </> : <div className="flex" style={{ flexWrap: 'wrap', gap: 8 }}>
        {canBio && <button className="btn btn-primary" disabled={busy} onClick={useBio}>{busy ? 'Waiting for your device…' : 'Use Face ID / fingerprint'}</button>}
        {mode !== 'pin' && <button className={`btn ${canBio ? 'btn-ghost' : 'btn-primary'}`} onClick={() => setMode('pin')}>{canBio ? 'Use a passcode instead' : 'Set a passcode'}</button>}
        {canBio === false && <p className="muted small" style={{ margin: 0 }}>This browser doesn't offer Face ID or fingerprint to websites, so a passcode is used.</p>}
      </div>}
      {mode === 'pin' && (
        <form onSubmit={usePin} style={{ marginTop: 12 }}>
          <label className="field"><span>New passcode (6–12 digits)</span>
            <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} /></label>
          <label className="field"><span>Type it again</span>
            <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={pin2} onChange={e => setPin2(e.target.value.replace(/\D/g, ''))} /></label>
          <div className="flex" style={{ gap: 8 }}>
            <button className="btn btn-primary" disabled={busy || pin.length < 6}>Save passcode</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setMode(null); setPin(''); setPin2('') }}>Cancel</button>
          </div>
        </form>
      )}
      <p className="hint">Set separately on each device and browser. Forgotten passcode? Choose "Can't unlock? Sign out" on the lock screen and sign in again with your email code.</p>
    </div>
  )
}
