// Day Trade Lab: intraday rules on 1-hour candles, every position closed by the end of the
// UTC day (9:30am Darwin). Same honest loop as the Lab — choose on older data, check on the
// held-back last 60 days, trade the best on paper, keep challengers in the shadow — plus a
// walk-forward test and a daily loss limit.
//
// Strategy families (long-only spot), strongest evidence first:
//  imom    intraday momentum: the day's first hours predict its last hours
//          (Shen, Urquhart & Wang, Financial Review 2022)
//  rev     overreaction reversal after an unusually hard 1-hour fall
//          (Wen, Bouri, Xu & Zhao, N. Am. J. Econ. & Finance 2022)
//  orb     opening-range breakout: price clears the first hours' high
//  volbo   volatility breakout: price clears today's open + K × yesterday's range
//  mr      mean reversion to the 24-hour average, only in calm markets
// Each with and without a daily-trend filter (price above its ~20-day average).
import { assess, countTrials } from './rigor.js'
import { regimeAt, regimeWeight } from './regime.js'
import { preSeal, sealedLast } from './exam.js'
import { exploreCoach, failFast, recordLive } from './explore.js'
import { ACCOUNTS, coach, estimate, stats, withLiveCost } from './lab.js'

export const HOUR = 3_600_000
export const DAY = 86_400_000

export const DT = {
  universe: 10,
  margin: 0.001,          // safety margin in the cost gate (0.1%)
  slippage: 0.0005,       // per side, liquid coins, market orders
  maxPosition: 0.25,
  riskPerTrade: 0.005,    // a stop-out loses at most ~0.5% of the account
  maxOpen: 3,
  maxInvested: 0.75,
  dailyLossLimit: 0.02,   // no new trades for the rest of the UTC day after a 2% drop
  validDays: 60,
  refCost: 0.003,         // round trip used for choosing rules (Binance-level costs)
  minTrain: 100, minTrainT: 2.5, minValid: 50,   // 50+ trades in the held-back window: fewer is an anecdote
  maxChallengers: 3,
  promoteAfter: 30,
  promoteBy: 0.001,
  coachEveryDays: 1,
  wfTrainDays: 120, wfTestDays: 30,
  // Practice mode: while no rule passes the checks, paper-trade the best few anyway (full costs
  // charged, clearly labelled) so the lab builds a live record instead of sitting in cash.
  practiceRules: 4,       // learning mode: how many different ideas trade on paper at once
  minPerDay: 1,           // a learning rule must have fired at least once a day (all coins) over the last 14 days
  minHoldDays: 14,        // every idea gets at least two weeks before it can be swapped out
  failAfter: 20, failZ: -2, benchDays: 14, // bench only if 20+ live trades sit far below its own normal for those coins
  practiceMaxOpen: 8, practiceLossLimit: 0.05,
  catchUpHours: 24,
  newsGuard: 30 * 60_000,  // no new entries 30 min either side of a high-impact US release (CPI, jobs, Fed)
  ddCut: 0.10,             // after a 10% fall from an account's peak, every new trade is half size       // signals from completed hours not yet acted on are taken at that hour's price
}

export function allDayRules() {
  const out = []
  for (const tf of [0, 1]) {
    for (const n of [1, 2, 4]) for (const last of [1, 2]) out.push({ kind: 'imom', n, last, tf })
    for (const k of [2, 3]) for (const H of [2, 4, 8]) out.push({ kind: 'rev', k, H, tf })
    for (const n of [2, 4]) out.push({ kind: 'orb', n, tf })
    for (const K of [0.3, 0.5, 0.7]) out.push({ kind: 'volbo', K, tf })
    for (const z of [1.5, 2.5]) for (const H of [4, 8]) out.push({ kind: 'mr', z, H, tf })
    // 'Recent movers': buy a coin right after an unusually big 1-hour jump (what CoinSpot's movers list shows)
    for (const k of [2, 3]) for (const H of [1, 2, 4, 8]) out.push({ kind: 'jump', k, H, tf })
  }
  return out.map(r => ({ ...r, id: dayRuleId(r) }))
}
export const dayRuleId = r => `${r.kind}:${r.n ?? r.k ?? r.K ?? r.z}:${r.last ?? r.H ?? ''}:tf${r.tf}`

