// Shares Day Trade Lab: intraday rules on 1-hour bars of liquid US and ASX shares, every position
// sold by that market's close. Same honest loop as the crypto Day Trade Lab (daytrade.js): rules
// chosen on older data, checked on the held-back last 60 days, a walk-forward test, a daily loss
// limit, and practice trades while nothing passes. Fees are Interactive Brokers' (stocks.js).
//
// Unlike crypto, shares trade in sessions (US 9:30–16:00 New York, ASX 10:00–16:00 Sydney, which
// crosses UTC midnight), so days are each exchange's LOCAL trading day and "hour k" is the k-th bar
// of that session.
//
// Rule families (long only), strongest evidence first:
//  imom   intraday momentum: the session's first hour(s) predict its last hour(s)
//         (Gao, Han, Li & Zhou, Journal of Financial Economics 2018, on US index funds)
//  gap    gap-down fill: after an unusually large opening gap down, buy after the first hour
//  orb    opening-range breakout: price clears the first hour(s)' high
//  volbo  volatility breakout: price clears today's open + K × yesterday's range
//  rev    overreaction reversal after an unusually hard 1-hour fall
// Each with and without a daily-trend filter (previous close above its 20-day average).
import { coach, estimate, feeFrac, stats } from './lab.js'
import { STOCK_ACCOUNTS } from './stocks.js'

export const HOUR = 3_600_000
export const DAY = 86_400_000

export const US_DAY = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'AVGO']
export const ASX_DAY = ['BHP', 'CBA', 'CSL', 'NAB', 'WBC', 'ANZ', 'WES', 'MQG', 'FMG', 'RIO'].map(s => `${s}.AX`)

// US day trading at a US broker (IBKR included) in a margin account needs at least US$25,000, or the
// "pattern day trader" rule limits you to 3 day trades in 5 days. So the US account starts at
// A$40,000 (about US$27,000). The ASX has no such rule.
export const SDT_ACCOUNTS = STOCK_ACCOUNTS.map(a => (a.market === 'US' ? { ...a, startAud: 40000 } : { ...a, startAud: 10000 }))

export const SDT = {
  accounts: SDT_ACCOUNTS,
  margin: 0.001,          // safety margin in the cost gate (0.1%)
  slippage: 0.0005,       // per side, liquid large caps
  maxPosition: 0.25,
  riskPerTrade: 0.005,    // a stop-out loses at most ~0.5% of the account
  maxOpen: 3,
  maxInvested: 0.75,
  dailyLossLimit: 0.02,   // no new trades for the rest of the day after a 2% drop
  validDays: 60,
  refCost: 0.002,         // round trip used for choosing rules (US large caps at IBKR)
  minTrain: 100, minTrainT: 2.5, minValid: 20,
  maxChallengers: 3,
  promoteAfter: 30,
  promoteBy: 0.001,
  coachEveryDays: 1,
  wfTrainDays: 120, wfTestDays: 30,
  practiceRules: 3,       // trade the best few on paper while nothing passes (full costs charged)
  catchUpHours: 30,
}

export function allStockDayRules() {
  const out = []
  for (const tf of [0, 1]) {
    for (const n of [1, 2]) for (const last of [1, 2]) out.push({ kind: 'imom', n, last, tf })
    for (const g of [1, 2]) out.push({ kind: 'gap', g, tf })
    for (const n of [1, 2]) out.push({ kind: 'orb', n, tf })
    for (const K of [0.3, 0.5, 0.7]) out.push({ kind: 'volbo', K, tf })
    for (const k of [2, 3]) for (const H of [1, 2, 3]) out.push({ kind: 'rev', k, H, tf })
  }
  return out.map(r => ({ ...r, id: sdRuleId(r) }))
}
export const sdRuleId = r => `${r.kind}:${r.n ?? r.g ?? r.K ?? r.k}:${r.last ?? r.H ?? ''}:tf${r.tf}`

