// Recommendation engine (plain JS, shared by the website and the server).
//
// Built from published research, with fixed settings (nothing tuned to the data):
//  - Trend / time-series momentum is the best-supported crypto return predictor
//    (Liu & Tsyvinski, Review of Financial Studies 2021; Zarattini, Pagani & Barbon 2025:
//    ensemble trend rules on the top-20 most liquid coins, volatility-sized, Sharpe > 1.5 net of fees).
//  - Anomalies in small coins are untradeable; momentum survives in large coins, long side
//    (Fieberg, Liedtke & Zaremba 2024) → universe = 20 most-traded coins, long-only.
//  - Low-volatility coins / volatility-based sizing improve risk-adjusted returns
//    (Kaya & Mostowfi 2022) → positions sized by inverse volatility, capped.
//  - Illiquid coins reverse day to day (Zaremba et al. 2021) → no 1-day signals, weekly rebalance.
//
// Every decision on day i uses data up to day i; trades happen at the NEXT day's close.

export const SETTINGS = {
  universe: 20,          // most-traded coins considered (30-day average volume)
  minHistory: 200,       // days of history a coin needs
  lookbacks: [20, 40, 80, 160],
  buyScore: 0.75,        // share of trend checks that must be positive to hold a coin
  riskPerCoin: 0.06,     // each position sized to ~6% annual volatility of the whole pot
  maxWeight: 0.2,        // no coin above 20%
  rebalanceDays: 7,
  minTrade: 0.02,        // skip changes smaller than 2% of the pot (saves fees)
  slippage: 0.0005,
}

const nan = x => !Number.isFinite(x)

/**
 * data = { days: number[] (UTC ms), coins: [{ base, close: number[], qv: number[] }] }
 * arrays aligned to `days`, NaN before a coin was listed.
 */
export function analyseCoin(coin, i, S = SETTINGS) {
  const c = coin.close
  if (nan(c[i])) return null
  let first = i
  while (first > 0 && !nan(c[first - 1])) first--
  const history = i - first + 1
  if (history < S.minHistory) return null
  const checks = []
  for (const L of S.lookbacks) {
    if (i - L < first) { checks.push(null, null); continue }
    let s = 0
    for (let k = i - L + 1; k <= i; k++) s += c[k]
    const sma = s / L
    checks.push(c[i] / c[i - L] - 1 > 0, c[i] > sma)
  }
  const valid = checks.filter(x => x !== null)
  const score = valid.length ? valid.filter(Boolean).length / valid.length : 0
  // 60-day volatility (annualised)
  const W = Math.min(60, history - 1)
  let m = 0
  const rs = []
  for (let k = i - W + 1; k <= i; k++) { const r = Math.log(c[k] / c[k - 1]); rs.push(r); m += r }
  m /= rs.length
  const vol = Math.sqrt(rs.reduce((a, r) => a + (r - m) ** 2, 0) / (rs.length - 1) * 365)
  // momentum quality: average lookback return per unit of volatility
  let mom = 0, n = 0
  for (const L of S.lookbacks) if (i - L >= first) { mom += Math.log(c[i] / c[i - L]) / (vol * Math.sqrt(L / 365)); n++ }
  let qv = 0, qn = 0
  for (let k = Math.max(first, i - 29); k <= i; k++) if (!nan(coin.qv[k])) { qv += coin.qv[k]; qn++ }
  return {
    base: coin.base, price: c[i], score, checks: valid.filter(Boolean).length, of: valid.length,
    vol, mom: n ? mom / n : 0, avgVolume: qn ? qv / qn : 0, history,
    r30: i >= 30 && !nan(c[i - 30]) ? c[i] / c[i - 30] - 1 : NaN,
    r90: i >= 90 && !nan(c[i - 90]) ? c[i] / c[i - 90] - 1 : NaN,
  }
}

/** The recommendation on day i: universe, each coin's verdict, and target weights. */
export function picksAt(data, i, S = SETTINGS) {
  const all = data.coins.map(c => analyseCoin(c, i, S)).filter(Boolean)
  const universe = all.sort((a, b) => b.avgVolume - a.avgVolume).slice(0, S.universe)
  let total = 0
  for (const a of universe) {
    a.verdict = a.score >= S.buyScore ? 'buy' : a.score >= 0.5 ? 'hold' : 'avoid'
    a.weight = a.verdict === 'buy' ? Math.min(S.maxWeight, a.score * S.riskPerCoin / Math.max(a.vol, 0.05)) : 0
    total += a.weight
  }
  if (total > 1) for (const a of universe) a.weight /= total
  universe.sort((a, b) => b.weight - a.weight || b.score - a.score || b.mom - a.mom)
  return { day: data.days[i], universe, cash: Math.max(0, 1 - Math.min(1, total)) }
}

