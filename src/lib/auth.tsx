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
    return () => sub.subscription.unsubscribe()
  }, [])

  return <Ctx.Provider value={{ session, name, ready, refreshName: () => loadName(session) }}>{children}</Ctx.Provider>
}

export const useAuth = () => useContext(Ctx)
