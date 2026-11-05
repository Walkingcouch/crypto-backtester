// Saved runs + the unseen-test ledger. Uses Supabase when signed in, else this browser only.
import { supabase } from './supabase'

export interface Reveal {
  id?: string
  created_at?: string
  user_id?: string
  author?: string
  strategy_id: string
  strategy_version: number
  params: Record<string, number>
  period_key: string
  symbol: string
  interval: string
  test_from: string
  test_to: string
  fee: number
  sharpe: number
  total_return: number
  max_drawdown: number
  bh_return: number
}

export interface SavedRun {
  id?: string
  created_at?: string
  user_id?: string
  author?: string
  title: string
  strategy_id: string
  symbol: string
  interval: string
  settings: Record<string, unknown>
  params: Record<string, number>
  train_metrics: Record<string, number>
  test_metrics: Record<string, number> | null
}

const LK = { reveals: 'cb.reveals', runs: 'cb.runs' }
const readLocal = <T,>(k: string): T[] => { try { return JSON.parse(localStorage.getItem(k) || '[]') } catch { return [] } }
const writeLocal = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* storage off */ } }

async function uid() {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.user.id ?? null
}

export async function listReveals(): Promise<Reveal[]> {
  if (supabase && (await uid())) {
    const { data, error } = await supabase.from('test_reveals_view').select('*').order('created_at', { ascending: false }).limit(500)
    if (error) throw error
    return data as Reveal[]
  }
  return readLocal<Reveal>(LK.reveals).reverse()
}

export async function addReveal(r: Reveal): Promise<void> {
  const u = await uid()
  if (supabase && u) {
    const { error } = await supabase.from('test_reveals').insert({ ...r, user_id: u })
    if (error) throw error
    return
  }
  writeLocal(LK.reveals, [...readLocal<Reveal>(LK.reveals), { ...r, created_at: new Date().toISOString(), author: 'You (this browser)' }])
}

export async function listRuns(): Promise<SavedRun[]> {
  if (supabase && (await uid())) {
    const { data, error } = await supabase.from('runs_view').select('*').order('created_at', { ascending: false }).limit(200)
    if (error) throw error
    return data as SavedRun[]
  }
  return readLocal<SavedRun>(LK.runs).reverse()
}

export async function saveRun(r: SavedRun): Promise<void> {
  const u = await uid()
  if (supabase && u) {
    const { error } = await supabase.from('runs').insert({ ...r, user_id: u })
    if (error) throw error
    return
  }
  writeLocal(LK.runs, [...readLocal<SavedRun>(LK.runs), { ...r, id: crypto.randomUUID(), created_at: new Date().toISOString(), author: 'You' }])
}

export async function deleteRun(id: string): Promise<void> {
  if (supabase && (await uid())) {
    const { error } = await supabase.from('runs').delete().eq('id', id)
    if (error) throw error
    return
  }
  writeLocal(LK.runs, readLocal<SavedRun>(LK.runs).filter(r => r.id !== id))
}
