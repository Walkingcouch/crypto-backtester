// Forecast engine (plain JS so the website and the daily server job share it exactly).
//
// Every estimate "at day t" uses closes[0..t] only — nothing after t — so the same code
// can be scored honestly on the past (walk-forward) and run live.
//
// 1. Range: today's volatility (EWMA, λ=0.94) blended toward the coin's long-run level
//    over the horizon (vol mean-reverts), times the coin's own historical distribution of
//    volatility-adjusted h-day moves (fat tails included). Centred on today's price:
//    no direction is assumed.
// 2. Similar moments: past days that looked like today (7- and 30-day move relative to
//    volatility, and trend state), spaced apart, and what happened h days later.
// 3. Chance higher: the similar-moments rate, shrunk toward the coin's all-history rate.

const LAMBDA = 0.94
const PHI = 0.97          // daily persistence of volatility shocks
const WARM = 60           // days before volatility estimates are trusted
const LONG_WIN = 365      // long-run volatility window
const MIN_HISTORY = 300   // closes needed before forecasting
const QS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]

export const HORIZONS = [
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
]

/** Precompute per-day quantities from daily closes (oldest first). */
export function prepare(closes) {
  const n = closes.length
  const c = Float64Array.from(closes)
  const r = new Float64Array(n)
  for (let i = 1; i < n; i++) r[i] = Math.log(c[i] / c[i - 1])

  const ew = new Float64Array(n).fill(NaN)   // EWMA daily variance at i (uses r[..i])
  const lr = new Float64Array(n).fill(NaN)   // long-run daily variance at i
  let v = 0, sum2 = 0
  for (let i = 1; i < n; i++) {
    sum2 += r[i] * r[i]
    if (i > LONG_WIN) sum2 -= r[i - LONG_WIN] * r[i - LONG_WIN]
    if (i === WARM) v = sum2 / WARM
    else if (i > WARM) v = LAMBDA * v + (1 - LAMBDA) * r[i] * r[i]
    if (i >= WARM) { ew[i] = v; lr[i] = sum2 / Math.min(i, LONG_WIN) }
  }

  const sma = (len) => {
    const out = new Float64Array(n).fill(NaN)
    let s = 0
    for (let i = 0; i < n; i++) { s += c[i]; if (i >= len) s -= c[i - len]; if (i >= len - 1) out[i] = s / len }
    return out
  }
  const s50 = sma(50), s200 = sma(200)
  const trend = new Int8Array(n) // 1 up, -1 down, 0 mixed/unknown
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(s200[i])) continue
    trend[i] = c[i] > s50[i] && s50[i] > s200[i] ? 1 : c[i] < s50[i] && s50[i] < s200[i] ? -1 : 0
  }
  return { n, c, r, ew, lr, trend, cache: new Map() }
}

/**
 * Attach a daily market-mood series (e.g. Fear & Greed, 0–100) to prepared data.
 * dayTimes = the timestamps of the closes; history = [[ms, value], ...]. Each day takes the
 * latest reading published on or before it (so nothing from the future leaks in).
 */
export function attachMood(P, dayTimes, history) {
  const m = new Float64Array(P.n).fill(NaN)
  let k = -1
  const H = history.slice().sort((a, b) => a[0] - b[0])
  for (let i = 0; i < P.n; i++) {
    while (k + 1 < H.length && H[k + 1][0] <= dayTimes[i] + 86_400_000 - 1) k++
    if (k >= 0 && dayTimes[i] - H[k][0] < 3 * 86_400_000) m[i] = H[k][1]
  }
  P.mood = m
  P.cache.clear()
  return P
}

/** Expected standard deviation of the log move over h days, estimated at day i. */
export function horizonSd(P, i, h) {
  const now = P.ew[i], long = P.lr[i]
  if (!(now > 0) || !(long > 0)) return NaN
  const avg = long + (now - long) * (1 - Math.pow(PHI, h)) / (h * (1 - PHI))
  return Math.sqrt(Math.max(avg, 1e-12) * h)
}