export function describeDay(r) {
  const tf = r.tf ? ', only while the coin is in a daily uptrend' : ''
  switch (r.kind) {
    case 'imom': return `If the coin rose over the day's first ${r.n} hour${r.n > 1 ? 's' : ''}, buy for the day's last ${r.last} hour${r.last > 1 ? 's' : ''}${tf}.`
    case 'rev': return `Buy after an unusually hard 1-hour fall (${r.k}× the usual move) and hold up to ${r.H} hours${tf}.`
    case 'orb': return `Buy when price clears the high of the day's first ${r.n} hours; sell by day's end${tf}.`
    case 'volbo': return `Buy when price rises ${r.K} × yesterday's range above today's open; sell by day's end${tf}.`
    case 'jump': return `Recent mover: buy right after an unusually big 1-hour jump (${r.k}× the usual move) and hold up to ${r.H} hour${r.H > 1 ? 's' : ''}${tf}.`
    case 'mr': return `In calm markets, buy a ${r.z === 1.5 ? 'sharp' : 'very sharp'} dip below the 24-hour average; sell on recovery or after ${r.H} hours${tf}.`
    default: return r.kind
  }
}

// ---------------------------------------------------------------- hourly features
export function dayFeatures(coin) {
  if (coin.DF) return coin.DF
  const { t, o, h, l, c } = coin, n = c.length
  const lr = new Float64Array(n), hvol = new Float64Array(n).fill(NaN), hvolAvg = new Float64Array(n).fill(NaN)
  const sma24 = new Float64Array(n).fill(NaN), sma480 = new Float64Array(n).fill(NaN)
  const dayStart = new Int32Array(n), hour = new Int8Array(n), prevRange = new Float64Array(n).fill(NaN)
  for (let i = 1; i < n; i++) lr[i] = Math.log(c[i] / c[i - 1])
  let s24 = 0, s480 = 0
  for (let i = 0; i < n; i++) {
    s24 += c[i]; if (i >= 24) s24 -= c[i - 24]; if (i >= 23) sma24[i] = s24 / 24
    s480 += c[i]; if (i >= 480) s480 -= c[i - 480]; if (i >= 479) sma480[i] = s480 / 480
    if (i >= 24) { let m = 0; for (let k = i - 23; k <= i; k++) m += lr[k]; m /= 24; let v = 0; for (let k = i - 23; k <= i; k++) v += (lr[k] - m) ** 2; hvol[i] = Math.sqrt(v / 23) }
    hour[i] = new Date(t[i]).getUTCHours()
    dayStart[i] = i > 0 && Math.floor(t[i] / DAY) === Math.floor(t[i - 1] / DAY) ? dayStart[i - 1] : i
  }
  let s168 = 0, k168 = 0
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(hvol[i])) { s168 += hvol[i]; k168++ }
    if (i >= 168 && Number.isFinite(hvol[i - 168])) { s168 -= hvol[i - 168]; k168-- }
    if (k168 >= 100) hvolAvg[i] = s168 / k168
  }
  // yesterday's high–low range, known from the first bar of today
  for (let i = 0; i < n; i++) {
    const d = dayStart[i]
    if (d === 0) continue
    const pd = dayStart[d - 1]
    let hi = -Infinity, lo = Infinity
    for (let k = pd; k < d; k++) { if (h[k] > hi) hi = h[k]; if (l[k] < lo) lo = l[k] }
    prevRange[i] = hi - lo
  }
  return (coin.DF = { lr, hvol, hvolAvg, sma24, sma480, dayStart, hour, prevRange, o })
}

export function daySignal(r, coin, D, i) {
  if (i < 500 || !Number.isFinite(D.hvol[i])) return false
  const c = coin.c, hr = D.hour[i], d = D.dayStart[i]
  if (r.tf && !(c[i] > D.sma480[i])) return false
  switch (r.kind) {
    case 'imom': {
      if (hr !== 23 - r.last || d + r.n - 1 > i) return false
      return c[d + r.n - 1] / coin.o[d] - 1 > 0
    }
    case 'rev': return hr <= 22 && Number.isFinite(D.hvol[i - 1]) && D.lr[i] < -r.k * D.hvol[i - 1]
    case 'jump': return hr <= 22 && Number.isFinite(D.hvol[i - 1]) && D.lr[i] > r.k * D.hvol[i - 1]
    case 'orb': {
      if (hr < r.n || hr > 21 || d + r.n - 1 >= i) return false
      let hi = -Infinity
      for (let k = d; k < d + r.n; k++) if (coin.h[k] > hi) hi = coin.h[k]
      return c[i] > hi && c[i - 1] <= hi
    }
    case 'volbo': {
      if (hr < 1 || hr > 21 || !Number.isFinite(D.prevRange[i])) return false
      const lvl = coin.o[d] + r.K * D.prevRange[i]
      return c[i] > lvl && c[i - 1] <= lvl
    }
    case 'mr': return hr <= 21 && Number.isFinite(D.hvolAvg[i]) && D.hvol[i] < D.hvolAvg[i] && c[i] < D.sma24[i] * (1 - r.z * D.hvol[i] * Math.sqrt(6))
    default: return false
  }
}

