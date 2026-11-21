// The Lab: a paper-trading loop that finds its own rules, judges them on results,
// promotes better ones and rolls back worse ones. Plain JS, shared by the server job
// (api/lab-cron.js) and the Lab page.
//
// How it differs from "rewrite the prompt after every losing trade":
//  - Rules are judged on BATCHES of trades, never one loss (one trade is mostly luck).
//  - A rule has to work on data it was never chosen on (train → validate split).
//  - New rules trade on paper beside the current one ("shadow") and only take over when
//    their own live record is better. The previous rule stays in the shadow, so if the new
//    one does worse it is rolled back automatically.
//  - Mark's cost gate: open a position only when the conservative gain estimate (from all
//    comparable past signals, losers included) beats the full round-trip cost plus a margin.
//    Stops always execute, even at a loss.
//  - Risk limits are fixed here and are never changed by the loop.

import { assess, countTrials } from './rigor.js'
import { regimeAt, regimeWeight } from './regime.js'
import { preSeal, sealedLast } from './exam.js'
import { btcContext, comboSignal, describeCombo } from './blocks.js'

export const DAY = 86_400_000

export const LAB = {
  universe: 20,          // most-traded coins scanned
  margin: 0.003,         // safety margin added to costs in the gate (0.3%)
  slippage: 0.001,       // assumed slippage per side (0.1%)
  maxPosition: 0.10,     // no position above 10% of the account
  riskPerTrade: 0.01,    // a stop-out loses at most ~1% of the account
  maxOpen: 8,
  maxInvested: 0.6,      // at least 40% always in cash
  validDays: 180,        // last 180 days held back to check each rule
  refCost: 0.008,        // round-trip cost used when choosing rules (0.1% fee ×2, spread, slippage)
  minTrain: 30, minTrainT: 2.0, minValid: 30,    // was 8: too few held-back trades to mean anything
  maxChallengers: 3,
  promoteAfter: 12,      // closed live trades needed before a promotion / rollback
  promoteBy: 0.002,      // a challenger must beat the champion by 0.2% per trade
  coachEveryDays: 7,
}

export const ACCOUNTS = [
  { id: 'john', owner: 'CoinSpot', broker: 'coinspot', exchange: 'CoinSpot', fee: 0.01, feeLabel: '1% instant buy/sell (every coin; what the live bot pays)', startAud: 1000 },
  { id: 'mark', owner: 'Coinbase', broker: 'coinbase', exchange: 'Coinbase Advanced', fee: 0.006, feeLabel: 'about 0.6% taker (regional since Sep 2026; check your account)', startAud: 1000 },
  { id: 'binance', owner: 'Binance', broker: 'binance', exchange: 'Binance', fee: 0.001, feeLabel: '0.1% spot (0.075% paying fees in BNB)', startAud: 1000 },
]
const freshAccount = (a, audPerUsd) => ({
  ...a, startUsd: a.startAud / audPerUsd, cashAud: a.startAud, positions: [], closed: [],
  stats: { n: 0, wins: 0, sumNet: 0 }, blocked: { cost: 0, quote: 0, limits: 0 }, lastBlocked: [],
})

// ---------------------------------------------------------------- rules
const REGIMES = { any: 'any', quiet: 'after a quiet fortnight', loud: 'after a wild fortnight' }

export function allRules() {
  const out = []
  for (const n of [20, 55]) for (const regime of ['any', 'quiet', 'loud']) for (const H of [5, 10, 20]) out.push({ kind: 'breakout', n, regime, H })
  for (const k of [1.5, 2.5]) for (const regime of ['any', 'quiet']) for (const H of [3, 5, 10]) out.push({ kind: 'dip', k, regime, H })
  for (const regime of ['any', 'quiet']) for (const H of [5, 10, 20]) out.push({ kind: 'surge', regime, H })
  for (const H of [3, 5, 10]) out.push({ kind: 'crash', regime: 'any', H })
  return out.map(r => ({ ...r, id: ruleId(r) }))
}
export const ruleId = r => [r.kind, r.n ?? r.k ?? '', r.regime, 'H' + r.H, ...(r.mkt ? [r.mkt] : [])].join(':')

