// Audit table access. Everything goes through secret-checked database functions (migration 0008),
// so the public website can't read or write orders.
import { rpc, sb } from '../forecaster.js'

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