/** Planned holding hours when entering after bar i (always ends by the UTC day's close). */
export function holdHours(r, entryHour) {
  const toEod = 24 - entryHour
  if (r.kind === 'imom') return Math.min(r.last, toEod)
  if (r.kind === 'rev' || r.kind === 'mr' || r.kind === 'jump') return Math.min(r.H, toEod)
  return toEod
}
export const dayStopPct = (hvol, hours) => Math.max(0.008, Math.min(0.05, 2 * hvol * Math.sqrt(Math.max(1, hours))))

/** Every past signal: enter at the next bar's open, exit at stop / early exit / planned close. */
export function dayEvents(r, data) {
  const out = []
  for (const coin of data.coins) {
    const D = dayFeatures(coin), n = coin.c.length
    let busy = 0
    for (let i = 500; i < n - 1; i++) {
      if (i < busy || (data.member && !data.member(coin.base, coin.t[i])) || !daySignal(r, coin, D, i)) continue
      const e = i + 1
      const hold = holdHours(r, D.hour[e])
      const last = e + hold - 1
      if (last >= n) break
      const entry = coin.o[e], stop = entry * (1 - dayStopPct(D.hvol[i], hold))
      let exit = NaN, j = e
      for (; j <= last; j++) {
        if (coin.l[j] <= stop) { exit = j === e ? stop : Math.min(coin.o[j], stop); break }
        if (r.kind === 'mr' && coin.c[j] >= D.sma24[j]) { exit = coin.c[j]; break }
        if (j === last) { exit = coin.c[j]; break }
      }
      out.push({ base: coin.base, t: coin.t[i], exitT: coin.t[j] + HOUR, g: exit / entry - 1 })
      busy = j + 1
    }
  }
  return out
}

/** Re-test all rules: chosen on older data, checked on the held-back last 60 days. */
export function discoverDay(data, S = DT, state) {
  const last = sealedLast(data)              // choosing never sees the sealed exam window (exam.js)
  const cut = last - S.validDays * DAY
  const found = allDayRules().map(r => {
    const evAll = dayEvents(r, data), ev = preSeal(evAll)
    r.ev = ev
    const train = stats(ev.filter(e => e.exitT < cut), S.refCost)
    const valid = stats(ev.filter(e => e.t >= cut), S.refCost)
    const all = stats(evAll)
    const pass = train.n >= S.minTrain && train.t >= S.minTrainT && valid.n >= S.minValid && valid.mean > 0
    return { ...r, spec: { kind: r.kind, n: r.n, k: r.k, K: r.K, z: r.z, last: r.last, H: r.H, tf: r.tf }, text: describeDay(r), train, valid, all, pass, ev, evAll }
  })
  return assess(found, data, { cost: S.refCost, exitOffset: HOUR, warmup: 500, trials: countTrials(state, found.map(f => f.id)), family: f => f.kind, portfolio: { maxOpen: S.maxOpen, slot: Math.min(S.maxPosition, S.maxInvested / S.maxOpen) }, exam: state ? { state, now: Date.now() } : null })
}

/**
 * Walk-forward: each month, pick the best rule on the previous 120 days only, then record what it
 * earned that month. Stitched together, this is what the whole selection process would have made.
 */
export function walkForward(found, data, S = DT) {
  const first = Math.min(...data.coins.map(c => c.t[500] ?? Infinity))
  const last = sealedLast(data)   // stop at the sealed exam window
  const months = [], trades = []
  for (let start = first + S.wfTrainDays * DAY; start + S.wfTestDays * DAY <= last; start += S.wfTestDays * DAY) {
    const end = start + S.wfTestDays * DAY
    let best = null
    for (const f of found) {
      const tr = stats(f.ev.filter(e => e.t >= start - S.wfTrainDays * DAY && e.exitT < start), S.refCost)
      if (tr.n < 30) continue
      if (!best || tr.t > best.tr.t) best = { f, tr }
    }
    if (!best || best.tr.t <= 0) { months.push({ start, rule: null, n: 0, mean: 0, sum: 0 }); continue }
    const te = best.f.ev.filter(e => e.t >= start && e.t < end).map(e => e.g - S.refCost)
    trades.push(...te)
    months.push({ start, rule: best.f.text, n: te.length, mean: te.length ? te.reduce((a, b) => a + b, 0) / te.length : 0, sum: te.reduce((a, b) => a + b, 0) })
  }
  return { months, total: stats(trades) }
}