export function describeStockDay(r) {
  const tf = r.tf ? ', only while the share is in a daily uptrend' : ''
  const h = x => (x > 1 ? `${x} hours` : 'hour')
  switch (r.kind) {
    case 'imom': return `If the share rose over the session's first ${h(r.n)}, buy for its last ${h(r.last)}${tf}.`
    case 'gap': return `After a ${r.g === 1 ? 'large' : 'very large'} opening gap down, buy after the first hour and sell at the close${tf}.`
    case 'orb': return `Buy when price clears the high of the session's first ${h(r.n)}; sell at the close${tf}.`
    case 'volbo': return `Buy when price rises ${r.K} × yesterday's range above today's open; sell at the close${tf}.`
    case 'rev': return `Buy after an unusually hard 1-hour fall (${r.k}× the usual move) and hold up to ${r.H} hour${r.H > 1 ? 's' : ''}, sold by the close${tf}.`
    default: return r.kind
  }
}

// ---------------------------------------------------------------- session features
/** coin = { base, market, t, o, h, l, c, d } with d = local trading date (UTC midnight of it). */
export function sdFeatures(coin) {
  if (coin.SF) return coin.SF
  const { o, h, l, c, d } = coin, n = c.length
  const lr = new Float64Array(n).fill(NaN), hvol = new Float64Array(n).fill(NaN)
  const dayStart = new Int32Array(n), k = new Int16Array(n), lastOfDay = new Uint8Array(n)
  const prevClose = new Float64Array(n).fill(NaN), prevRange = new Float64Array(n).fill(NaN)
  const dvol = new Float64Array(n).fill(NaN), up = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    dayStart[i] = i > 0 && d[i] === d[i - 1] ? dayStart[i - 1] : i
    k[i] = i - dayStart[i]
    if (i > 0 && k[i] > 0) lr[i] = Math.log(c[i] / c[i - 1])     // intraday moves only (no overnight gap)
    if (i > 0 && d[i] !== d[i - 1]) lastOfDay[i - 1] = 1
  }
  // typical session length (bars a day) and hourly volatility from the last ~5 sessions' moves
  const lens = []
  for (let i = 1; i < n; i++) if (lastOfDay[i - 1]) lens.push(k[i - 1] + 1)
  lens.sort((a, b) => a - b)
  const M = lens.length ? lens[Math.floor(lens.length / 2)] : 7
  const win = []
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(lr[i])) { win.push(lr[i]); if (win.length > 35) win.shift() }
    if (win.length >= 20) { const m = win.reduce((a, b) => a + b, 0) / win.length; hvol[i] = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / (win.length - 1)) }
  }
  // daily closes → previous close, previous range, daily volatility, 20-day trend
  const days = []   // { start, end, close, hi, lo }
  for (let i = 0; i < n; i++) {
    if (k[i] === 0) days.push({ start: i, close: c[i], hi: h[i], lo: l[i] })
    const D = days[days.length - 1]; D.close = c[i]; if (h[i] > D.hi) D.hi = h[i]; if (l[i] < D.lo) D.lo = l[i]
  }
  for (let j = 1; j < days.length; j++) {
    const P = days[j - 1], s = days[j].start, e = j + 1 < days.length ? days[j + 1].start : n
    let rets = [], sum = 0
    for (let q = Math.max(1, j - 20); q < j; q++) rets.push(Math.log(days[q].close / days[q - 1].close))
    for (let q = Math.max(0, j - 20); q < j; q++) sum += days[q].close
    const sd = rets.length >= 10 ? Math.sqrt(rets.reduce((a, b) => a + b * b, 0) / rets.length) : NaN
    const isUp = j >= 20 && P.close > sum / 20
    for (let i = s; i < e; i++) { prevClose[i] = P.close; prevRange[i] = P.hi - P.lo; dvol[i] = sd; up[i] = isUp ? 1 : 0 }
  }
  return (coin.SF = { lr, hvol, dayStart, k, lastOfDay, prevClose, prevRange, dvol, up, M })
}

