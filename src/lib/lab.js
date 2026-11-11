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
  minTrain: 30, minTrainT: 2.0, minValid: 8,
  maxChallengers: 3,
  promoteAfter: 12,      // closed live trades needed before a promotion / rollback
  promoteBy: 0.002,      // a challenger must beat the champion by 0.2% per trade
  coachEveryDays: 7,
}

export const ACCOUNTS = [
  { id: 'john', owner: 'John', broker: 'coinspot', exchange: 'CoinSpot', fee: 0.001, feeLabel: '0.1% market order', startAud: 1000 },
  { id: 'mark', owner: 'Mark', broker: 'coinbase', exchange: 'Coinbase Advanced', fee: 0.012, feeLabel: '1.2% taker (lowest tier)', startAud: 150 },
]

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
export const ruleId = r => [r.kind, r.n ?? r.k ?? '', r.regime, 'H' + r.H].join(':')

export function describe(r) {
  const reg = r.regime === 'any' ? '' : ` ${REGIMES[r.regime]}`
  const hold = `Hold up to ${r.H} days, with a stop-loss.`
  if (r.kind === 'breakout') return `Buy when a coin closes at a new ${r.n}-day high${reg}. ${hold}`
  if (r.kind === 'dip') return `Buy a ${r.k === 1.5 ? 'sharp' : 'very sharp'} 5-day dip while the coin is above its 100-day average${reg}. ${hold}`
  if (r.kind === 'surge') return `Buy after an unusually strong 20-day rise${reg}. ${hold}`
  return `Buy after an unusually hard 5-day fall (bet on a bounce). ${hold}`
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

const regimeOk = (reg, x) => reg === 'any' ? Number.isFinite(x) : reg === 'quiet' ? x < 0.8 : x > 1.25

export function signal(r, coin, F, i) {
  if (i < 200 || !Number.isFinite(F.dvol[i]) || !regimeOk(r.regime, F.ratio[i])) return false
  const c = coin.c[i], dv = F.dvol[i]
  if (r.kind === 'breakout') return c > (r.n === 20 ? F.hi20[i] : F.hi55[i])
  if (r.kind === 'dip') return c > F.sma100[i] && F.r5[i] < -r.k * dv * Math.sqrt(5)
  if (r.kind === 'surge') return F.r20[i] > 2 * dv * Math.sqrt(20)
  if (r.kind === 'crash') return F.r5[i] < -3 * dv * Math.sqrt(5)
  return false
}

/** Stop distance: about 2.5 typical moves over the holding period, between 5% and 25%. */
export const stopPct = (dailyVol, H) => Math.max(0.05, Math.min(0.25, 2.5 * dailyVol * Math.sqrt(Math.min(H, 10))))

// ---------------------------------------------------------------- backtest of one rule
/** Every past signal of rule r on every coin: enter next day's open, exit at stop or after H days. */
export function events(r, data) {
  const out = []
  for (const coin of data.coins) {
    const F = coin.F || (coin.F = features(coin))
    const D = coin.c.length
    let busy = 0
    for (let i = 200; i < D - 1; i++) {
      if (i < busy || !signal(r, coin, F, i)) continue
      const entry = coin.o[i + 1], stop = entry * (1 - stopPct(F.dvol[i], r.H))
      let exit = NaN, j = i + 1
      for (; j <= i + r.H && j < D; j++) {
        if (coin.l[j] <= stop) { exit = j === i + 1 ? stop : Math.min(coin.o[j], stop); break }
        if (j === i + r.H) { exit = coin.c[j]; break }
      }
      if (!Number.isFinite(exit)) break       // still open at the end of the data
      out.push({ base: coin.base, t: coin.t[i], exitT: coin.t[j], g: exit / entry - 1 })
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
export function discover(data, S = LAB) {
  const last = Math.max(...data.coins.map(c => c.t[c.t.length - 1]))
  const cut = last - S.validDays * DAY
  return allRules().map(r => {
    const ev = events(r, data)
    const train = stats(ev.filter(e => e.exitT < cut), S.refCost)
    const valid = stats(ev.filter(e => e.t >= cut), S.refCost)
    const all = stats(ev)                       // gross, used by the cost gate
    const pass = train.n >= S.minTrain && train.t >= S.minTrainT && valid.n >= S.minValid && valid.mean > 0
    return { ...r, text: describe(r), train, valid, all, pass }
  }).sort((a, b) => (b.pass - a.pass) || b.train.t - a.train.t)
}

/** Mark's gain estimate: average gain of all past signals minus one standard error (losers included). */
export const estimate = all => all.mean - all.se

// ---------------------------------------------------------------- the live loop
export function newState(audPerUsd, now) {
  return {
    version: 1, created: now, lastRun: null, lastSignalDay: 0, lastCoach: 0, nextV: 1,
    rules: [], shadow: [], events: [], history: [],
    accounts: Object.fromEntries(ACCOUNTS.map(a => [a.id, {
      ...a, startUsd: a.startAud / audPerUsd, cashUsd: a.startAud / audPerUsd, positions: [], closed: [],
      stats: { n: 0, wins: 0, sumNet: 0 }, blocked: { cost: 0, quote: 0, limits: 0 }, lastBlocked: [],
    }])),
  }
}

const push = (arr, x, max) => { arr.push(x); if (arr.length > max) arr.splice(0, arr.length - max) }
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
    if (f) { r.train = f.train; r.valid = f.valid; r.all = f.all; r.pass = f.pass }
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
    const r = { v: state.nextV++, id: f.id, spec: { kind: f.kind, n: f.n, k: f.k, regime: f.regime, H: f.H }, text: f.text,
      status: champ ? 'challenger' : 'champion', since: now, train: f.train, valid: f.valid, all: f.all, pass: f.pass, live: { trades: [] } }
    state.rules.push(r)
    if (!champ) { champ = r; r.reason = 'best rule on the back-test'; log('promote', `v${r.v} is the first trading rule: ${r.text} (past signals ${pct(f.all.mean)} a trade before costs, ${f.all.n} trades).`) }
    else log('challenger', `v${r.v} added to test on paper: ${r.text}`)
  }
  if (!champ) { log('note', 'No rule passed the checks, so the accounts stay in cash this week.'); return }

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
export function step(state, market, now, S = LAB) {
  const log = (kind, text) => push(state.events, { t: now, kind, text }, 300)
  const price = b => market.live[b]
  const ruleByV = new Map(state.rules.map(r => [r.v, r]))
  const data = { coins: market.coins }

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
      const proceeds = pos.units * p * (1 - pos.spread / 2 - S.slippage) * (1 - a.fee)
      const net = proceeds / pos.costUsd - 1
      a.cashUsd += proceeds
      a.positions.splice(a.positions.indexOf(pos), 1)
      a.stats.n++; a.stats.sumNet += net; if (net > 0) a.stats.wins++
      push(a.closed, { ...pos, exitT: now, exitPx: p, net, gross: p / pos.entryPx - 1, why: stopped ? 'stop' : 'time' }, 200)
      log('trade', `${a.owner}: sold ${pos.base} (${stopped ? 'stop-loss' : 'time up'}) ${pct(net)} after costs.`)
    }
  }

  // 2. the coach, weekly
  if (now - state.lastCoach >= S.coachEveryDays * DAY - 6 * 3_600_000) {
    const found = discover(data, S)
    coach(state, found, now, S)
    state.found = found.map(f => ({ id: f.id, text: f.text, H: f.H, pass: f.pass, train: f.train, valid: f.valid, all: f.all }))
    state.coinsScanned = market.coins.map(c => c.base)
    state.lastCoach = now
  }

  // 3. entries, once per new daily close
  const lastDay = Math.max(...market.coins.map(c => c.t[c.t.length - 1]))
  if (lastDay > state.lastSignalDay) {
    state.lastSignalDay = lastDay
    const champ = state.rules.find(r => r.status === 'champion')
    for (const r of state.rules.filter(x => x.status !== 'retired')) {
      for (const coin of market.coins) {
        const i = coin.c.length - 1
        if (coin.t[i] !== lastDay) continue
        const F = coin.F || (coin.F = features(coin))
        if (!signal(r.spec, coin, F, i)) continue
        const p = price(coin.base); if (!(p > 0)) continue
        const sp = stopPct(F.dvol[i], r.spec.H)
        if (!state.shadow.some(s => s.v === r.v && s.base === coin.base))
          state.shadow.push({ v: r.v, base: coin.base, entry: p, t: now, stop: p * (1 - sp), exitT: now + r.spec.H * DAY })
        if (r !== champ) continue
        for (const a of Object.values(state.accounts)) enter(a, r, coin.base, p, sp, market, now, S, log)
      }
    }
  }

  // 4. valuation
  const value = a => a.cashUsd + a.positions.reduce((s, pos) => s + pos.units * (price(pos.base) || pos.entryPx), 0)
  push(state.history, { t: now, ...Object.fromEntries(Object.values(state.accounts).map(a => [a.id, +(value(a) * market.audPerUsd).toFixed(2)])) }, 600)
  for (const a of Object.values(state.accounts)) { a.valueUsd = value(a); a.valueAud = value(a) * market.audPerUsd }
  state.audPerUsd = market.audPerUsd
  state.lastRun = now
  return state
}

function enter(a, r, base, p, sp, market, now, S, log) {
  const note = why => { push(a.lastBlocked, { t: now, base, v: r.v, why }, 30) }
  if (a.positions.some(x => x.base === base)) return
  const spread = market.quotes?.[a.id]?.[base]
  if (!(spread >= 0)) { a.blocked.quote++; note(`no live ${a.exchange} quote for ${base}`); return }
  const cost = 2 * a.fee + spread + 2 * S.slippage
  const est = estimate(r.all)
  if (!(est > cost + S.margin)) {
    a.blocked.cost++
    note(`estimated gain ${pct(est)} doesn't cover costs ${pct(cost)} + margin ${pct(S.margin)}`)
    return
  }
  const equity = a.cashUsd + a.positions.reduce((s, x) => s + x.units * (market.live[x.base] || x.entryPx), 0)
  const invested = equity - a.cashUsd
  const alloc = Math.min(S.maxPosition * equity, S.riskPerTrade * equity / sp, a.cashUsd, S.maxInvested * equity - invested)
  if (a.positions.length >= S.maxOpen || alloc < 1) { a.blocked.limits++; note('risk limits (too many open, or not enough cash)'); return }
  const fill = p * (1 + spread / 2 + S.slippage)
  const units = alloc * (1 - a.fee) / fill
  a.cashUsd -= alloc
  a.positions.push({ base, v: r.v, units, entryPx: p, fillPx: fill, costUsd: alloc, t: now, stop: p * (1 - sp), exitT: now + r.spec.H * DAY, spread, est, cost })
  log('trade', `${a.owner}: bought ${base} with ${(alloc / equity * 100).toFixed(0)}% of the account (rule v${r.v}; estimate ${pct(est)} vs cost ${pct(cost)}).`)
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