// ---------------------------------------------------------------- the live loop (runs hourly)
const push = (arr, x, max) => { arr.push(x); if (arr.length > max) arr.splice(0, arr.length - max) }
const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`
const utcDate = t => new Date(t).toISOString().slice(0, 10)
const hhmm = t => new Date(t).toISOString().slice(11, 16)

/**
 * Walk a position's completed bars since entry, up to time `upTo`: stop first (honouring gaps),
 * then the early exit, then its planned close. Returns the exit price, reason and time.
 */
function checkExit(pos, coin, upTo, now) {
  if (coin) {
    for (let j = 0; j < coin.t.length; j++) {
      const bs = coin.t[j], be = bs + HOUR
      if (bs < pos.t) continue                   // only bars from the hour we bought onwards
      if (be > upTo) break
      if (coin.l[j] <= pos.stop) return { px: Math.min(coin.o[j], pos.stop), why: 'stop', t: be }
      if (pos.kind === 'mr' && coin.c[j] >= pos.sma24) return { px: coin.c[j], why: 'target', t: be }
      if (be >= pos.exitT) return { px: coin.c[j], why: 'time', t: be }
    }
  }
  return upTo >= now && now >= pos.exitT ? { px: null, why: 'time', t: now } : null
}


export function stepDay(state, market, now, S = DT) {
  const log = (kind, text, t = now) => push(state.events, { t, kind, text }, 400)
  const rate = market.audPerUsd
  const price = b => market.live[b]
  const coinOf = b => market.coins.find(c => c.base === b) || market.held?.[b]
  const ruleByV = new Map(state.rules.map(r => [r.v, r]))
  // keep each paper account's fee and label in step with the exchange's real pricing (lab.js ACCOUNTS)
  for (const cfg of ACCOUNTS) { const a = state.accounts[cfg.id]; if (a) { a.fee = cfg.fee; a.feeLabel = cfg.feeLabel } }
  // rules are chosen on deep history (today's top coins plus past top-list coins, incl. delisted, each
  // only while it was in the list); signals run on every tradable coin
  const data = { coins: [...(market.deep || market.coins), ...(market.history || [])], member: market.member }
  state.unit = 'hours'

  // closes everything whose bars up to `upTo` say it's done (stop, early exit, end of hold)
  const exits = upTo => {
    for (const s of state.shadow.slice()) {
      const x = checkExit(s, coinOf(s.base), upTo, now)
      if (!x) continue
      const px = x.px ?? price(s.base)
      if (!(px > 0)) continue
      const r = ruleByV.get(s.v)
      if (r) { push((r.live ||= { trades: [] }).trades, { t: x.t, base: s.base, g: px / s.entry - 1 }, 400); recordLive(state, r, x.t, s.base, px / s.entry - 1) }
      state.shadow.splice(state.shadow.indexOf(s), 1)
    }
    for (const a of Object.values(state.accounts)) {
      for (const pos of a.positions.slice()) {
        const x = checkExit(pos, coinOf(pos.base), upTo, now)
        if (!x) continue
        const px = x.px ?? price(pos.base)
        if (!(px > 0)) continue
        const proceeds = pos.units * px * (1 - pos.spread / 2 - S.slippage) * (1 - a.fee)
        const net = proceeds / pos.costUsd - 1
        a.cashAud += proceeds * rate
        a.positions.splice(a.positions.indexOf(pos), 1)
        a.stats.n++; a.stats.sumNet += net; if (net > 0) a.stats.wins++
        push(a.closed, { ...pos, rMult: pos.stop && pos.entryPx ? +(net / (1 - pos.stop / pos.entryPx)).toFixed(2) : null, expected: ruleByV.get(pos.v)?.norm?.[pos.base]?.m ?? ruleByV.get(pos.v)?.all?.mean ?? null, exitT: x.t, exitPx: px, net, gross: px / pos.entryPx - 1, why: x.why === 'target' ? 'time' : x.why }, 300)
        log('trade', `${a.owner}: sold ${pos.base} (${x.why === 'stop' ? 'stop-loss' : x.why === 'target' ? 'back to average' : 'end of hold'})${x.t < now - 30 * 60_000 ? ` at ${hhmm(x.t)} UTC` : ''} ${pct(net)} after costs.`, x.t)
      }
    }
  }

  // 1. daily re-test + walk-forward; practice mode while nothing passes
  const noChamp = !state.rules.some(r => r.status === 'champion') || (S.practiceRules && state.learning?.v !== 2 && !state.rules.some(r => r.status === 'champion' && !r.practice))
  const unchecked = state.found?.length && !state.found.some(f => (f.rigor?.v ?? 0) >= 4)
  if ((now - state.lastCoach >= S.coachEveryDays * DAY - HOUR || (S.practiceRules && noChamp) || unchecked) && data.coins.length && data.coins.some(c => c.c.length > 5000)) {
    const SL = withLiveCost(state, market, S)          // choose and check at CoinSpot's real round trip
    const found = discoverDay(data, SL, state)
    state.walk = walkForward(found, data, SL)
    if (found.some(f => f.pass)) {
      for (const r of state.rules) if (r.practice && r.status !== 'retired') { r.status = 'retired'; r.reason = 'a rule passed the checks, so practice ended' }
      coach(state, found, now, S)
    } else if (S.practiceRules) exploreCoach(state, found, now, S, log)
    else coach(state, found, now, S)
    state.found = found.map(f => ({ id: f.id, text: f.text, H: f.H, pass: f.pass, train: f.train, valid: f.valid, all: f.all, rigor: f.rigor }))
    state.coinsScanned = market.coins.map(c => c.base)
    state.lastCoach = now
    ruleByV.clear(); for (const r of state.rules) ruleByV.set(r.v, r)
  }

  // 2. daily loss limit bookkeeping
  const value = a => a.cashAud + rate * a.positions.reduce((s, p) => s + p.units * (price(p.base) || p.entryPx), 0)
  const today = utcDate(now)
  if (state.day?.date !== today) state.day = { date: today, start: Object.fromEntries(Object.values(state.accounts).map(a => [a.id, value(a)])) }

  // 3. every completed hour not yet acted on, oldest first: close what finished, then take that
  //    hour's signals at the price they had (the next hour's open), as if we'd been watching live.
  const lastBar = Math.max(...market.coins.map(c => c.t[c.t.length - 1]))
  const floor = lastBar - S.catchUpHours * HOUR
  const from = state.caughtUp ? Math.max(state.lastSignalDay || 0, floor) : Math.max(Math.floor(now / DAY) * DAY - 2 * HOUR, floor)
  const hours = [...new Set(market.coins.flatMap(c => c.t.slice(-S.catchUpHours - 1).filter(t => t > from && t <= lastBar)))].sort((a, b) => a - b)
  const champ = state.rules.find(r => r.status === 'champion')
  for (const T of hours) {
    const entryT = T + HOUR
    exits(entryT)
    for (const r of state.rules.filter(x => x.status !== 'retired')) {
      for (const coin of market.coins) {
        const i = coin.t.indexOf(T)
        if (i < 0) continue
        const D = dayFeatures(coin)
        if (!daySignal(r.spec, coin, D, i)) continue
        const p = i + 1 < coin.c.length ? coin.o[i + 1] : price(coin.base)
        if (!(p > 0)) continue
        const hold = holdHours(r.spec, new Date(entryT).getUTCHours())
        const sp = dayStopPct(D.hvol[i], hold)
        const exitT = Math.min(Math.floor(entryT / DAY) * DAY + DAY, entryT + HOUR * hold)
        if (exitT <= entryT) continue
        const pos0 = { base: coin.base, t: entryT, stop: p * (1 - sp), exitT, kind: r.spec.kind, sma24: D.sma24[i] }
        if (!state.shadow.some(s => s.v === r.v && s.base === coin.base)) state.shadow.push({ ...pos0, v: r.v, entry: p })
        if (r !== champ && !r.practice) continue   // learning mode: every active idea trades
        // big US releases (CPI, jobs, Fed) move crypto too: stand aside around them, then trade half size for the rest of the day
        const hi = (market.events || []).filter(e => e.market === 'US' && e.impact === 'High')
        const news = S.newsGuard ? hi.find(e => Math.abs(e.t - entryT) <= S.newsGuard) : null
        const after = hi.some(e => e.t < entryT && Math.floor(e.t / DAY) === Math.floor(entryT / DAY))
        for (const a of Object.values(state.accounts)) {
          if (news) { a.blocked.limits++; push(a.lastBlocked, { t: entryT, base: coin.base, v: r.v, why: `high-impact US news nearby: ${news.title}` }, 30); continue }
          a.peakAud = Math.max(a.peakAud || a.startAud, value(a))
          const sizeMul = (after ? 0.5 : 1) * (value(a) < a.peakAud * (1 - S.ddCut) ? 0.5 : 1)
          const dd = value(a) / (state.day.start[a.id] || a.startAud) - 1
          if (dd <= -(r.practice ? S.practiceLossLimit : S.dailyLossLimit)) { a.blocked.limits++; push(a.lastBlocked, { t: entryT, base: coin.base, v: r.v, why: `daily loss limit (${pct(dd)} today)` }, 30); continue }
          const regime = regimeAt(data, '', entryT), rw = regimeWeight(r.rigor?.regime, regime)
          enterDay(a, r, coin.base, p, sp, { ...pos0, sizeMul, regime, rw }, market, now, S, log)
        }
      }
    }
  }
  if (lastBar > (state.lastSignalDay || 0)) state.lastSignalDay = lastBar
  state.caughtUp = true
  exits(now)
  if (failFast(state, now, S, log)) state.lastCoach = 0   // refill the slot on the next full run
  state.events.sort((a, b) => a.t - b.t)

  // 5. valuation
  push(state.history, { t: now, ...Object.fromEntries(Object.values(state.accounts).map(a => [a.id, +value(a).toFixed(2)])) }, 1000)
  for (const a of Object.values(state.accounts)) { a.valueAud = value(a); a.valueUsd = value(a) / rate }
  state.regimeNow = Object.fromEntries([['', regimeAt(market.deep ? { coins: market.deep } : data, '', now + DAY)]].filter(([, v]) => v))
  state.audPerUsd = rate
  state.prices = {}
  for (const a of Object.values(state.accounts)) for (const pos of a.positions) if (price(pos.base) > 0) state.prices[pos.base] = price(pos.base)
  state.lastRun = now
  return state
}

function enterDay(a, r, base, p, sp, pos0, market, now, S, log) {
  const note = why => push(a.lastBlocked, { t: now, base, v: r.v, why }, 30)
  if (a.positions.some(x => x.base === base && (x.v === r.v || !r.practice))) return
  const spread = market.quotes?.[a.id]?.[base]
  if (!(spread >= 0)) { a.blocked.quote++; note(market.unlisted?.[a.id]?.[base] ? `${a.exchange} doesn't sell ${base}` : `no live ${a.exchange} quote for ${base}`); return }
  const cost = 2 * a.fee + spread + 2 * S.slippage
  const est = estimate(r.all)
  if (!r.practice && !(est > cost + S.margin)) { a.blocked.cost++; note(`expected gain ${pct(est)} doesn't cover costs ${pct(cost)} + margin ${pct(S.margin)}`); return }
  const cashUsd = a.cashAud / market.audPerUsd
  const equity = cashUsd + a.positions.reduce((s, x) => s + x.units * (market.live[x.base] || x.entryPx), 0)
  const invested = equity - cashUsd
  const alloc = Math.min(S.maxPosition * equity, S.riskPerTrade * equity / sp * (pos0.rw ?? 1), cashUsd, S.maxInvested * equity - invested) * (pos0.sizeMul ?? 1)
  if (a.positions.length >= (r.practice ? S.practiceMaxOpen : S.maxOpen) || alloc < 1) { a.blocked.limits++; note('risk limits (too many open, or not enough cash)'); return }
  const fill = p * (1 + spread / 2 + S.slippage)
  const units = alloc * (1 - a.fee) / fill
  a.cashAud -= alloc * market.audPerUsd
  a.positions.push({ ...pos0, v: r.v, units, entryPx: p, fillPx: fill, costUsd: alloc, spread, est, cost, estimated: !!market.estimated?.[a.id]?.[base] })
  const at = pos0.t < now - 30 * 60_000 ? ` at ${hhmm(pos0.t)} UTC` : ''
  log('trade', `${a.owner}: bought ${base}${at} with ${(alloc / equity * 100).toFixed(0)}% of the account (${r.practice ? 'practice, ' : ''}rule v${r.v}; expected ${pct(est)} vs cost ${pct(cost)}).`, pos0.t)
}