/** Does rule r fire on completed bar i? (Entry is the next bar of the same session.) */
export function sdSignal(r, coin, F, i) {
  if (i < 150 || !Number.isFinite(F.hvol[i]) || !Number.isFinite(F.prevClose[i])) return false
  const k = F.k[i], M = F.M, c = coin.c, ds = F.dayStart[i], open = coin.o[ds]
  if (k >= M - 1 || F.lastOfDay[i]) return false              // nothing left of the session to trade
  if (r.tf && !F.up[i]) return false
  switch (r.kind) {
    case 'imom': return k === M - 1 - r.last && k >= r.n - 1 && c[ds + r.n - 1] / open - 1 > 0
    case 'gap': return k === 0 && Number.isFinite(F.dvol[i]) && open < F.prevClose[i] * (1 - r.g * F.dvol[i])
    case 'orb': {
      if (k < r.n) return false
      let hi = -Infinity
      for (let q = ds; q < ds + r.n; q++) if (coin.h[q] > hi) hi = coin.h[q]
      return c[i] > hi && c[i - 1] <= hi
    }
    case 'volbo': {
      if (k < 1) return false
      const lvl = open + r.K * F.prevRange[i]
      return c[i] > lvl && c[i - 1] <= lvl
    }
    case 'rev': return k >= 1 && Number.isFinite(F.hvol[i - 1]) && F.lr[i] < -r.k * F.hvol[i - 1]
    default: return false
  }
}

/** Bars to hold after entering at the start of session bar kEntry (always ends by the close). */
export function sdHold(r, kEntry, M) {
  const left = Math.max(1, M - kEntry)
  if (r.kind === 'imom') return Math.min(r.last, left)
  if (r.kind === 'rev') return Math.min(r.H, left)
  return left
}
export const sdStopPct = (hvol, bars) => Math.max(0.005, Math.min(0.04, 2 * hvol * Math.sqrt(Math.max(1, bars))))

/** Every past signal: enter at the next bar's open, exit at the stop, after the hold, or at the close. */
export function sdEvents(r, data) {
  const out = []
  for (const coin of data.coins) {
    const F = sdFeatures(coin), n = coin.c.length
    const lastDay = coin.d[n - 1]          // the newest session may be unfinished: leave it out
    let busy = 0
    for (let i = 150; i < n - 1; i++) {
      if (i < busy || coin.d[i] === lastDay || !sdSignal(r, coin, F, i)) continue
      const e = i + 1
      if (coin.d[e] !== coin.d[i]) continue
      const hold = sdHold(r, F.k[e], F.M)
      const entry = coin.o[e], stop = entry * (1 - sdStopPct(F.hvol[i], hold))
      let exit = NaN, j = e
      for (; j < n; j++) {
        if (coin.l[j] <= stop) { exit = Math.min(coin.o[j], stop); break }
        if (j - e + 1 >= hold || F.lastOfDay[j]) { exit = coin.c[j]; break }
      }
      if (!Number.isFinite(exit)) break
      out.push({ base: coin.base, t: coin.t[i], exitT: coin.t[j] + HOUR, g: exit / entry - 1 })
      busy = j + 1
    }
  }
  return out
}

/** Re-test all rules: chosen on older data, checked on the held-back last 60 days. */
export function discoverStockDay(data, S = SDT) {
  const last = Math.max(...data.coins.map(c => c.t[c.t.length - 1]))
  const cut = last - S.validDays * DAY
  return allStockDayRules().map(r => {
    const ev = sdEvents(r, data)
    const train = stats(ev.filter(e => e.exitT < cut), S.refCost)
    const valid = stats(ev.filter(e => e.t >= cut), S.refCost)
    const all = stats(ev)
    const pass = train.n >= S.minTrain && train.t >= S.minTrainT && valid.n >= S.minValid && valid.mean > 0
    return { ...r, spec: { kind: r.kind, n: r.n, g: r.g, K: r.K, k: r.k, last: r.last, H: r.H, tf: r.tf }, text: describeStockDay(r), train, valid, all, pass, ev }
  }).sort((a, b) => (b.pass - a.pass) || b.train.t - a.train.t)
}