/** Volatility-adjusted h-day outcomes z_j for every start day j (known once j+h has passed). */
function zSeries(P, h) {
  const key = 'z' + h
  if (!P.cache.has(key)) {
    const z = new Float64Array(P.n).fill(NaN)
    for (let j = WARM; j + h < P.n; j++) {
      const sd = horizonSd(P, j, h)
      if (sd > 0) z[j] = Math.log(P.c[j + h] / P.c[j]) / sd
    }
    P.cache.set(key, z)
  }
  return P.cache.get(key)
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function features(P, j) {
  const f7 = j >= 7 ? Math.log(P.c[j] / P.c[j - 7]) / (horizonSd(P, j, 7) || NaN) : NaN
  const f30 = j >= 30 ? Math.log(P.c[j] / P.c[j - 30]) / (horizonSd(P, j, 30) || NaN) : NaN
  return [f7, f30, P.trend[j]]
}

/**
 * Forecast for h days after day t, using closes[0..t] only.
 * Returns null if there isn't enough history.
 */
export function forecastAt(P, t, h, opts = {}) {
  const useMood = !!opts.mood && !!P.mood && Number.isFinite(P.mood[t])
  if (t < MIN_HISTORY || t >= P.n) return null
  const sd = horizonSd(P, t, h)
  if (!(sd > 0)) return null
  const price = P.c[t]

  // 1. range from past outcomes that were already known at t (j + h <= t)
  const z = zSeries(P, h)
  const past = []
  for (let j = WARM; j + h <= t; j++) if (Number.isFinite(z[j])) past.push(z[j])
  if (past.length < 100) return null
  past.sort((a, b) => a - b)
  const med = quantile(past, 0.5)
  // Raw (not volatility-adjusted) h-day log moves, known at t. Over long horizons trends
  // dominate and today's volatility says less, so blend toward these, and never go
  // narrower than them.
  const raw = []
  for (let j = 1; j + h <= t; j++) raw.push(Math.log(P.c[j + h] / P.c[j]))
  raw.sort((a, b) => a - b)
  const rmed = quantile(raw, 0.5)
  const w = Math.exp(-h / 45)            // 7d ≈ 0.86, 1m ≈ 0.51, 3m ≈ 0.14 weight on today's volatility
  const levels = {}
  for (const q of QS) {
    const cond = (quantile(past, q) - med) * sd
    const unc = quantile(raw, q) - rmed
    let x = w * cond + (1 - w) * unc
    if (h >= 30 && Math.abs(unc) > Math.abs(x)) x = (x + unc) / 2
    levels['p' + Math.round(q * 100)] = price * Math.exp(x)
  }

  // base rate: how often the coin was higher h days later, all history known at t
  let up = 0, all = 0
  for (let j = WARM; j + h <= t; j++) { all++; if (P.c[j + h] > P.c[j]) up++ }
  const baseUp = all ? up / all : 0.5

  // 2. similar moments
  const [F7, F30, T] = features(P, t)
  const M = useMood ? P.mood[t] : NaN
  const cands = []
  for (let j = 210; j + h <= t; j++) {
    const [f7, f30, tr] = features(P, j)
    if (!Number.isFinite(f7) || !Number.isFinite(f30)) continue
    let d = (f7 - F7) ** 2 + (f30 - F30) ** 2 + (tr === T ? 0 : 1)
    if (useMood) { if (!Number.isFinite(P.mood[j])) continue; d += ((P.mood[j] - M) / 15) ** 2 }
    cands.push([d, j])
  }
  cands.sort((a, b) => a[0] - b[0])
  const K = 40, gap = Math.max(5, Math.round(h / 3))
  const picked = []
  for (const [, j] of cands) {
    if (picked.every(p => Math.abs(p - j) >= gap)) picked.push(j)
    if (picked.length >= K) break
  }
  const outs = picked.map(j => P.c[j + h] / P.c[j] - 1).sort((a, b) => a - b)
  const aUp = outs.length ? outs.filter(x => x > 0).length / outs.length : baseUp
  const PRIOR = 30
  const pUp = (aUp * outs.length + baseUp * PRIOR) / (outs.length + PRIOR)

  // situation
  let volRank = 0, volN = 0
  for (let j = WARM; j <= t; j++) if (P.ew[j] > 0) { volN++; if (P.ew[j] <= P.ew[t]) volRank++ }

  return {
    t, h, price, sd, levels, pUp, baseUp, usedMood: useMood, mood: useMood ? M : null,
    analog: {
      n: outs.length, up: aUp, idx: picked,
      p10: quantile(outs, 0.1), median: quantile(outs, 0.5), p90: quantile(outs, 0.9),
      worst: outs[0] ?? NaN, best: outs[outs.length - 1] ?? NaN, outcomes: outs,
    },
    situation: {
      r7: t >= 7 ? price / P.c[t - 7] - 1 : NaN,
      r30: t >= 30 ? price / P.c[t - 30] - 1 : NaN,
      trend: T,
      volPct: volN ? volRank / volN : NaN,
      dailyVol: Math.sqrt(P.ew[t]),
    },
  }
}

/**
 * Walk-forward track record: make the forecast on past days exactly as it would have been
 * made then, and compare with what actually happened h days later.
 */
export function trackRecord(P, h, step = 3, from = MIN_HISTORY, opts = {}) {
  let n = 0, in50 = 0, in80 = 0, in90 = 0, hit = 0, brier = 0, brierBase = 0, brierCoin = 0, upCount = 0
  const bins = Array.from({ length: 5 }, () => ({ n: 0, p: 0, y: 0 }))
  let first = -1, last = -1
  for (let t = from; t + h < P.n; t += step) {
    const f = forecastAt(P, t, h, opts)
    if (!f || (opts.mood && !f.usedMood)) continue
    const y = P.c[t + h], L = f.levels, upY = y > f.price ? 1 : 0
    n++; if (first < 0) first = t; last = t
    if (y >= L.p25 && y <= L.p75) in50++
    if (y >= L.p10 && y <= L.p90) in80++
    if (y >= L.p5 && y <= L.p95) in90++
    if ((f.pUp >= 0.5 ? 1 : 0) === upY) hit++
    upCount += upY
    brier += (f.pUp - upY) ** 2
    brierBase += (f.baseUp - upY) ** 2
    brierCoin += (0.5 - upY) ** 2
    const b = bins[Math.min(4, Math.max(0, Math.floor((f.pUp - 0.3) / 0.08)))]
    b.n++; b.p += f.pUp; b.y += upY
  }
  return {
    n, h, step, first, last,
    cover50: n ? in50 / n : NaN, cover80: n ? in80 / n : NaN, cover90: n ? in90 / n : NaN,
    hitRate: n ? hit / n : NaN, upRate: n ? upCount / n : NaN,
    brier: n ? brier / n : NaN, brierBase: n ? brierBase / n : NaN, brierCoin: n ? brierCoin / n : NaN,
    bins: bins.filter(b => b.n).map(b => ({ n: b.n, predicted: b.p / b.n, actual: b.y / b.n })),
  }
}

/** For each Fear & Greed zone: how the coin did h days later (all history up to the end). */
export function moodZones(P, h) {
  const Z = [['Extreme fear', 0, 25], ['Fear', 25, 46], ['Neutral', 46, 55], ['Greed', 55, 76], ['Extreme greed', 76, 101]]
  if (!P.mood) return []
  return Z.map(([name, lo, hi]) => {
    const outs = []
    for (let j = 0; j + h < P.n; j++) { const m = P.mood[j]; if (m >= lo && m < hi) outs.push(P.c[j + h] / P.c[j] - 1) }
    outs.sort((a, b) => a - b)
    return { name, lo, hi, n: outs.length, up: outs.length ? outs.filter(x => x > 0).length / outs.length : NaN, median: quantile(outs, 0.5) }
  })
}