export function describe(r) {
  if (r.kind === 'combo') return describeCombo(r)
  const reg = r.regime === 'any' ? '' : ` ${REGIMES[r.regime]}`
  const hold = `Hold up to ${r.H} days, with a stop-loss.`
  if (r.kind === 'breakout') return `Buy when a coin closes at a new ${r.n}-day high${reg}. ${hold}`
  if (r.kind === 'dip') return `Buy a ${r.k === 1.5 ? 'sharp' : 'very sharp'} 5-day dip while the coin is above its 100-day average${reg}. ${hold}`
  if (r.kind === 'surge') return `Buy after an unusually strong 20-day rise${reg}. ${hold}`
  const mk = r.mkt === 'up' ? ', only while the market index is above its 200-day average' : ''
  if (r.kind === 'xmom') return `Each month, buy the top fifth of shares by 12-month return (skipping the last month)${mk}. ${hold}`
  if (r.kind === 'xrev') return `Each week, buy the bottom fifth of shares by 1-month return (bet on a rebound)${mk}. ${hold}`
  if (r.kind === 'lowvol') return `Each month, buy the calmest fifth of shares (lowest 60-day volatility)${mk}. ${hold}`
  if (r.kind === 'trend') return `Each month, buy shares and funds trading above their 200-day average (trend following). ${hold}`
  if (r.kind === 'rsi2') return `Buy when a coin is oversold on the 2-day RSI (below 10) while above its 200-day average. ${hold}`
  if (r.kind === 'tom') return `Buy at the close of the month's last trading day (turn-of-the-month effect). ${hold}`
  if (r.kind === 'hi52') return `Buy when a coin closes within 2% of its 52-week high. ${hold}`
  if (r.kind === 'down3') return `Buy after 3 down days in a row while the coin is above its 200-day average. ${hold}`
  return `Buy after an unusually hard 5-day fall (bet on a bounce). ${hold}`
}

/**
 * Extra rules for shares, each from well-known research or practice:
 *  rsi2   short-term oversold in an uptrend (Connors & Alvarez, "Short Term Trading Strategies That Work", 2009)
 *  tom    turn-of-the-month effect: shares tend to rise over the month's last and first few days
 *         (Ariel 1987; Lakonishok & Smidt 1988; McConnell & Xu 2008)
 *  hi52   nearness to the 52-week high predicts further gains (George & Hwang, Journal of Finance 2004)
 *  down3  short-term pullback in an uptrend (short-term reversal, Jegadeesh 1990)
 */
export function shareRules() {
  const out = []
  for (const H of [3, 5]) out.push({ kind: 'rsi2', regime: 'any', H })
  for (const H of [3, 5]) out.push({ kind: 'tom', regime: 'any', H })
  for (const H of [10, 20]) out.push({ kind: 'hi52', regime: 'any', H })
  for (const H of [3, 5]) out.push({ kind: 'down3', regime: 'any', H })
  return out.map(r => ({ ...r, id: ruleId(r) }))
}

/**
 * The rule menu for shares, built on what professional equity quants actually use, judged against
 * the market index. Cross-sectional rules rank every share in its market against the others:
 *  xmom    12-1 momentum, top fifth, monthly (Jegadeesh & Titman 1993; Carhart 1997; Asness, Moskowitz
 *          & Pedersen 2013)
 *  xrev    1-month short-term reversal, bottom fifth, weekly (Jegadeesh 1990; Lehmann 1990)
 *  lowvol  low volatility, calmest fifth, monthly (Ang, Hodrick, Xing & Zhang 2006; Baker, Bradley &
 *          Wurgler 2011; Frazzini & Pedersen 2014)
 *  trend   above the 200-day average, monthly (Faber 2007; Moskowitz, Ooi & Pedersen 2012)
 * each with and without a market-trend filter where it matters, plus the 8 share rules above and the
 * classic 20- and 55-day breakouts (Donchian channels). Crypto-only rules are left out.
 */
export function shareRuleSet() {
  const out = []
  for (const mkt of ['', 'up']) {
    out.push({ kind: 'xmom', regime: 'any', H: 21, mkt })
    out.push({ kind: 'xrev', regime: 'any', H: 5, mkt })
    out.push({ kind: 'lowvol', regime: 'any', H: 21, mkt })
  }
  out.push({ kind: 'trend', regime: 'any', H: 21 })
  for (const n of [20, 55]) for (const H of [10, 20]) out.push({ kind: 'breakout', n, regime: 'any', H })
  return [...out.map(r => (r.mkt ? r : (delete r.mkt, r))).map(r => ({ ...r, id: ruleId(r) })), ...shareRules()]
}

// ---------- cross-sectional ranks (each market ranked separately, one table per day)
const isMonthStart = (coin, i) => i > 0 && new Date(coin.t[i]).getUTCMonth() !== new Date(coin.t[i - 1]).getUTCMonth()
const isWeekEnd = (coin, i) => new Date(coin.t[i]).getUTCDay() === 5
function xsValue(kind, coin, i) {
  const c = coin.c
  if (kind === 'xmom') return i >= 252 ? c[i - 21] / c[i - 252] - 1 : NaN
  if (kind === 'xrev') return i >= 21 ? -(c[i] / c[i - 21] - 1) : NaN            // worst month first
  if (kind === 'lowvol') {
    if (i < 61) return NaN
    let m = 0; for (let k = i - 59; k <= i; k++) m += Math.log(c[k] / c[k - 1]); m /= 60
    let v = 0; for (let k = i - 59; k <= i; k++) v += (Math.log(c[k] / c[k - 1]) - m) ** 2
    return -Math.sqrt(v / 59)                                                      // calmest first
  }
  return NaN
}
/** Rank of the share among its market on that day: 0 = best. Returns { rank, count, value }. */
export function xsRank(kind, coin, i, data) {
  const key = `${kind}|${coin.market || ''}|${coin.t[i]}`
  data.xs ||= new Map()
  let table = data.xs.get(key)
  if (!table) {
    const vals = []
    for (const c of data.coins) {
      if ((c.market || '') !== (coin.market || '') || /^(SPY|QQQ|IWM|DIA|IOZ|VAS|STW)(\.AX)?$/.test(c.base)) continue   // index funds aren't ranked
      c.tIdx ||= new Map(c.t.map((t, j) => [t, j]))
      const j = c.tIdx.get(coin.t[i])
      if (j == null || (data.member && !data.member(c.base, coin.t[i]))) continue
      const v = xsValue(kind, c, j)
      if (Number.isFinite(v)) vals.push([c.base, v])
    }
    vals.sort((a, b) => b[1] - a[1])
    table = new Map(vals.map(([b, v], r) => [b, { rank: r, count: vals.length, value: v }]))
    data.xs.set(key, table)
  }
  return table.get(coin.base) || { rank: Infinity, count: 0, value: NaN }
}
function marketUp(data, coin, i) {
  const { btc, idx } = btcContext(data, coin.market || '')
  const j = btc ? idx.get(coin.t[i]) : undefined
  if (j == null || j < 200) return false
  let s = 0; for (let k = j - 199; k <= j; k++) s += btc.c[k]
  return btc.c[j] > s / 200
}