/** Walk-forward: each month pick the best rule on the previous 120 days only, record the next 30. */
export function walkForwardStockDay(found, data, S = SDT) {
  const first = Math.min(...data.coins.map(c => c.t[150] ?? Infinity))
  const last = Math.max(...data.coins.map(c => c.t[c.t.length - 1]))
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

// ---------------------------------------------------------------- the live loop (twice an hour)
const push = (arr, x, max) => { arr.push(x); if (arr.length > max) arr.splice(0, arr.length - max) }
const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`
const darwinDate = t => new Date(t + 9.5 * HOUR).toISOString().slice(0, 10)   // both sessions fit in one Darwin day
const hhmm = t => new Date(t + 9.5 * HOUR).toISOString().slice(11, 16)

/** Walk a position's completed bars since entry, up to `upTo`: stop, end of hold, or the close. */
function checkExit(pos, coin, upTo, now, session) {
  if (coin) {
    const F = sdFeatures(coin)
    let held = 0
    const n = coin.t.length
    for (let j = 0; j < n; j++) {
      if (coin.t[j] < pos.t) continue
      // the session's final bar (US: 15:30–16:00) can be shorter than an hour: it ends at the close
      const todayDone = j === n - 1 && session && coin.d[j] === session.day && now >= session.end
      const finalBar = todayDone && (F.k[j] >= F.M - 1 || now >= session.end + HOUR)
      const be = finalBar ? Math.min(coin.t[j] + HOUR, session.end) : coin.t[j] + HOUR
      if (be > upTo) break
      held++
      if (coin.l[j] <= pos.stop) return { px: Math.min(coin.o[j], pos.stop), why: 'stop', t: be }
      const closed = F.lastOfDay[j] || finalBar
      if (held >= pos.holdBars || closed) return { px: coin.c[j], why: closed ? 'close' : 'time', t: be }
    }
  }
  return upTo >= now && now >= pos.exitT ? { px: null, why: 'close', t: now } : null
}

function practiceCoach(state, found, now, S, log) {
  const byId = new Map(found.map(f => [f.id, f]))
  for (const r of state.rules) { const f = byId.get(r.id); if (f) { r.train = f.train; r.valid = f.valid; r.all = f.all; r.pass = f.pass } }
  const want = found.filter(f => f.train.n >= S.minTrain).sort((a, b) => b.train.t - a.train.t).slice(0, S.practiceRules)
  const prevChamp = state.rules.find(r => r.status === 'champion')
  for (const r of state.rules) {
    if (r.status === 'retired' || !r.practice) continue
    if (!want.some(f => f.id === r.id)) { r.status = 'retired'; r.reason = 'no longer among the best few'; log('retire', `v${r.v} (practice) retired: ${r.reason}.`) }
  }
  want.forEach((f, k) => {
    let r = state.rules.find(x => x.id === f.id && x.status !== 'retired')
    if (!r) { r = { v: state.nextV++, id: f.id, spec: f.spec, text: f.text, since: now, train: f.train, valid: f.valid, all: f.all, pass: f.pass, live: { trades: [] } }; state.rules.push(r) }
    r.practice = true
    r.status = k === 0 ? 'champion' : 'challenger'
    r.reason = k === 0 ? "practice: best on older data, but hasn't passed the checks after costs" : 'practice: followed in the shadow'
  })
  const champ = state.rules.find(r => r.status === 'champion')
  if (champ && champ !== prevChamp) log('promote', `Practice mode: no rule has passed the checks, so v${champ.v} is traded on paper anyway (full costs charged): ${champ.text}`)
}

/**
 * market = { coins: [{ base, market, t,o,h,l,c,d }], live: { BASE: usd }, audPerUsd,
 *            quotes: { acctId: { BASE: spread } }, sessions: { US: { day, start, end }, ASX: {…} }, full: bool }
 */
export function stepStockDay(state, market, now, S = SDT) {
  const log = (kind, text, t = now) => push(state.events, { t, kind, text }, 400)
  const rate = market.audPerUsd
  const price = b => market.live[b]
  const coinOf = b => market.coins.find(c => c.base === b)
  const ruleByV = new Map(state.rules.map(r => [r.v, r]))
  state.unit = 'hours'
  for (const cfg of S.accounts) if (state.accounts[cfg.id]) Object.assign(state.accounts[cfg.id], cfg, { startAud: state.accounts[cfg.id].startAud })

  const exits = upTo => {
    for (const s of state.shadow.slice()) {
      const coin = coinOf(s.base)
      const x = checkExit(s, coin, upTo, now, market.sessions?.[coin?.market])
      if (!x) continue
      const px = x.px ?? price(s.base)
      if (!(px > 0)) continue
      const r = ruleByV.get(s.v)
      if (r) push((r.live ||= { trades: [] }).trades, { t: x.t, base: s.base, g: px / s.entry - 1 }, 400)
      state.shadow.splice(state.shadow.indexOf(s), 1)
    }
    for (const a of Object.values(state.accounts)) {
      for (const pos of a.positions.slice()) {
        const coin = coinOf(pos.base)
        const x = checkExit(pos, coin, upTo, now, market.sessions?.[coin?.market])
        if (!x) continue
        const px = x.px ?? price(pos.base)
        if (!(px > 0)) continue
        const proceeds = pos.units * px * (1 - pos.spread / 2 - S.slippage) * (1 - feeFrac(a, pos.units * px, px, rate))
        const net = proceeds / pos.costUsd - 1
        a.cashAud += proceeds * rate
        a.positions.splice(a.positions.indexOf(pos), 1)
        a.stats.n++; a.stats.sumNet += net; if (net > 0) a.stats.wins++
        push(a.closed, { ...pos, exitT: x.t, exitPx: px, net, gross: px / pos.entryPx - 1, why: x.why === 'stop' ? 'stop' : 'time' }, 300)
        log('trade', `${a.owner}: sold ${pos.base} (${x.why === 'stop' ? 'stop-loss' : x.why === 'close' ? 'market close' : 'end of hold'})${x.t < now - 40 * 60_000 ? ` at ${hhmm(x.t)} Darwin` : ''} ${pct(net)} after costs.`, x.t)
      }
    }
  }

  // 1. daily re-test + walk-forward (needs the full history); practice mode while nothing passes
  const noChamp = !state.rules.some(r => r.status === 'champion')
  if (market.full && market.coins.length && (now - state.lastCoach >= S.coachEveryDays * DAY - 2 * HOUR || noChamp)) {
    const data = { coins: market.coins }
    const found = discoverStockDay(data, S)
    state.walk = walkForwardStockDay(found, data, S)
    if (found.some(f => f.pass)) {
      for (const r of state.rules) if (r.practice && r.status !== 'retired') { r.status = 'retired'; r.reason = 'a rule passed the checks, so practice ended' }
      coach(state, found, now, S)
    } else practiceCoach(state, found, now, S, log)
    state.found = found.map(f => ({ id: f.id, text: f.text, H: f.H, pass: f.pass, train: f.train, valid: f.valid, all: f.all }))
    state.coinsScanned = market.coins.map(c => c.base)
    state.lastCoach = now
    ruleByV.clear(); for (const r of state.rules) ruleByV.set(r.v, r)
  }

  // 2. daily loss limit bookkeeping (by Darwin date: each session sits inside one)
  const value = a => a.cashAud + rate * a.positions.reduce((s, p) => s + p.units * (price(p.base) || p.entryPx), 0)
  const today = darwinDate(now)
  if (state.day?.date !== today) state.day = { date: today, start: Object.fromEntries(Object.values(state.accounts).map(a => [a.id, value(a)])) }

  // 3. every completed bar not yet acted on, oldest first (each market keeps its own clock):
  //    close what finished, then take that bar's signals at the next bar's open.
  state.lastBars ||= {}
  const todo = []
  for (const coin of market.coins) {
    const from = Math.max(state.lastBars[coin.market] || 0, now - S.catchUpHours * HOUR)
    for (let i = Math.max(0, coin.t.length - 60); i < coin.t.length; i++) if (coin.t[i] > from) todo.push([coin.t[i], coin, i])
  }
  todo.sort((a, b) => a[0] - b[0])
  const champ = state.rules.find(r => r.status === 'champion')
  let lastT = -1
  for (const [T, coin, i] of todo) {
    if (T !== lastT) { exits(T + HOUR); lastT = T }
    const F = sdFeatures(coin)
    const sess = market.sessions?.[coin.market]
    const nextBar = i + 1 < coin.t.length && coin.d[i + 1] === coin.d[i]
    const sessionOpen = sess && now >= sess.start && now < sess.end && coin.d[i] === sess.day
    if (!nextBar && !sessionOpen) continue                        // nothing left to trade into
    const p = nextBar ? coin.o[i + 1] : price(coin.base)
    if (!(p > 0)) continue
    const entryT = nextBar ? coin.t[i + 1] : T + HOUR
    for (const r of state.rules.filter(x => x.status !== 'retired')) {
      if (!sdSignal(r.spec, coin, F, i)) continue
      const holdBars = sdHold(r.spec, F.k[i] + 1, F.M)
      const sp = sdStopPct(F.hvol[i], holdBars)
      const exitT = sessionOpen ? Math.min(sess.end, entryT + holdBars * HOUR) : entryT + holdBars * HOUR
      const pos0 = { base: coin.base, t: entryT, stop: p * (1 - sp), exitT, holdBars, kind: r.spec.kind }
      if (!state.shadow.some(s => s.v === r.v && s.base === coin.base)) state.shadow.push({ ...pos0, v: r.v, entry: p })
      if (r !== champ) continue
      for (const a of Object.values(state.accounts)) {
        if (a.market !== coin.market) continue
        const dd = value(a) / (state.day.start[a.id] || a.startAud) - 1
        if (dd <= -S.dailyLossLimit) { a.blocked.limits++; push(a.lastBlocked, { t: entryT, base: coin.base, v: r.v, why: `daily loss limit (${pct(dd)} today)` }, 30); continue }
        enter(a, r, coin.base, p, sp, pos0, market, now, S, log)
      }
    }
  }
  for (const coin of market.coins) state.lastBars[coin.market] = Math.max(state.lastBars[coin.market] || 0, coin.t[coin.t.length - 1])
  state.lastSignalDay = Math.max(0, ...Object.values(state.lastBars))
  exits(now)
  state.events.sort((a, b) => a.t - b.t)

  // 4. valuation
  push(state.history, { t: now, ...Object.fromEntries(Object.values(state.accounts).map(a => [a.id, +value(a).toFixed(2)])) }, 1000)
  for (const a of Object.values(state.accounts)) { a.valueAud = value(a); a.valueUsd = value(a) / rate }
  state.audPerUsd = rate
  state.prices = {}
  for (const a of Object.values(state.accounts)) for (const pos of a.positions) if (price(pos.base) > 0) state.prices[pos.base] = price(pos.base)
  state.lastRun = now
  return state
}

function enter(a, r, base, p, sp, pos0, market, now, S, log) {
  const note = why => push(a.lastBlocked, { t: now, base, v: r.v, why }, 30)
  if (a.positions.some(x => x.base === base)) return
  const spread = market.quotes?.[a.id]?.[base]
  if (!(spread >= 0)) { a.blocked.quote++; note(`no ${a.exchange} price for ${base}`); return }
  const rate = market.audPerUsd
  const cashUsd = a.cashAud / rate
  const equity = cashUsd + a.positions.reduce((s, x) => s + x.units * (market.live[x.base] || x.entryPx), 0)
  const invested = equity - cashUsd
  const alloc = Math.min(S.maxPosition * equity, S.riskPerTrade * equity / sp, cashUsd, S.maxInvested * equity - invested)
  if (a.positions.length >= S.maxOpen || alloc < 1) { a.blocked.limits++; note('risk limits (too many open, or not enough cash)'); return }
  const fee = feeFrac(a, alloc, p, rate)
  const cost = 2 * fee + spread + 2 * S.slippage
  const est = estimate(r.all)
  if (!r.practice && !(est > cost + S.margin)) { a.blocked.cost++; note(`expected gain ${pct(est)} doesn't cover costs ${pct(cost)} + margin ${pct(S.margin)}`); return }
  const fill = p * (1 + spread / 2 + S.slippage)
  const units = alloc * (1 - fee) / fill
  a.cashAud -= alloc * rate
  a.positions.push({ ...pos0, v: r.v, units, entryPx: p, fillPx: fill, costUsd: alloc, spread, est, cost, estimated: false })
  const at = pos0.t < now - 40 * 60_000 ? ` at ${hhmm(pos0.t)} Darwin` : ''
  log('trade', `${a.owner}: bought ${base}${at} with ${(alloc / equity * 100).toFixed(0)}% of the account (${r.practice ? 'practice, ' : ''}rule v${r.v}; expected ${pct(est)} vs cost ${pct(cost)}).`, pos0.t)
}
