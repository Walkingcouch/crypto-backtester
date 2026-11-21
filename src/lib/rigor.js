// Professional checks every rule must survive before it can trade as "proven" (learning mode still
// paper-trades rules that fail them). Shared by all six labs.
//
//  1. Daily portfolio scoring: each trade is spread over the days it was held and every day is the
//     average of the trades open that day, so ten coins that all fell with Bitcoin on the same day
//     count as one bad day, not ten independent results. Sharpe, annual return and worst fall come
//     from that daily series (an account spread evenly across the rule's open trades).
//  2. Random-entry baseline: the same number of trades, on the same coins, held for the same
//     lengths, but entered at random times. A rule must beat 95% of 200 random runs, otherwise its
//     "edge" is just the market's drift.
//  3. Double fees: the rule must still make money with twice the assumed trading cost.
//  4. Nearby parameters: at least half of the same family's other settings must also make money
//     after costs, or the rule is a lucky spike.
//  5. Trade shuffle: the worst drawdown in 95% of 200 random orderings of the same trades
//     (10% of the account per trade), so a lucky order can't hide the real risk.
//  6. Deflated Sharpe (Bailey & López de Prado 2014): the probability the daily Sharpe is real
//     after allowing for how many rules the lab has ever tried. Must be at least 95%.
//  7. Year by year: results for every calendar year, including bear markets (crypto 2022).
//  9. Portfolio replay: the rule traded with the real account limits (positions at once, size).
// 10. Sealed exam (exam.js): one recorded look at a window nothing was chosen on.
// 11. Luck is counted across EVERY lab and idea ever tried (trial ledger), not per lab.
//  8. Market types: results in up / mixed / down trends and calm / normal / wild markets
//     (regime.js); confirmed differences adjust position size, never switch a rule off.
//
// Fixes (Nov 2026, found investigating the Shares Explorer's too-good results):
//  - the daily series now marks each open trade to its real daily closes (it used to spread the
//    trade's result evenly over the days held, which hid the ups and downs inside a trade and made
//    a 20-day share trade look almost riskless: Sharpe 3.7 instead of about 1)
//  - "beats random" now also needs the rule to beat random entries by at least one round of costs,
//    not just by a statistically detectable sliver (with 10,000 trades a 0.03% gap is "significant")
//  - shares must also beat their market index over the same days by more than costs

import { regimeProfile } from './regime.js'
import { sitExam } from './exam.js'

/** Bumped whenever the checks change, so results made under older checks are re-made. */
export const RIGOR_V = 3

const DAY = 86_400_000
const GAMMA = 0.5772156649

/** Standard normal CDF and its inverse (Acklam's approximation). */
export function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp(-x * x / 2)
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - p : p
}
export function phiInv(p) {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1) }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1) }
  const q = p - 0.5, r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

function rng(seed) {
  let s = (seed >>> 0) || 1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
}
const moments = x => {
  const n = x.length
  if (n < 2) return { n, mean: x[0] || 0, sd: 0, skew: 0, kurt: 3 }
  const mean = x.reduce((a, b) => a + b, 0) / n
  let m2 = 0, m3 = 0, m4 = 0
  for (const v of x) { const d = v - mean; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d }
  m2 /= n; m3 /= n; m4 /= n
  const sd = Math.sqrt(m2 * n / (n - 1))
  return { n, mean, sd, skew: m2 > 0 ? m3 / m2 ** 1.5 : 0, kurt: m2 > 0 ? m4 / (m2 * m2) : 3 }
}

/**
 * Daily portfolio series: each trade's result is spread evenly over the days it was held (as a log
 * return), and each day's return is the average over the trades open that day: an account spread
 * evenly across the rule's open trades. Days with nothing open are 0. Same-day trades on coins that
 * move together are therefore one day's result, not many independent ones.
 */