// ---------------------------------------------------------------- features
/** coin = { base, t[], o[], h[], l[], c[] } (completed daily bars, oldest first) */
export function features(coin) {
  const c = coin.c, n = c.length
  const lr = new Float64Array(n), dvol = new Float64Array(n).fill(NaN), v14 = new Float64Array(n).fill(NaN)
  const ratio = new Float64Array(n).fill(NaN), hi20 = new Float64Array(n).fill(NaN), hi55 = new Float64Array(n).fill(NaN)
  const sma100 = new Float64Array(n).fill(NaN), r5 = new Float64Array(n).fill(NaN), r20 = new Float64Array(n).fill(NaN)
  for (let i = 1; i < n; i++) lr[i] = Math.log(c[i] / c[i - 1])
  const sd = (i, w) => { let m = 0; for (let k = i - w + 1; k <= i; k++) m += lr[k]; m /= w; let s = 0; for (let k = i - w + 1; k <= i; k++) s += (lr[k] - m) ** 2; return Math.sqrt(s / (w - 1)) }
  let sum100 = 0
  for (let i = 0; i < n; i++) {
    sum100 += c[i]; if (i >= 100) sum100 -= c[i - 100]
    if (i >= 99) sma100[i] = sum100 / 100
    if (i >= 20) { dvol[i] = sd(i, 20); r20[i] = c[i] / c[i - 20] - 1; let m = -Infinity; for (let k = i - 20; k < i; k++) m = Math.max(m, c[k]); hi20[i] = m }
    if (i >= 14) v14[i] = sd(i, 14)
    if (i >= 5) r5[i] = c[i] / c[i - 5] - 1
    if (i >= 55) { let m = -Infinity; for (let k = i - 55; k < i; k++) m = Math.max(m, c[k]); hi55[i] = m }
    if (i >= 194) { let m = 0; for (let k = i - 180; k < i; k++) m += v14[k]; ratio[i] = v14[i] / (m / 180) }
  }
  return { lr, dvol, ratio, hi20, hi55, sma100, r5, r20 }
}

/** Slower-to-build series the share rules need, made once per coin when first asked for. */
function extra(coin) {
  if (coin.X) return coin.X
  const c = coin.c, n = c.length
  const sma200 = new Float64Array(n).fill(NaN), rsi2 = new Float64Array(n).fill(NaN), hi250 = new Float64Array(n).fill(NaN)
  let s200 = 0, up = 0, dn = 0
  for (let i = 0; i < n; i++) {
    s200 += c[i]; if (i >= 200) s200 -= c[i - 200]; if (i >= 199) sma200[i] = s200 / 200
    if (i >= 1) {                                         // Wilder's 2-day RSI
      const ch = c[i] - c[i - 1], u = Math.max(ch, 0), d = Math.max(-ch, 0)
      if (i <= 2) { up += u / 2; dn += d / 2 } else { up = (up + u) / 2; dn = (dn + d) / 2 }
      if (i >= 2) rsi2[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn)
    }
    if (i >= 250) { let m = -Infinity; for (let k = i - 249; k <= i; k++) if (c[k] > m) m = c[k]; hi250[i] = m }
  }
  return (coin.X = { sma200, rsi2, hi250 })
}
/** Is day t (UTC midnight of a trading date) the month's last weekday? */
function lastWeekdayOfMonth(t) {
  const d = new Date(t), next = new Date(t + DAY * (d.getUTCDay() === 5 ? 3 : 1))
  return next.getUTCMonth() !== d.getUTCMonth()
}

const regimeOk = (reg, x) => reg === 'any' ? Number.isFinite(x) : reg === 'quiet' ? x < 0.8 : x > 1.25

