// Market types ("regimes") and how each rule behaves across them.
//
// Every trade is tagged with the market it was bought into, judged on the market leader (Bitcoin
// for crypto, the S&P 500 fund for US shares, the ASX 200 fund for ASX shares) using only days
// that had already closed:
//   trend:      up    = leader above its 200-day average AND its last 30 days were up
//               down  = below its 200-day average AND its last 30 days were down
//               mixed = anything else (the two signals disagree)
//   volatility: calm / normal / wild = the leader's last-30-day swings in the lower, middle or
//               upper third of its own previous year
//
// A rule is never simply switched off for a market type. Instead:
//   1. Its results are kept for EVERY type, so each type is always compared with the others.
//   2. A type only counts as "suits" or "struggles" once that difference is confirmed: at least
//      30 trades in the type, a gap to the other types of at least 2.5 standard errors (days are
//      counted once, so trades bought on the same day aren't treated as independent), and the
//      same direction in both the older and the newer half of the history.
//   3. Confirmed differences change position SIZE, not permission: from a quarter of normal size
//      (struggles) to one and a half times (suits), using a cautious estimate pulled towards the
//      rule's overall average. Unconfirmed differences leave size at normal.
const DAY = 86_400_000
export const LEADERS = { '': 'BTC', US: 'SPY', ASX: 'STW.AX' }
export const TRENDS = ['up', 'mixed', 'down'], VOLS = ['calm', 'normal', 'wild']
export const MIN_CELL = 30, CONFIRM_Z = 2.5, PRIOR = 100, W_MIN = 0.25, W_MAX = 1.5

/** Daily closes of a coin (hourly bars are reduced to the last close of each UTC day). */
function dailyCloses(c) {
  const days = [], close = []
  for (let k = 0; k < c.t.length; k++) {
    const d = Math.floor(c.t[k] / DAY)
    if (days.length && days[days.length - 1] === d) close[close.length - 1] = c.c[k]
    else { days.push(d); close.push(c.c[k]) }
  }
  return { days, close }
}

/** Map of UTC day number → { trend, vol } for one leader, using closes up to that day. */
export function regimeSeries(leader) {
  if (!leader?.t?.length) return null
  if (leader._regime) return leader._regime
  const { days, close } = dailyCloses(leader)
  const out = new Map(), vols = []
  let s200 = 0
  for (let i = 0; i < close.length; i++) {
    s200 += close[i]; if (i >= 200) s200 -= close[i - 200]
    let vol = NaN
    if (i >= 30) { let m = 0; const r = []; for (let k = i - 29; k <= i; k++) { const x = Math.log(close[k] / close[k - 1]); r.push(x); m += x } m /= 30; vol = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / 29) }
    vols.push(vol)
    if (i < 230) continue
    const above = close[i] > s200 / 200, up30 = close[i] > close[i - 30]
    const trend = above && up30 ? 'up' : !above && !up30 ? 'down' : 'mixed'
    const past = vols.slice(Math.max(0, i - 365), i).filter(Number.isFinite).sort((a, b) => a - b)
    let v = 'normal'
    if (past.length >= 100 && Number.isFinite(vol)) { const rank = past.findIndex(x => x >= vol); const q = (rank < 0 ? past.length : rank) / past.length; v = q < 1 / 3 ? 'calm' : q > 2 / 3 ? 'wild' : 'normal' }
    out.set(days[i], { trend, vol: v })
  }
  return (leader._regime = out)
}

/** Leader coin for a market inside a dataset (crypto: BTC among the coins; shares: data.bench). */
export function leaderOf(data, market = '') {
  if (market && data.bench?.[market]) return data.bench[market]
  const want = LEADERS[market || '']
  return data.coins.find(c => c.base === want || c.base === want.replace('.AX', ''))
}

/** Market type in force when a signal at time t is acted on: the last day that had closed. */
export function regimeAt(data, market, t) {
  const S = regimeSeries(leaderOf(data, market))
  if (!S) return null
  for (let d = Math.floor(t / DAY) - 1, k = 0; k < 7; d--, k++) { const r = S.get(d); if (r) return r }
  return null
}

