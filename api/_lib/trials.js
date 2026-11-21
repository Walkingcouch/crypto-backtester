// Shared trial ledger: how many rule ideas each lab has ever tried, so every lab's "real after
// counting tries" check (deflated Sharpe) counts the tries of ALL labs, not just its own.
import { rpc, sb } from './forecaster.js'

export async function readLedger() {
  try { const r = await sb('/rest/v1/lab_state?id=eq.trial-ledger&select=data'); return r.ok ? ((await r.json())[0]?.data || {}) : {} } catch { return {} }
}
export const othersSum = (L, sid) => Object.entries(L || {}).filter(([k]) => k !== sid).reduce((a, [, v]) => a + (+v || 0), 0)
/** A lab's share of the ledger: its EFFECTIVE number of different ideas (near-copies grouped),
 *  falling back to the raw count for results made before grouping existed. */
export const ownTrials = state => state?.trialsEff ?? Math.max(state?.trials || 0, state?.explore?.tried || 0)

/** Before a lab runs: put everyone else's count on its state. After: record its own count. */
export async function withLedger(sid, state, run, { dry = false } = {}) {
  const L = await readLedger()
  if (state) state.trialsOthers = othersSum(L, sid)
  const out = await run(state)
  if (!dry && out) {
    const now = await readLedger()                                  // re-read so a lab that ran meanwhile isn't overwritten
    now[sid] = ownTrials(out)
    await rpc('lab_put', { sid: 'trial-ledger', payload: now }).catch(() => null)
  }
  return out
}