export function signal(r, coin, F, i, data) {
  if (r.kind === 'combo') return comboSignal(r, coin, F, i, data)
  if (i < 200 || !Number.isFinite(F.dvol[i]) || !regimeOk(r.regime, F.ratio[i])) return false
  const c = coin.c[i], dv = F.dvol[i]
  if (r.kind === 'breakout') return c > (r.n === 20 ? F.hi20[i] : F.hi55[i])
  if (r.kind === 'dip') return c > F.sma100[i] && F.r5[i] < -r.k * dv * Math.sqrt(5)
  if (r.kind === 'surge') return F.r20[i] > 2 * dv * Math.sqrt(20)
  if (r.kind === 'crash') return F.r5[i] < -3 * dv * Math.sqrt(5)
  if (r.mkt === 'up' && !marketUp(data, coin, i)) return false
  if (r.kind === 'xmom' || r.kind === 'lowvol' || r.kind === 'xrev') {
    if (r.kind === 'xrev' ? !isWeekEnd(coin, i) : !isMonthStart(coin, i)) return false
    const x = xsRank(r.kind, coin, i, data)
    return x.count >= 10 && x.rank < Math.ceil(x.count / 5)
  }
  if (r.kind === 'trend') { const X = extra(coin); return isMonthStart(coin, i) && c > X.sma200[i] }
  if (r.kind === 'rsi2') { const X = extra(coin); return c > X.sma200[i] && X.rsi2[i] < 10 }
  if (r.kind === 'tom') return lastWeekdayOfMonth(coin.t[i])
  if (r.kind === 'hi52') { const X = extra(coin); return c >= 0.98 * X.hi250[i] }
  if (r.kind === 'down3') { const X = extra(coin), k = coin.c; return c > X.sma200[i] && k[i] < k[i - 1] && k[i - 1] < k[i - 2] && k[i - 2] < k[i - 3] }
  return false
}

/** Stop distance: about 2.5 typical moves over the holding period, between 5% and 25%. */
export const stopPct = (dailyVol, H, m = 2.5) => Math.max(0.05, Math.min(0.25, m * dailyVol * Math.sqrt(Math.min(H, 10))))

// ---------------------------------------------------------------- backtest of one rule
/** Every past signal of rule r on every coin: enter next day's open, exit at stop or after H days. */
export function events(r, data) {
  const out = []
  for (const coin of data.coins) {
    const F = coin.F || (coin.F = features(coin))
    const D = coin.c.length
    let busy = 0
    for (let i = 200; i < D - 1; i++) {
      if (i < busy || (data.member && !data.member(coin.base, coin.t[i])) || !signal(r, coin, F, i, data)) continue
      const entry = coin.o[i + 1], stop = entry * (1 - stopPct(F.dvol[i], r.H, r.stopM))
      let exit = NaN, j = i + 1
      for (; j <= i + r.H && j < D; j++) {
        if (coin.l[j] <= stop) { exit = j === i + 1 ? stop : Math.min(coin.o[j], stop); break }
        if (j === i + r.H) { exit = coin.c[j]; break }
      }
      if (!Number.isFinite(exit)) break       // still open at the end of the data
      const ev = { base: coin.base, m: coin.market || '', t: coin.t[i], exitT: coin.t[j], g: exit / entry - 1 }
      // shares: what the market index did over exactly the same days (buy its open, sell its close)
      const B = data.bench?.[coin.market || '']
      if (B && B !== coin) {
        B.tIdx ||= new Map(B.t.map((t, k) => [t, k]))
        const a = B.tIdx.get(coin.t[i + 1]), b = B.tIdx.get(coin.t[j])
        if (a != null && b != null) ev.ex = ev.g - (B.c[b] / B.o[a] - 1)
      }
      out.push(ev)
      busy = j
    }
  }
  return out
}