function metrics(eq, days) {
  const n = eq.length
  if (n < 2) return null
  const years = (days[n - 1] - days[0]) / (365 * 86_400_000)
  const rets = []
  for (let k = 1; k < n; k++) rets.push(eq[k] / eq[k - 1] - 1)
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1))
  let peak = -Infinity, mdd = 0
  for (const e of eq) { peak = Math.max(peak, e); mdd = Math.min(mdd, e / peak - 1) }
  return {
    multiple: eq[n - 1] / eq[0], cagr: Math.pow(eq[n - 1] / eq[0], 1 / years) - 1,
    sharpe: sd > 0 ? (mean * 365) / (sd * Math.sqrt(365)) : 0, maxDrawdown: mdd, years,
  }
}

/**
 * Walk-forward test of following the recommendations: decide at day i's close, trade at
 * day i+1's close, pay `fee` (fraction) + slippage on everything traded.
 * Benchmarks: BTC buy & hold, and an equal-weight basket of the 10 most-traded coins
 * (rebalanced monthly) with the same costs.
 */
export function backtestPicks(data, fee, S = SETTINGS, startIndex) {
  const D = data.days.length
  const btc = data.coins.find(c => c.base === 'BTC')
  const start = startIndex ?? Math.max(S.minHistory + 5, data.days.findIndex((_, i) => btc && !nan(btc.close[i])) + S.minHistory)
  const cost = fee + S.slippage
  const idx = new Map(data.coins.map((c, k) => [c.base, k]))

  function run(decide, every) {
    let cash = 1, units = new Float64Array(data.coins.length)
    const eq = [], days = [], exposure = []
    let pending = null, trades = 0, feesPaid = 0
    for (let i = start; i < D; i++) {
      const px = k => data.coins[k].close[i]
      if (pending) {         // execute yesterday's decision at today's close
        let value = cash
        for (let k = 0; k < units.length; k++) if (units[k]) value += units[k] * (nan(px(k)) ? 0 : px(k))
        // sells first, then buys (never spending more cash than is there after fees)
        for (const pass of ['sell', 'buy']) {
          for (let k = 0; k < units.length; k++) {
            const p = px(k)
            if (nan(p) || p <= 0) continue
            const cur = units[k] * p / value
            const tgt = pending.get(k) ?? 0
            if (Math.abs(tgt - cur) < S.minTrade && !(tgt === 0 && cur > 0)) continue
            let delta = (tgt - cur) * value
            if ((pass === 'sell') !== (delta < 0)) continue
            if (delta > 0) delta = Math.min(delta, Math.max(0, cash) / (1 + cost))
            if (Math.abs(delta) < 1e-12) continue
            const c = Math.abs(delta) * cost
            units[k] += delta / p
            cash -= delta + c
            feesPaid += c; trades++
          }
        }
        pending = null
      }
      let value = cash, held = 0
      for (let k = 0; k < units.length; k++) if (units[k]) { const p = px(k); const v = units[k] * (nan(p) ? 0 : p); value += v; held += v }
      eq.push(value); days.push(data.days[i]); exposure.push(value > 0 ? held / value : 0)
      if ((i - start) % every === 0 && i < D - 1) pending = decide(i)
    }
    return { eq, days, exposure, trades, feesPaid, metrics: metrics(eq, days) }
  }

  const strategy = run(i => {
    const p = picksAt(data, i, S)
    return new Map(p.universe.filter(a => a.weight > 0).map(a => [idx.get(a.base), a.weight]))
  }, S.rebalanceDays)
  const btcOnly = run(() => new Map([[idx.get('BTC'), 1]]), 100000)
  const basket = run(i => {
    const p = picksAt(data, i, S)
    const top = p.universe.slice().sort((a, b) => b.avgVolume - a.avgVolume).slice(0, 10)
    return new Map(top.map(a => [idx.get(a.base), 1 / top.length]))
  }, 30)
  const avgExposure = strategy.exposure.reduce((a, b) => a + b, 0) / strategy.exposure.length
  return { start: data.days[start], fee, strategy: { ...strategy, avgExposure }, btc: btcOnly, basket }
}