export function dailySeries(net, data, exitOffset = 0) {
  if (!net.length) return []
  const coins = data ? coinIndex(data) : null
  const sum = new Map(), cnt = new Map()
  let lo = Infinity, hi = -Infinity
  const add = (d, x) => { sum.set(d, (sum.get(d) || 0) + x); cnt.set(d, (cnt.get(d) || 0) + 1) }
  for (const { t, exitT, r, base } of net) {
    if (!(r > -1)) continue
    const total = Math.log(1 + r)
    const a = Math.floor(t / DAY), b = Math.max(a, Math.floor((exitT - 1) / DAY))
    // mark to market: the coin's real close-to-close moves while held, with whatever the closes
    // don't explain (stop fills, costs) put on the exit day so the trade still totals its result
    const c = coins?.get(base)
    const i = c ? c.tIdx.get(t) : null, j = c ? c.tIdx.get(exitT - exitOffset) : null
    if (c && i != null && j != null && j > i) {
      const byDay = new Map()
      let prev = c.o[i + 1], used = 0
      for (let k = i + 1; k <= j; k++) {
        const x = Math.log(c.c[k] / prev); prev = c.c[k]
        if (!Number.isFinite(x)) continue
        const d = Math.floor(c.t[k] / DAY); byDay.set(d, (byDay.get(d) || 0) + x); used += x
      }
      const ds = [...byDay.keys()].sort((x, y) => x - y)
      if (ds.length) {
        byDay.set(ds[ds.length - 1], byDay.get(ds[ds.length - 1]) + (total - used))
        for (const d of ds) { add(d, byDay.get(d)); lo = Math.min(lo, d); hi = Math.max(hi, d) }
        continue
      }
    }
    const per = total / (b - a + 1)
    for (let d = a; d <= b; d++) add(d, per)
    lo = Math.min(lo, a); hi = Math.max(hi, b)
  }
  const out = []
  for (let d = lo; d <= hi; d++) out.push(cnt.get(d) ? Math.expm1(sum.get(d) / cnt.get(d)) : 0)
  return out
}

/** Deflated Sharpe ratio: P(true Sharpe > 0) after the best of `trials` tries, with per-period SR. */
export function deflatedSharpe(sr, T, skew, kurt, trials, srVar) {
  if (!(T > 2) || !Number.isFinite(sr)) return 0
  const N = Math.max(2, trials)
  const V = srVar > 0 ? srVar : 1 / T
  const sr0 = Math.sqrt(V) * ((1 - GAMMA) * phiInv(1 - 1 / N) + GAMMA * phiInv(1 - 1 / (N * Math.E)))
  const den = Math.sqrt(Math.max(1e-9, 1 - skew * sr + (kurt - 1) / 4 * sr * sr))
  return phi((sr - sr0) * Math.sqrt(T - 1) / den)
}

/** Index lookups for the random-entry baseline. */
function coinIndex(data) {
  const m = new Map()
  for (const c of data.coins) { c.tIdx ||= new Map(c.t.map((t, k) => [t, k])); m.set(c.base, c) }
  return m
}

/**
 * Random-entry baseline: for each real trade, a trade on the same coin, held the same number of
 * bars, entered at a random bar (same session for shares). Returns the share of 200 random runs
 * whose average beat the rule's average (a p-value; lower is better).
 */
export function randomBaseline(ev, data, { exitOffset = 0, sims = 200, seed = 7, warmup = 200 } = {}) {
  if (ev.length < 10) return { p: 1, randomMean: 0, n: ev.length }
  const coins = coinIndex(data)
  const legs = []
  for (const e of ev) {
    const c = coins.get(e.base); if (!c) continue
    const i = c.tIdx.get(e.t), j = c.tIdx.get(e.exitT - exitOffset)
    if (i == null || j == null || j <= i) continue
    legs.push([c, j - (i + 1)])            // bars held after entry
  }
  if (legs.length < 10) return { p: 1, randomMean: 0, n: legs.length }
  const real = ev.reduce((a, e) => a + e.g, 0) / ev.length
  const rnd = rng(seed + legs.length)
  let beat = 0, sumMeans = 0
  for (let s = 0; s < sims; s++) {
    let sum = 0
    for (const [c, L] of legs) {
      const n = c.c.length, lo = Math.min(warmup, Math.max(0, n - L - 3))
      let a = 0
      for (let tries = 0; tries < 20; tries++) {
        a = lo + Math.floor(rnd() * Math.max(1, n - L - 2 - lo))
        if (!c.d || c.d[a + 1] === c.d[a + 1 + L]) break   // shares: stay inside one session
      }
      sum += c.c[a + 1 + L] / c.o[a + 1] - 1
    }
    const m = sum / legs.length
    sumMeans += m
    if (m >= real) beat++
  }
  return { p: beat / sims, randomMean: sumMeans / sims, n: legs.length }
}