export function stats(ev, cost = 0) {
  const n = ev.length
  if (!n) return { n: 0, mean: 0, se: 0, t: 0, win: 0 }
  const g = ev.map(e => (e.g ?? e) - cost)
  const mean = g.reduce((a, b) => a + b, 0) / n
  const sd = n > 1 ? Math.sqrt(g.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0
  const se = n > 1 ? sd / Math.sqrt(n) : 0
  return { n, mean, se, t: se > 0 ? mean / se : 0, win: g.filter(x => x > 0).length / n }
}

/** Test every rule: chosen on the older data (train), checked on the last `validDays` (valid). */
export function discover(data, S = LAB, state) {
  const last = sealedLast(data)              // choosing never sees the sealed exam window (exam.js)
  const cut = last - S.validDays * DAY
  if (S.benchmarks) {                       // shares: judge every rule against the market index
    data.bench = {}
    for (const [m, b] of Object.entries(S.benchmarks)) data.bench[m] = data.coins.find(c => c.base === b)
  }
  const rules = S.ruleSet ? S.ruleSet() : [...allRules(), ...(S.extraRules ? S.extraRules() : [])]
  const found0 = rules.map(r => {
    const evAll = events(r, data), ev = preSeal(evAll)
    const all = stats(evAll)                    // gross, used by the cost gate
    // with a benchmark, the test is the return ABOVE the index over the same days, after costs
    // (each market pays its own round-trip cost when S.refCostBy is set)
    const judged = S.benchmarks ? ev.filter(e => Number.isFinite(e.ex)).map(e => ({ ...e, g: e.ex - (S.refCostBy?.[e.m] ?? S.refCost) })) : ev
    const cost = S.benchmarks ? 0 : S.refCost
    const train = stats(judged.filter(e => e.exitT < cut), cost)
    const valid = stats(judged.filter(e => e.t >= cut), cost)
    const pass = train.n >= S.minTrain && train.t >= S.minTrainT && valid.n >= S.minValid && valid.mean > 0
    const out = { ...r, text: describe(r), train, valid, all, pass, ev, evAll }
    if (S.benchmarks) out.vsIndex = stats(ev.filter(e => Number.isFinite(e.ex)).map(e => ({ g: e.ex })))   // average beat of the index, before costs
    return out
  })
  return assess(found0, data, {
    cost: S.refCost, trials: countTrials(state, found0.map(f => f.id)), family: f => `${f.kind}:${f.mkt || ''}`, portfolio: { maxOpen: S.maxOpen, slot: Math.min(S.maxPosition, S.maxInvested / S.maxOpen) }, exam: state ? { state, now: Date.now() } : null,
    netOf: S.benchmarks ? (e => (Number.isFinite(e.ex) ? e.ex - (S.refCostBy?.[e.m] ?? S.refCost) : NaN)) : (e => e.g - S.refCost),
  })
}

/**
 * Each exchange's real round trip right now: its fee both ways, the typical (median) buy–sell gap
 * across the coins being scanned from its live prices, and slippage both ways.
 */
export function venueCosts(accounts, market, S) {
  const out = {}
  for (const a of Object.values(accounts || {})) {
    if (a.market) continue                                    // share brokers are costed per order elsewhere
    const q = market.quotes?.[a.id] || {}
    const gaps = (market.coins || []).map(c => q[c.base]).filter(x => x >= 0).sort((x, y) => x - y)
    const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.01
    out[a.id] = { exchange: a.exchange, cost: +(2 * a.fee + gap + 2 * (S.slippage || 0)).toFixed(4), fee: a.fee, gap: +gap.toFixed(4) }
  }
  return out
}
/** Rules are chosen and checked at the cost of the exchange that trades real money (CoinSpot). */
export const LIVE_ACCOUNT = 'john'
export function withLiveCost(state, market, S) {
  const v = venueCosts(state.accounts, market, S)
  state.venueCosts = v
  const live = v[S.liveAccount || LIVE_ACCOUNT]
  if (!live) return S
  state.selectCost = { account: S.liveAccount || LIVE_ACCOUNT, exchange: live.exchange, cost: live.cost }
  return { ...S, refCost: live.cost }
}

/** Mark's gain estimate: average gain of all past signals minus one standard error (losers included). */
export const estimate = all => all.mean - all.se

// ---------------------------------------------------------------- the live loop
export function newState(audPerUsd, now, accounts = ACCOUNTS) {
  return {
    version: 1, created: now, lastRun: null, lastSignalDay: 0, lastCoach: 0, nextV: 1,
    rules: [], shadow: [], events: [], history: [],
    accounts: Object.fromEntries(accounts.map(a => [a.id, freshAccount(a, audPerUsd)])),
  }
}

const push = (arr, x, max) => { arr.push(x); if (arr.length > max) arr.splice(0, arr.length - max) }

/**
 * The broker's fee on one order, as a fraction of its value. Crypto accounts charge a flat %;
 * share brokers also charge per share and have a minimum per order (which bites on small trades).
 * valueUsd = order value in USD, px = price per share in USD, rate = AUD per USD.
 */
export function feeFrac(a, valueUsd, px, rate) {
  if (!(valueUsd > 0)) return a.fee
  let fee = a.fee * valueUsd
  if (a.perShareUsd && px > 0) fee = Math.max(fee, a.perShareUsd * valueUsd / px)
  fee = Math.max(fee, (a.minFeeUsd || 0) + (a.minFeeAud || 0) / rate)
  if (a.maxFeePct) fee = Math.min(fee, a.maxFeePct * valueUsd)
  return fee / valueUsd
}
const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`

function liveMean(rule, since = 0) {
  const g = (rule.live?.trades || []).filter(t => t.t >= since).map(t => t.g)
  return { n: g.length, mean: g.length ? g.reduce((a, b) => a + b, 0) / g.length : 0 }
}

/** The coach: re-test all rules on the latest data, add challengers, promote / roll back. */
export function coach(state, found, now, S = LAB) {
  const log = (kind, text) => push(state.events, { t: now, kind, text }, 300)
  const byId = new Map(found.map(f => [f.id, f]))
  for (const r of state.rules) {           // refresh each rule's back-test
    const f = byId.get(r.id)
    if (f) { r.train = f.train; r.valid = f.valid; r.all = f.all; r.pass = f.pass; r.rigor = f.rigor; if (f.vsIndex) r.vsIndex = f.vsIndex }
  }
  const active = () => state.rules.filter(r => r.status !== 'retired')
  let champ = state.rules.find(r => r.status === 'champion')

  // retire challengers that no longer pass, or that have a poor live record
  for (const r of active()) {
    if (r.status !== 'challenger') continue
    const lm = liveMean(r)
    if (!r.pass && !r.wasChampion && (r.train.t < S.minTrainT - 0.5 || r.valid.mean < -0.005)) { r.status = 'retired'; r.reason = 'stopped passing the back-test check'; log('retire', `v${r.v} retired: ${r.reason}.`) }
    else if (lm.n >= S.promoteAfter * 2 && lm.mean < 0) { r.status = 'retired'; r.reason = `lost money live (${pct(lm.mean)} a trade over ${lm.n} trades)`; log('retire', `v${r.v} retired: ${r.reason}.`) }
  }
  // add new challengers from the rules that pass
  for (const f of found) {
    if (!f.pass || state.rules.some(r => r.id === f.id && r.status !== 'retired')) continue
    if (active().filter(r => r.status === 'challenger').length >= S.maxChallengers) break
    const r = { v: state.nextV++, id: f.id, spec: f.spec ?? { kind: f.kind, n: f.n, k: f.k, regime: f.regime, H: f.H, ...(f.mkt ? { mkt: f.mkt } : {}) }, text: f.text,
      status: champ ? 'challenger' : 'champion', since: now, train: f.train, valid: f.valid, all: f.all, pass: f.pass, rigor: f.rigor, live: { trades: [] }, ...(f.vsIndex ? { vsIndex: f.vsIndex } : {}) }
    state.rules.push(r)
    if (!champ) { champ = r; r.reason = 'best rule on the back-test'; log('promote', `v${r.v} is the first trading rule: ${r.text} (past signals ${pct(f.all.mean)} a trade before costs, ${f.all.n} trades).`) }
    else log('challenger', `v${r.v} added to test on paper: ${r.text}`)
  }
  if (!champ) {
    const msg = 'No rule has passed the checks yet, so the accounts stay in cash.'
    if (state.events[state.events.length - 1]?.text !== msg) log('note', msg)
    return
  }

  // promotion / rollback: best challenger whose live record beats the champion's over the same period
  let best = null
  for (const r of active()) {
    if (r.status !== 'challenger') continue
    const mine = liveMean(r, r.since), theirs = liveMean(champ, r.since)
    if (mine.n < S.promoteAfter || theirs.n < Math.min(4, S.promoteAfter)) continue
    if (mine.mean > theirs.mean + S.promoteBy && (r.pass || r.wasChampion) && (!best || mine.mean > best.m)) best = { r, m: mine.mean, c: theirs.mean, n: mine.n }
  }
  if (!best && !champ.pass) {                 // the champion broke: swap to the best passing challenger
    const alt = active().filter(r => r.status === 'challenger' && r.pass).sort((a, b) => b.train.t - a.train.t)[0]
    if (alt) best = { r: alt, m: NaN, c: NaN, n: 0, broke: true }
  }
  if (best) {
    const r = best.r
    champ.status = 'challenger'; champ.wasChampion = true; champ.since = now
    r.status = 'champion'; r.since = now
    const why = best.broke ? `v${champ.v} stopped passing the back-test check` : `live ${pct(best.m)} a trade vs ${pct(best.c)} over ${best.n} trades`
    r.reason = why
    log(r.wasChampion ? 'rollback' : 'promote', `${r.wasChampion ? 'Rolled back to' : 'Promoted'} v${r.v} (${why}): ${r.text}`)
  }
}

/**
 * One run of the loop. market = {
 *   coins: [{ base, t,o,h,l,c }],  live: { BASE: usdPrice },  audPerUsd,
 *   quotes: { john: { BASE: spread }, mark: { BASE: spread } }   // missing = no live quote → skip
 * }
 */
export function step(state, market, now, S = LAB, opts = {}) {
  const log = (kind, text) => push(state.events, { t: now, kind, text }, 300)
  const price = b => market.live[b]
  const ruleByV = new Map(state.rules.map(r => [r.v, r]))
  // testing uses today's coins plus past top-list coins (incl. delisted), each only while it was in the top list;
  // live signals below still only use market.coins (today's list)
  const data = market.history?.length ? { coins: [...market.coins, ...market.history], member: market.member } : { coins: market.coins, member: market.member }
  const rate = market.audPerUsd
  for (const a of Object.values(state.accounts)) if (a.cashAud == null) { a.cashAud = (a.cashUsd ?? a.startUsd) * a.startAud / a.startUsd; delete a.cashUsd }
  // an account that has never traded can only ever have been worth its start (clears the old FX blip)
  for (const acct of Object.values(state.accounts)) if (!acct.stats.n && !acct.positions.length) for (const h of state.history) if (h[acct.id] != null) h[acct.id] = acct.startAud
  // accounts are named by exchange; add any new exchange, and keep fee/labels in step with ACCOUNTS
  const ACCTS = S.accounts || ACCOUNTS
  for (const cfg of ACCTS) {
    const acct = state.accounts[cfg.id]
    if (!acct) { state.accounts[cfg.id] = freshAccount(cfg, rate); push(state.events, { t: now, kind: 'note', text: `${cfg.exchange} account added, starting with A$${cfg.startAud.toLocaleString()}.` }, 300); continue }
    Object.assign(acct, cfg, { startAud: acct.startAud })
  }
  // if a starting amount was changed in ACCOUNTS, scale that account (cash, positions, history) to match
  for (const cfg of ACCTS) {
    const acct = state.accounts[cfg.id]
    if (!acct || acct.startAud === cfg.startAud) continue
    const k = cfg.startAud / acct.startAud
    acct.startAud = cfg.startAud; acct.startUsd *= k; acct.cashAud *= k
    for (const p of [...acct.positions, ...acct.closed]) { p.units *= k; p.costUsd *= k }
    for (const h of state.history) if (h[cfg.id] != null) h[cfg.id] = +(h[cfg.id] * k).toFixed(2)
    push(state.events, { t: now, kind: 'note', text: `${acct.owner}'s account rescaled to start at A$${cfg.startAud} (same as the other account), keeping its trades and results.` }, 300)
  }

  // 1. exits (always run — protective exits execute even at a loss)
  for (const s of state.shadow.slice()) {
    const p = price(s.base); if (!(p > 0)) continue
    if (p <= s.stop || now >= s.exitT) {
      const r = ruleByV.get(s.v)
      if (r) push((r.live ||= { trades: [] }).trades, { t: now, base: s.base, g: p / s.entry - 1 }, 300)
      state.shadow.splice(state.shadow.indexOf(s), 1)
    }
  }
  for (const a of Object.values(state.accounts)) {
    for (const pos of a.positions.slice()) {
      const p = price(pos.base); if (!(p > 0)) continue
      const stopped = p <= pos.stop
      if (!stopped && now < pos.exitT) continue
      const proceeds = pos.units * p * (1 - pos.spread / 2 - S.slippage) * (1 - feeFrac(a, pos.units * p, p, rate))
      const net = proceeds / pos.costUsd - 1
      a.cashAud += proceeds * rate
      a.positions.splice(a.positions.indexOf(pos), 1)
      a.stats.n++; a.stats.sumNet += net; if (net > 0) a.stats.wins++
      push(a.closed, { ...pos, rMult: pos.stop && pos.entryPx ? +(net / (1 - pos.stop / pos.entryPx)).toFixed(2) : null, expected: ruleByV.get(pos.v)?.norm?.[pos.base]?.m ?? ruleByV.get(pos.v)?.all?.mean ?? null, exitT: now, exitPx: p, net, gross: p / pos.entryPx - 1, why: stopped ? 'stop' : 'time' }, 200)
      log('trade', `${a.owner}: sold ${pos.base} (${stopped ? 'stop-loss' : 'time up'}) ${pct(net)} after costs.`)
    }
  }

  // 2. the coach, weekly
  const ruleList = S.ruleSet || S.extraRules
  const newRules = ruleList && !ruleList().every(r => state.found?.some(f => f.id === r.id))   // rule list changed: re-test now
  const unchecked = state.found?.length && !state.found.some(f => (f.rigor?.v ?? 0) >= 4)     // tested before the professional checks existed
  if (now - state.lastCoach >= S.coachEveryDays * DAY - 6 * 3_600_000 || newRules || unchecked) {
    const found = (opts.discover || discover)(data, withLiveCost(state, market, S), state, now)
    coach(state, found, now, S)
    state.found = found.map(f => ({ id: f.id, text: f.text, H: f.H ?? f.spec?.H, pass: f.pass, train: f.train, valid: f.valid, all: f.all, rigor: f.rigor, ...(f.vsIndex ? { vsIndex: f.vsIndex } : {}) }))
    state.coinsScanned = market.coins.map(c => c.base)
    state.lastCoach = now
  }

  // 3. entries, once per new daily close. Markets with different closing times (US and ASX shares)
  //    each keep their own clock, so one market's close doesn't swallow the other's.
  const groups = new Map()
  for (const c of market.coins) { const g = c.market || '', t = c.t[c.t.length - 1]; if (!(groups.get(g) >= t)) groups.set(g, t) }
  state.lastSignalDays ||= {}
  const champ = state.rules.find(r => r.status === 'champion')
  const barDays = S.daysPerBar || 1          // calendar days per bar (shares skip weekends)
  for (const [g, lastDay] of groups) {
    const prev = g ? (state.lastSignalDays[g] || 0) : state.lastSignalDay
    if (!(lastDay > prev)) continue
    if (g) state.lastSignalDays[g] = lastDay; else state.lastSignalDay = lastDay
    for (const r of state.rules.filter(x => x.status !== 'retired')) {
      // ranked rules buy their best-ranked shares first (cash and slots run out)
      let order = market.coins.filter(c => (c.market || '') === g)
      if (['xmom', 'xrev', 'lowvol'].includes(r.spec.kind)) order = order.map(c => [c, xsRank(r.spec.kind, c, c.c.length - 1, data).rank]).sort((a, b) => a[1] - b[1]).map(x => x[0])
      for (const coin of order) {
        const i = coin.c.length - 1
        if (coin.t[i] !== lastDay) continue
        const F = coin.F || (coin.F = features(coin))
        if (!signal(r.spec, coin, F, i, data)) continue
        const p = price(coin.base); if (!(p > 0)) continue
        const sp = stopPct(F.dvol[i], r.spec.H, r.spec.stopM)
        const exitT = now + r.spec.H * DAY * barDays
        if (!state.shadow.some(s => s.v === r.v && s.base === coin.base))
          state.shadow.push({ v: r.v, base: coin.base, entry: p, t: now, stop: p * (1 - sp), exitT })
        if (r !== champ) continue
        for (const a of Object.values(state.accounts)) {
          if (a.market && a.market !== (coin.market || '')) continue
          enter(a, r, coin.base, p, sp, market, now, S, log, exitT)
        }
      }
    }
  }
  if (groups.size > 1 || !groups.has('')) state.lastSignalDay = Math.max(state.lastSignalDay || 0, ...Object.values(state.lastSignalDays))

  // 4. valuation
  const value = a => a.cashAud + rate * a.positions.reduce((s, pos) => s + pos.units * (price(pos.base) || pos.entryPx), 0)   // AUD
  push(state.history, { t: now, ...Object.fromEntries(Object.values(state.accounts).map(a => [a.id, +value(a).toFixed(2)])) }, 600)
  for (const a of Object.values(state.accounts)) { a.valueAud = value(a); a.valueUsd = value(a) / rate }
  state.regimeNow = Object.fromEntries(['', 'US', 'ASX'].map(m => [m, regimeAt({ coins: market.coins, bench: market.bench }, m, now + 86_400_000)]).filter(([, v]) => v))
  state.audPerUsd = market.audPerUsd
  // latest prices of everything held, for the Positions table
  state.prices = {}
  for (const acct of Object.values(state.accounts)) for (const pos of acct.positions) if (price(pos.base) > 0) state.prices[pos.base] = price(pos.base)
  state.lastRun = now
  return state
}