const dayClustered = rows => {           // mean and standard error with each day counted once
  const byDay = new Map()
  for (const r of rows) { const d = Math.floor(r.t / DAY); const o = byDay.get(d) || { s: 0, n: 0 }; o.s += r.x; o.n++; byDay.set(d, o) }
  const xs = [...byDay.values()].map(o => o.s / o.n)
  const n = rows.length, mean = n ? rows.reduce((a, r) => a + r.x, 0) / n : 0
  const k = xs.length, m = k ? xs.reduce((a, b) => a + b, 0) / k : 0
  const sd = k > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (k - 1)) : 0
  return { n, days: k, mean, se: k > 1 ? sd / Math.sqrt(k) : Infinity }
}

/**
 * Profile of one rule across market types. ev: [{ t, m, ... }], netOf(e) → net result.
 * Returns { cells: { trend: {up:{n,mean}, …}, vol: {…} }, verdicts: { trend: {up:'suits'|'struggles'|'leans better'|'leans worse'|'same'|'too few'} … },
 *           weights: { trend: {up: 1.2, …}, vol: {…} }, summary: 'Suits downtrends (confirmed) …' }
 */
export function regimeProfile(ev, data, netOf) {
  const rows = []
  for (const e of ev || []) {
    const x = netOf(e)
    if (!Number.isFinite(x)) continue
    const r = regimeAt(data, e.m || '', e.t)
    if (r) rows.push({ t: e.t, x, trend: r.trend, vol: r.vol })
  }
  if (rows.length < MIN_CELL) return null
  const all = dayClustered(rows)
  const mid = [...rows].sort((a, b) => a.t - b.t)[Math.floor(rows.length / 2)].t
  const scale = Math.max(Math.abs(all.mean), 0.005)
  const out = { n: rows.length, mean: +all.mean.toFixed(5), cells: {}, verdicts: {}, weights: {} }
  const notes = []
  for (const [dim, keys] of [['trend', TRENDS], ['vol', VOLS]]) {
    out.cells[dim] = {}; out.verdicts[dim] = {}; out.weights[dim] = {}
    for (const k of keys) {
      const inK = rows.filter(r => r[dim] === k), rest = rows.filter(r => r[dim] !== k)
      const a = dayClustered(inK), b = dayClustered(rest)
      out.cells[dim][k] = { n: a.n, mean: +a.mean.toFixed(5) }
      let verdict = 'same', w = 1
      if (a.n < MIN_CELL || b.n < MIN_CELL) verdict = 'too few'
      else {
        const z = (a.mean - b.mean) / Math.sqrt(a.se ** 2 + b.se ** 2)
        const half = (lo, hi) => { const x = dayClustered(inK.filter(r => r.t >= lo && r.t < hi)), y = dayClustered(rest.filter(r => r.t >= lo && r.t < hi)); return x.n >= 10 && y.n >= 10 ? Math.sign(x.mean - y.mean) : 0 }
        const h1 = half(-Infinity, mid), h2 = half(mid, Infinity)
        const steady = h1 !== 0 && h1 === h2 && h1 === Math.sign(a.mean - b.mean)
        out.cells[dim][k].z = +z.toFixed(2)
        if (Math.abs(z) >= CONFIRM_Z && steady) {
          verdict = z > 0 ? 'suits' : 'struggles'
          const shrunk = (a.n * a.mean + PRIOR * all.mean) / (a.n + PRIOR)
          w = Math.max(W_MIN, Math.min(W_MAX, 1 + (shrunk - all.mean) / scale))
          if (a.mean <= 0 && verdict === 'suits') w = 1          // better than elsewhere but still losing: no boost
        } else if (Math.abs(z) >= 1.5) verdict = z > 0 ? 'leans better' : 'leans worse'
      }
      out.verdicts[dim][k] = verdict
      out.weights[dim][k] = +w.toFixed(2)
      if (verdict === 'suits' || verdict === 'struggles') notes.push(`${verdict} in ${dim === 'trend' ? `${k === 'mixed' ? 'mixed' : k}trend` : `${k}`} markets`)
    }
  }
  out.summary = notes.length ? `Confirmed: ${notes.join(', ')}.` : 'No confirmed difference between market types yet.'
  return out
}

/** Size multiplier for a rule right now: trend weight × volatility weight, 0.25 to 1.5. */
export function regimeWeight(profile, regime) {
  if (!profile || !regime) return 1
  const w = (profile.weights?.trend?.[regime.trend] ?? 1) * (profile.weights?.vol?.[regime.vol] ?? 1)
  return Math.max(W_MIN, Math.min(W_MAX, w))
}
