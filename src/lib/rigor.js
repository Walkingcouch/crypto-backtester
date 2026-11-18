// Professional checks every rule must survive before it can trade as "proven" (learning mode still
// paper-trades rules that fail them). Shared by all six labs.
//
//  1. Daily portfolio scoring: trades are grouped by the day they close, so ten coins that all fell
//     with Bitcoin on the same day count as one bad day, not ten independent results. Sharpe,
//     annual return and drawdown come from that daily series.
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

/** Daily series: each day = average net result of trades closing that day; 0 on days with none. */
export function dailySeries(net) {
  if (!net.length) return []
  const by = new Map()
  for (const { exitT, r } of net) { const d = Math.floor(exitT / DAY); const x = by.get(d) || [0, 0]; x[0] += r; x[1]++; by.set(d, x) }
  const days = [...by.keys()].sort((a, b) => a - b)
  const out = []
  for (let d = days[0]; d <= days[days.length - 1]; d++) { const x = by.get(d); out.push(x ? x[0] / x[1] : 0) }
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
 * Run every check on a lab's tested rules and tighten `pass`.
 * found: [{ id, spec, ev, pass, ... }]; opts: { cost, netOf(e) → net result or null, exitOffset,
 * trials (rules ever tried in this lab), family(f) → string (rules sharing it are "neighbours") }
 */
export function assess(found, data, opts) {
  const { cost = 0, exitOffset = 0, trials = found.length, family = f => f.spec?.kind || f.kind, warmup = 200 } = opts
  const netOf = opts.netOf || (e => e.g - cost)
  // first pass: daily Sharpe of every rule (the spread of Sharpes feeds the deflated Sharpe)
  for (const f of found) {
    const net = (f.ev || []).map(e => ({ exitT: e.exitT, t: e.t, r: netOf(e) })).filter(x => Number.isFinite(x.r))
    const daily = dailySeries(net)
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
    for (const r of D.series) { eq *= 1 + 0.1 * r; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, 1 - eq / peak) }
    const years = {}
    for (const x of net) { const y = new Date(x.t).getUTCFullYear(); const o = (years[y] ||= { n: 0, sum: 0 }); o.n++; o.sum += x.r }
    for (const y of Object.keys(years)) { years[y].mean = +(years[y].sum / years[y].n).toFixed(5); delete years[y].sum }
    const rb = randomBaseline(f.ev || [], data, { exitOffset, warmup })
    const fam = family(f), sibs = found.filter(o => o !== f && family(o) === fam && o._n >= 30)
    const sibsUp = sibs.filter(o => meanNet(o) > 0).length
    const m = meanNet(f)
    const dsr = deflatedSharpe(D.sr, D.T, D.skew, D.kurt, trials, srVar)
    const checks = {
      random: rb.p <= 0.05,
      doubleFee: net.length >= 30 && m - cost > 0,       // a second round of costs on top of the first
      neighbours: !sibs.length || sibsUp / sibs.length >= 0.5,
      deflated: dsr >= 0.95,
    }
    f.rigor = {
      days: D.T, sharpe: +(D.sr * Math.sqrt(365)).toFixed(2), meanNet: +m.toFixed(5),
      annual: +((Math.pow(1 + 0.1 * D.mean, 365) - 1)).toFixed(4), maxDD: +maxDD.toFixed(4),
      shuffleDD: +shuffleDrawdown(net.map(x => x.r)).toFixed(4),
      randomP: +rb.p.toFixed(3), randomMean: +rb.randomMean.toFixed(5),
      neighbours: { n: sibs.length, up: sibsUp }, dsr: +dsr.toFixed(3), trials, years, checks,
      passedAll: Object.values(checks).every(Boolean),
    }
    f.basicPass = f.pass
    f.pass = !!(f.pass && f.rigor.passedAll)
  }
  for (const f of found) { delete f._net; delete f._daily; delete f._n; delete f._m }
  return found.sort((a, b) => (b.pass - a.pass) || b.train.t - a.train.t)
}

/** Running count of distinct rules a lab has ever tested (for the deflated Sharpe). */
export function countTrials(state, ids) {
  if (!state) return ids.length
  const seen = new Set(state.trialIds || [])
  for (const id of ids) seen.add(id)
  state.trialIds = [...seen].slice(-5000)
  state.trials = Math.max(state.trials || 0, seen.size)
  return state.trials
}
