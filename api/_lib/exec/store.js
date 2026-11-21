// Audit table access. Everything goes through secret-checked database functions (migration 0008),
// so the public website can't read or write orders.
import { rpc, sb } from '../forecaster.js'

/** Everyone's settings rows and orders. Falls back to the single-account functions if migration
 *  0010 hasn't been run yet (then everything belongs to John). */
export async function loadAll(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const j = await rpc('exec_get_all', { since, max_rows: 3000 })
  if (typeof j !== 'string') return { settings: j.settings || [], orders: (j.orders || []).map(o => ({ owner: 'john', ...o })), perUser: true }
  const one = await loadExec(days)
  return { settings: [{ ...one.settings, owner: 'john' }], orders: one.orders.map(o => ({ ...o, owner: 'john' })), perUser: false }
}

export async function setSettingsFor(owner, patch, who) {
  const r = await rpc('exec_settings_set_for', { who_owner: owner, patch, who })
  if (typeof r === 'string') {
    if (owner === 'john' && /exec_settings_set_for/.test(r)) return setSettings(patch, who)   // before migration 0010
    throw new Error(/exec_settings_set_for/.test(r) ? 'separate accounts need migration 0010 in Supabase first' : r)
  }
  return r
}

export async function loadExec(days = 30) {
  const j = await rpc('exec_get', { since: new Date(Date.now() - days * 86_400_000).toISOString(), max_rows: 1000 })
  if (typeof j === 'string') throw new Error(`execution tables not ready (run migration 0008): ${j}`)
  return { settings: j.settings, orders: j.orders || [] }
}

export const store = orders => ({
  orders,
  put: async (row, allowUpdate = false) => {
    const r = await rpc('exec_put', { row_data: row, allow_update: allowUpdate })
    if (typeof r === 'string' && r.startsWith('error')) throw new Error(`audit write failed: ${r}`)
    return r
  },
})

export async function setSettings(patch, who) {
  const r = await rpc('exec_settings_set', { patch, who })
  if (typeof r === 'string') throw new Error(r)
  return r
}

export async function labState(id) {
  const r = await sb(`/rest/v1/lab_state?id=eq.${encodeURIComponent(id)}&select=data`)
  return r.ok ? (await r.json())[0]?.data ?? null : null
}