/** Worst drawdown in 95% of random orderings of the same trades, 10% of the account per trade. */
export function shuffleDrawdown(netR, { sims = 200, size = 0.1, seed = 11 } = {}) {
  if (netR.length < 5) return 0
  const rnd = rng(seed + netR.length), x = netR.slice(), dds = []
  for (let s = 0; s < sims; s++) {
    for (let k = x.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [x[k], x[j]] = [x[j], x[k]] }
    let eq = 1, peak = 1, dd = 0
    for (const r of x) { eq *= 1 + size * r; if (eq > peak) peak = eq; dd = Math.max(dd, 1 - eq / peak) }
    dds.push(dd)
  }
  dds.sort((a, b) => a - b)
  return dds[Math.floor(0.95 * (dds.length - 1))]
}

/**
 * Portfolio replay: the rule's trades in time order, taken only while the account has room:
 * at most `maxOpen` positions, one per coin or share, each using `slot` of the account's value
 * at the time. Returns what the account would actually have made with those limits.
 */
export function portfolioReplay(ev, netOf, { maxOpen = 3, slot = 0.25 } = {}) {
  const list = ev.map(e => ({ t: e.t, exitT: e.exitT, base: e.base, r: netOf(e) })).filter(x => Number.isFinite(x.r)).sort((a, b) => a.t - b.t || (a.base < b.base ? -1 : 1))
  if (!list.length) return null
  let cash = 1, peak = 1, maxDD = 0, taken = 0
  const open = []
  const mark = () => { const eq = cash + open.reduce((a, p) => a + p.alloc, 0); if (eq > peak) peak = eq; maxDD = Math.max(maxDD, 1 - eq / peak); return eq }
  const close = upTo => {
    open.sort((a, b) => a.exitT - b.exitT)
    while (open.length && open[0].exitT <= upTo) { const p = open.shift(); cash += p.alloc * (1 + p.r); mark() }
  }
  for (const x of list) {
    close(x.t)
    if (open.length >= maxOpen || open.some(p => p.base === x.base)) continue
    const alloc = Math.min(cash, slot * mark())
    if (!(alloc > 0)) continue
    cash -= alloc; open.push({ ...x, alloc }); taken++
  }
  close(Infinity)
  const years = Math.max(1 / 12, (list[list.length - 1].exitT - list[0].t) / (365 * DAY))
  return { taken, available: list.length, total: +(cash - 1).toFixed(4), annual: +(Math.pow(Math.max(cash, 1e-9), 1 / years) - 1).toFixed(4), maxDD: +maxDD.toFixed(4), maxOpen, slot: +slot.toFixed(3) }
}

/**
 * Run every check on a lab's tested rules and tighten `pass`.
 * found: [{ id, spec, ev, pass, ... }]; opts: { cost, netOf(e) → net result or null, exitOffset,
 * trials (rules ever tried in this lab), family(f) → string (rules sharing it are "neighbours") }
 */