function enter(a, r, base, p, sp, market, now, S, log, exitT = now + r.spec.H * DAY) {
  const note = why => { push(a.lastBlocked, { t: now, base, v: r.v, why }, 30) }
  if (a.positions.some(x => x.base === base)) return
  const spread = market.quotes?.[a.id]?.[base]
  if (!(spread >= 0)) { a.blocked.quote++; note(market.unlisted?.[a.id]?.[base] ? `${a.exchange} doesn't sell ${base}` : `no live ${a.exchange} quote for ${base}`); return }
  const estimated = !!market.estimated?.[a.id]?.[base]
  const rate = market.audPerUsd
  const cashUsd = a.cashAud / rate
  const equity = cashUsd + a.positions.reduce((s, x) => s + x.units * (market.live[x.base] || x.entryPx), 0)
  const invested = equity - cashUsd
  // market type: a confirmed better / worse fit scales the risk taken (0.25× to 1.5×), never to zero
  const mkt = market.coins.find(c => c.base === base)?.market || ''
  const regime = regimeAt({ coins: market.coins, bench: market.bench }, mkt, now)
  const rw = regimeWeight(r.rigor?.regime, regime)
  const alloc = Math.min(S.maxPosition * equity, S.riskPerTrade * equity / sp * rw, cashUsd, S.maxInvested * equity - invested)
  if (a.positions.length >= S.maxOpen || alloc < 1) { a.blocked.limits++; note('risk limits (too many open, or not enough cash)'); return }
  const fee = feeFrac(a, alloc, p, rate)     // on this order's size (minimum fees bite on small orders)
  const cost = 2 * fee + spread + 2 * S.slippage
  const est = estimate(r.all)
  if (!(est > cost + S.margin)) {
    a.blocked.cost++
    note(`estimated gain ${pct(est)} doesn't cover costs ${pct(cost)} + margin ${pct(S.margin)}`)
    return
  }
  const fill = p * (1 + spread / 2 + S.slippage)
  const units = alloc * (1 - fee) / fill
  a.cashAud -= alloc * rate
  a.positions.push({ base, v: r.v, units, entryPx: p, fillPx: fill, costUsd: alloc, t: now, stop: p * (1 - sp), exitT, spread, est, cost, estimated, regime, rw })
  log('trade', `${a.owner}: bought ${base} with ${(alloc / equity * 100).toFixed(0)}% of the account (rule v${r.v}; estimate ${pct(est)} vs cost ${pct(cost)}${estimated ? `, spread estimated at ${pct(spread)} because ${base} isn't in ${a.exchange}'s public price feed` : ''}).`)
}

/** The morning summary: balances, win rates and the latest rule changes. */
export function summary(state) {
  const accts = Object.values(state.accounts).map(a => ({
    owner: a.owner, exchange: a.exchange, valueAud: a.valueAud, startAud: a.startAud,
    trades: a.stats.n, winRate: a.stats.n ? a.stats.wins / a.stats.n : null, open: a.positions.length,
  }))
  const changes = state.events.filter(e => ['promote', 'rollback', 'challenger', 'retire'].includes(e.kind)).slice(-3).reverse()
  return { accts, changes }
}
