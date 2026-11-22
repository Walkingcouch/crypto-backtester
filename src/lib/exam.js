// The sealed exam, rolling every six months.
//
// History is split into half-years (1 Jan – 30 Jun, 1 Jul – 31 Dec, UTC). The half-year we are in
// now is SEALED: nothing in any lab is chosen, tuned, checked or bred on it. All choosing uses only
// trades that finished before it began. A rule that passes every other check then sits the exam on
// the sealed half-year, ONCE per half-year, and the result is kept for good (state.exams).
//
// A half-year's exam opens once it is three months old (enough trades to judge). Until then the
// result from the previous half-year still counts. When a new half-year starts, the old one is
// unsealed and becomes ordinary history, so choosing always moves forward and every exam is sat on
// data no rule was picked with.
//
// Passing: at least 10 trades in the window and a profit after costs.
export const EXAM_MIN = 10
const DAY = 86_400_000
export const OPEN_AFTER = 90 * DAY

/** The half-year containing t: { id: '2026H2', start, end }. */
export function halfYear(t) {
  const d = new Date(t), y = d.getUTCFullYear(), h = d.getUTCMonth() < 6 ? 1 : 2
  const start = Date.UTC(y, h === 1 ? 0 : 6, 1), end = h === 1 ? Date.UTC(y, 6, 1) : Date.UTC(y + 1, 0, 1)
  return { id: `${y}H${h}`, start, end }
}
/** The sealed window right now (exams on it can be sat from opensAt) and the one before it. */
export function currentSeal(now = Date.now()) {
  const cur = halfYear(now), prev = halfYear(cur.start - 1)
  return { ...cur, end: Math.min(cur.end, now), opensAt: cur.start + OPEN_AFTER, prev }
}
/** Kept for code that reads SEAL directly: the window sealed at the time this module loaded. */
export const SEAL = currentSeal()

/** Trades that were finished before the seal: the only ones any choosing may use. */
export const preSeal = (ev, seal = currentSeal()) => ev.filter(e => e.exitT <= seal.start)
/** "Now", as far as choosing is concerned. */
export const sealedLast = (data, seal = currentSeal()) => Math.min(seal.start, Math.max(...data.coins.map(c => c.t[c.t.length - 1])))

const score = (evAll, netOf, start, end) => {
  const x = evAll.filter(e => e.t >= start && e.exitT <= end).map(netOf).filter(Number.isFinite)
  const n = x.length, mean = n ? x.reduce((a, b) => a + b, 0) / n : 0
  const sd = n > 1 ? Math.sqrt(x.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0
  return { n, mean: +mean.toFixed(5), t: sd > 0 ? +(mean / (sd / Math.sqrt(n))).toFixed(2) : 0, passed: n >= EXAM_MIN && mean > 0 }
}

/**
 * The exam for rule `id`: this half-year's stored result, or sit it now if the window is open,
 * else the previous half-year's stored result. Returns null when there's nothing to go on yet.
 * (Results stored before rolling existed, under the bare rule id, belong to 2026H2.)
 */
export function sitExam(state, id, evAll, netOf, now, seal = currentSeal(now)) {
  const exams = (state.exams ||= {})
  for (const k of Object.keys(exams)) if (!k.includes('|')) { exams[`2026H2|${k}`] = { ...exams[k], window: exams[k].window || [Date.UTC(2026, 6, 1), Date.UTC(2026, 10, 21)] }; delete exams[k] }
  const key = `${seal.id}|${id}`
  if (exams[key]) return { ...exams[key], half: seal.id }
  if (now >= seal.opensAt) return { ...(exams[key] = { ...score(evAll, netOf, seal.start, seal.end), at: now, window: [seal.start, seal.end] }), half: seal.id }
  const prev = exams[`${seal.prev.id}|${id}`]
  return prev ? { ...prev, half: seal.prev.id, carried: true, opensAt: seal.opensAt } : null
}
/** Stored exam for a rule (current half-year, else the previous one), without sitting one. */
export function lastExam(state, id, now = Date.now()) {
  const seal = currentSeal(now), e = state?.exams || {}
  return e[`${seal.id}|${id}`] ? { ...e[`${seal.id}|${id}`], half: seal.id } : e[`${seal.prev.id}|${id}`] ? { ...e[`${seal.prev.id}|${id}`], half: seal.prev.id, carried: true } : (e[id] ? { ...e[id], half: '2026H2' } : null)
}

// ---------------------------------------------------------------- point in time
// Every decision (choosing, checking, ranking, gating) must come out the same whether it is made
// with data that ends at that moment or with later data cut back to it. knownAt() is that cut: it
// keeps only bars that STARTED before `now` (production data holds only finished bars, so live runs
// are unchanged; historical decisions are made at bar boundaries) and drops every cached feature
// so nothing computed from later bars survives.
const CACHES = ['F', 'DF', 'X', 'SF', 'tIdx', '_regime', 'dIdx']
export function knownAt(data, now) {
  if (!Number.isFinite(now) || !data?.coins) return data
  const late = c => c.t?.length && c.t[c.t.length - 1] >= now
  const anyLate = data.coins.some(late) || Object.values(data.bench || {}).some(b => b && late(b))
  if (!anyLate) return data
  const cache = new Map()
  const cut = c => {
    if (!c || !late(c)) return c
    if (cache.has(c)) return cache.get(c)
    let n = 0; while (n < c.t.length && c.t[n] < now) n++
    const out = {}
    for (const [k, v] of Object.entries(c)) {
      if (CACHES.includes(k)) continue
      out[k] = (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length === c.t.length ? v.slice(0, n) : v
    }
    cache.set(c, out)
    return out
  }
  const coins = data.coins.map(cut).filter(c => c.t.length > 0)
  const out = { ...data, coins }
  delete out.leaderCtx; delete out.xs           // caches built from the uncut data
  if (data.bench) out.bench = Object.fromEntries(Object.entries(data.bench).map(([k, b]) => [k, cut(b)]))
  return out
}
/** What a rule's past signals said at time `now`: only trades that had already closed. */
export const closedBy = (ev, now) => Number.isFinite(now) ? ev.filter(e => e.exitT <= now) : ev
