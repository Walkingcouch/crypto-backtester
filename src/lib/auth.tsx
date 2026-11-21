import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

interface AuthState { session: Session | null; name: string; ready: boolean; refreshName: () => void }
const Ctx = createContext<AuthState>({ session: null, name: '', ready: true, refreshName: () => {} })

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
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); loadName(data.session); setReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); loadName(s) })
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
