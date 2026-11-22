import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { lockSettings } from './applock'

interface AuthState { session: Session | null; name: string; ready: boolean; refreshName: () => void }
const Ctx = createContext<AuthState>({ session: null, name: '', ready: true, refreshName: () => {} })

// Stay signed in until signing out. The browser can lose Supabase's saved session on its own
// (Safari clears site storage after 7 days without a visit), so the refresh token is also kept in
// a server-set cookie the page can't read (api/session.js). If the session goes missing without a
// sign-out, it's restored from there once.
const backup = (action: 'save' | 'restore' | 'clear', refresh_token?: string, locked?: boolean) =>
  fetch('/api/session', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, refresh_token, locked }) })
    .then(r => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ refresh_token?: string | null } | null>
let lastSaved = '', signingOut = false, restoreTried = false
let lastLocked = false
const keep = (s: Session | null, force = false) => {
  if (!s?.refresh_token) return
  const locked = !!lockSettings(s.user.id)
  if (!force && s.refresh_token === lastSaved && locked === lastLocked) return
  lastSaved = s.refresh_token; lastLocked = locked
  void backup('save', s.refresh_token, locked)
}
/** Call after the app lock is turned on or off, so the backup knows. */
export const syncBackup = () => { void supabase?.auth.getSession().then(({ data }) => keep(data.session, true)) }
async function restore(): Promise<Session | null> {
  if (!supabase || restoreTried || signingOut) return null
  restoreTried = true
  const j = await backup('restore') as { refresh_token?: string | null; locked?: boolean } | null
  if (j?.locked) { void backup('clear'); return null }     // had an app lock: sign in again with the email code
  if (!j?.refresh_token) return null
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: j.refresh_token })
  if (error) { if (!/fetch|network|timeout/i.test(error.message)) void backup('clear'); return null }
  return data.session
}
/** Sign out everywhere on this browser: the backup goes first, so no tab can bring the session back. */
export async function signOut() {
  signingOut = true
  await backup('clear')
  await supabase?.auth.signOut()
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [name, setName] = useState('')
  const [ready, setReady] = useState(!supabase)

  const loadName = async (s: Session | null) => {
    if (!supabase || !s) { setName(''); return }
    const { data } = await supabase.from('profiles').select('display_name').eq('id', s.user.id).maybeSingle()
    setName(data?.display_name || s.user.email?.split('@')[0] || '')
  }

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(async ({ data }) => {
      const s = data.session ?? await restore()
      setSession(s); loadName(s); keep(s); setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((e, s) => {
      setSession(s); loadName(s); keep(s)
      // (after this callback returns: auth calls made inside it would wait on themselves)
      if (e === 'SIGNED_OUT' && !signingOut) setTimeout(() => void restore().then(r => { if (r) { setSession(r); loadName(r) } }), 0)
    })
    // signing in from the email link happens in another tab: pick the session up here as soon as
    // that tab saves it (storage event), or when this tab is looked at again
    const recheck = () => { supabase!.auth.getSession().then(({ data }) => { setSession(cur => (cur?.access_token === data.session?.access_token ? cur : (loadName(data.session), data.session))) }) }
    const onStorage = (e: StorageEvent) => { if (!e.key || e.key.startsWith('sb-')) recheck() }
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => { sub.subscription.unsubscribe(); window.removeEventListener('storage', onStorage); window.removeEventListener('focus', recheck); document.removeEventListener('visibilitychange', recheck) }
  }, [])

  return <Ctx.Provider value={{ session, name, ready, refreshName: () => loadName(session) }}>{children}</Ctx.Provider>
}

export const useAuth = () => useContext(Ctx)