export function assess(found, data, opts) {
  const { cost = 0, exitOffset = 0, trials = found.length, family = f => f.spec?.kind || f.kind, warmup = 200, portfolio = null, exam = null } = opts
  const netOf = opts.netOf || (e => e.g - cost)
  // first pass: daily Sharpe of every rule (the spread of Sharpes feeds the deflated Sharpe)
  for (const f of found) {
    const net = (f.ev || []).map(e => ({ exitT: e.exitT, t: e.t, base: e.base, r: netOf(e) })).filter(x => Number.isFinite(x.r))
    const daily = dailySeries(net, data, exitOffset)
    const m = moments(daily)
    f._net = net
    f._daily = { T: daily.length, sr: m.sd > 0 ? m.mean / m.sd : 0, skew: m.skew, kurt: m.kurt, mean: m.mean, sd: m.sd, series: daily }
  }
  const srs = found.filter(f => f._daily.T > 30).map(f => f._daily.sr)
  const srVar = moments(srs).sd ** 2
  for (const f of found) { f._n = f._net.length; f._m = f._n ? f._net.reduce((a, x) => a + x.r, 0) / f._n : 0 }
  const meanNet = f => f._m
  for (const f of found) {
    const D = f._daily, net = f._net
    // equity curve of the daily series for drawdown and annual return
    let eq = 1, peak = 1, maxDD = 0
    for (const r of D.series) { eq *= 1 + r; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, 1 - eq / peak) }
    const years = {}
    for (const x of net) { const y = new Date(x.t).getUTCFullYear(); const o = (years[y] ||= { n: 0, sum: 0 }); o.n++; o.sum += x.r }
    for (const y of Object.keys(years)) { years[y].mean = +(years[y].sum / years[y].n).toFixed(5); delete years[y].sum }
    const rb = randomBaseline(f.ev || [], data, { exitOffset, warmup })
    const fam = family(f), sibs = found.filter(o => o !== f && family(o) === fam && o._n >= 30)
    const sibsUp = sibs.filter(o => meanNet(o) > 0).length
    const m = meanNet(f)
    const dsr = deflatedSharpe(D.sr, D.T, D.skew, D.kurt, trials, srVar)
    const evs = f.ev || []
    const grossMean = evs.length ? evs.reduce((a, e) => a + e.g, 0) / evs.length : 0
    const edgeVsRandom = grossMean - rb.randomMean
    // shares: beyond the market index over exactly the same days, after costs
    const exs = evs.filter(e => Number.isFinite(e.ex))
    const idx = exs.length >= 0.8 * evs.length && exs.length >= 30 ? exs.reduce((a, e) => a + e.ex, 0) / exs.length - cost : null
    const checks = {
      random: rb.p <= 0.05 && edgeVsRandom >= cost,
      doubleFee: net.length >= 30 && m - cost > 0,       // a second round of costs on top of the first
      neighbours: !sibs.length || sibsUp / sibs.length >= 0.5,
      deflated: dsr >= 0.95,
      ...(idx != null ? { index: idx > 0 } : {}),
    }
    // with the real account limits (positions at once, size each)
    const pf = portfolio ? portfolioReplay(evs, netOf, portfolio) : null
    if (pf) checks.portfolio = pf.total > 0 && pf.taken >= 20
    // the sealed exam: only for rules that passed everything else; sat once and kept
    let ex = null
    if (exam && f.evAll && Object.values(checks).every(Boolean) && f.pass) { ex = sitExam(exam.state, f.id, f.evAll, netOf, exam.now); checks.sealed = ex.passed }
    else if (exam?.state?.exams?.[f.id]) { ex = exam.state.exams[f.id]; checks.sealed = ex.passed }
    f.rigor = {
      v: RIGOR_V, days: D.T, sharpe: +(D.sr * Math.sqrt(365)).toFixed(2), meanNet: +m.toFixed(5),
      annual: +(Math.pow(eq, 365 / Math.max(1, D.T)) - 1).toFixed(4), maxDD: +maxDD.toFixed(4),
      shuffleDD: +shuffleDrawdown(net.map(x => x.r)).toFixed(4),
      randomP: +rb.p.toFixed(3), randomMean: +rb.randomMean.toFixed(5),
      neighbours: { n: sibs.length, up: sibsUp }, dsr: +dsr.toFixed(3), trials, years, checks,
      ...(pf ? { portfolio: pf } : {}), ...(ex ? { exam: ex } : {}), examRequired: !!exam,
      edgeVsRandom: +edgeVsRandom.toFixed(5), ...(idx != null ? { vsIndex: +idx.toFixed(5) } : {}),
      regime: regimeProfile(f.ev || [], data, e => netOf(e)),
      passedAll: Object.values(checks).every(Boolean) && (!exam || checks.sealed === true),
    }
    f.basicPass = f.pass
    f.pass = !!(f.pass && f.rigor.passedAll)
  }
  for (const f of found) { delete f._net; delete f._daily; delete f._n; delete f._m; delete f.evAll }
  return found.sort((a, b) => (b.pass - a.pass) || b.train.t - a.train.t)
}

/** Running count of distinct rules a lab has ever tested (for the deflated Sharpe). */
export function countTrials(state, ids) {
  if (!state) return ids.length + HUMAN_TRIALS
  const seen = new Set(state.trialIds || [])
  for (const id of ids) seen.add(id)
  state.trialIds = [...seen].slice(-5000)
  state.trials = Math.max(state.trials || 0, seen.size)
  return allTrials(state, state.trials)
}

/** Rule ideas tried by hand while building and redesigning the labs (counted against luck too). */
export const HUMAN_TRIALS = 150
/** Everything ever tried across ALL labs: this lab's count plus the others' (state.trialsOthers is
 *  filled in by the server from the shared trial ledger) plus the hand-made allowance. */
export const allTrials = (state, own) => own + (state?.trialsOthers || 0) + HUMAN_TRIALS
