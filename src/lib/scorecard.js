// The engine's own scorecard. Testing thousands of rules is only useful if the engine's ranking
// means something: when it says one group of ideas is more promising than another, does that group
// actually do better AFTERWARDS? This file keeps the evidence that can't be rebuilt later: what the
// engine believed, dated, before it knew the outcome.
//
// Every week each lab saves its ranking (frozen rule definitions, scores, ranks) and marks three
// groups of eligible rules:
//   top     the 5 highest-ranked
//   near    5 near misses, sampled from ranks 6–20
//   random  5 sampled at random from everything else that is eligible
// Each group is then followed over the same future window (signals in the next `horizonDays`),
// at the same venue cost, with equal risk per trade: every result is also counted in R (net result
// ÷ the trade's stop distance), so a wide-stop rule can't win just by taking more risk. Across all
// ranked rules the rank correlation (rank vs later R) says whether higher scores predict better
// results, or whether everything rises and falls together.
//
// Samples are drawn with a generator seeded by the snapshot's date, so they can be re-drawn exactly.

export const SC = { everyDays: 7, groupSize: 5, nearTo: 20, keep: 60, minTrades: 20 }
const DAY = 86_400_000

const nChecks = f => Object.values(f.rigor?.checks || {}).filter(Boolean).length
/** The engine's ranking: rules that pass everything first, then the number of checks passed,
 *  then the strength of the older-data result. `score` folds that into one comparable number. */
export function rankFound(found, { minTrades = SC.minTrades, score } = {}) {
  const sc = score || (f => (f.pass ? 1000 : 0) + 10 * nChecks(f) + Math.max(-9.99, Math.min(9.99, f.train?.t || 0)))
  return found
    .filter(f => (f.train?.n || 0) >= minTrades)
    .map(f => ({ id: f.id, score: +sc(f).toFixed(4), f }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .map((x, i) => ({ id: x.id, rank: i + 1, score: x.score, f: x.f }))
}

const rng = seed => { let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1; return () => (s = (s * 16807) % 2147483647) / 2147483647 }
const sample = (arr, k, R) => { const a = arr.slice(), out = []; while (a.length && out.length < k) out.push(a.splice(Math.floor(R() * a.length), 1)[0]); return out }

/** Save this week's ranking (at most once every `everyDays`). `specOf` gives a rule's frozen definition. */
export function takeSnapshot(state, ranked, now, { lab, cost, horizonDays, version, specOf = f => f.spec, textOf = f => f.text } = {}, S = SC) {
  const sc = (state.scorecard ||= { snaps: [], v: 1 })
  const last = sc.snaps[sc.snaps.length - 1]
  if (last && now - last.at < S.everyDays * DAY - 6 * 3_600_000) return null
  if (ranked.length < S.groupSize * 3) return null
  const R = rng(Math.floor(now / DAY))
  const top = ranked.slice(0, S.groupSize)
  const near = sample(ranked.slice(S.groupSize, S.nearTo), S.groupSize, R)
  const rest = sample(ranked.slice(S.nearTo), S.groupSize, R)
  const group = new Map([...top.map(x => [x.id, 'top']), ...near.map(x => [x.id, 'near']), ...rest.map(x => [x.id, 'random'])])
  const snap = {
    at: now, lab, cost, horizonDays, version, eligible: ranked.length,
    // every ranked rule's rank and score (for the rank correlation); definitions only where needed
    ranks: ranked.map(x => [x.id, x.rank, x.score]),
    rules: ranked.filter(x => group.has(x.id)).map(x => ({ id: x.id, rank: x.rank, score: x.score, group: group.get(x.id), spec: specOf(x.f), text: textOf(x.f) })),
  }
  sc.snaps.push(snap)
  if (sc.snaps.length > S.keep) sc.snaps.splice(0, sc.snaps.length - S.keep)
  return snap
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
function spearman(xs, ys) {
  const n = xs.length
  if (n < 5) return null
  const rk = v => { const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), r = new Array(n); for (let i = 0; i < n;) { let j = i; while (j + 1 < n && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2; i = j + 1 } return r }
  const a = rk(xs), b = rk(ys), ma = mean(a), mb = mean(b)
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2 }
  return da > 0 && db > 0 ? +(num / Math.sqrt(da * db)).toFixed(3) : null
}

/**
 * Follow every snapshot forward with today's data. `eventsOf(spec)` returns that rule's trades (only
 * the snapshot's frozen definition is used, never today's version of the rule). `specById` gives
 * definitions for the other ranked rules where they still exist (fixed menus), for the correlation.
 * A snapshot is final once its window plus the longest hold has passed; final results are frozen.
 */
export function scoreSnapshots(state, eventsOf, now, { specById = () => null, maxHoldDays = 20 } = {}) {
  const sc = state.scorecard
  if (!sc?.snaps?.length) return null
  for (const s of sc.snaps) {
    if (s.final) continue
    const end = s.at + s.horizonDays * DAY
    const fwd = spec => {
      const ev = spec ? eventsOf(spec).filter(e => e.t >= s.at && e.t < end && e.exitT <= now) : []
      return ev.map(e => { const net = e.g - s.cost; return { net, r: e.sp > 0 ? net / e.sp : net / 0.05 } })
    }
    const groups = {}
    for (const g of ['top', 'near', 'random']) {
      const trades = s.rules.filter(r => r.group === g).flatMap(r => fwd(r.spec))
      groups[g] = { n: trades.length, net: +mean(trades.map(x => x.net)).toFixed(5), r: +mean(trades.map(x => x.r)).toFixed(4), sumR: +trades.reduce((a, x) => a + x.r, 0).toFixed(3) }
    }
    // rank correlation over every ranked rule that traded in the window
    const xs = [], ys = []
    for (const [id, rank] of s.ranks) {
      const spec = s.rules.find(r => r.id === id)?.spec || specById(id)
      const t = fwd(spec)
      if (t.length) { xs.push(-rank); ys.push(mean(t.map(x => x.r))) }
    }
    s.result = { groups, ic: spearman(xs, ys), icRules: xs.length, scoredAt: now }
    if (now >= end + (maxHoldDays + 2) * DAY) s.final = true
  }
  return summarise(sc)
}

/** Pooled over all snapshots with results: does the engine's top group beat its near misses and a random draw? */
export function summarise(sc) {
  const done = (sc?.snaps || []).filter(s => s.result && s.result.groups.top.n + s.result.groups.random.n > 0)
  const pool = g => { const n = done.reduce((a, s) => a + s.result.groups[g].n, 0); return { n, r: n ? +(done.reduce((a, s) => a + s.result.groups[g].r * s.result.groups[g].n, 0) / n).toFixed(4) : 0, net: n ? +(done.reduce((a, s) => a + s.result.groups[g].net * s.result.groups[g].n, 0) / n).toFixed(5) : 0 } }
  const ics = done.map(s => s.result.ic).filter(x => x != null)
  const both = done.filter(s => s.result.groups.top.n && s.result.groups.random.n)
  const out = {
    snapshots: sc?.snaps?.length || 0, scored: done.length, final: done.filter(s => s.final).length,
    first: sc?.snaps?.[0]?.at ?? null,
    groups: { top: pool('top'), near: pool('near'), random: pool('random') },
    ic: ics.length ? +mean(ics).toFixed(3) : null, icWeeks: ics.length,
    topBeatsRandom: both.length ? { wins: both.filter(s => s.result.groups.top.r > s.result.groups.random.r).length, of: both.length } : null,
  }
  sc.summary = out
  return out
}

// ---------------------------------------------------------------- the engine's own account
/**
 * A BTC-and-cash benchmark with the same exposure as the engine's account: after each run, the
 * benchmark holds BTC in the same proportion as the account has invested, the rest in cash, paying
 * `tradeCost` on every change in exposure. Answers: even if the engine ranks ideas well, does running
 * the account (promoting, sizing, switching, sitting in cash) turn that into money?
 */
export function stepBenchmark(state, { now, btc, accountValue, exposure, tradeCost = 0.0015 }) {
  if (!(btc > 0) || !(accountValue > 0)) return state.benchmark
  const b = (state.benchmark ||= { since: now, value: accountValue, lastBtc: btc, exposure: 0, peak: accountValue, maxDD: 0, acctPeak: accountValue, acctMaxDD: 0, acctStart: accountValue })
  b.value *= 1 + b.exposure * (btc / b.lastBtc - 1)
  const x = Math.max(0, Math.min(1, exposure))
  b.value *= 1 - Math.abs(x - b.exposure) * tradeCost
  b.exposure = x; b.lastBtc = btc; b.at = now
  b.peak = Math.max(b.peak, b.value); b.maxDD = Math.max(b.maxDD, 1 - b.value / b.peak)
  b.acct = accountValue
  b.acctPeak = Math.max(b.acctPeak, accountValue); b.acctMaxDD = Math.max(b.acctMaxDD, 1 - accountValue / b.acctPeak)
  b.value = +b.value.toFixed(4)
  return b
}

/** Everything a re-test decides about each rule, for comparing two runs (event lists and caches left out). */
export const decisionDigest = found => found.map(f => ({
  id: f.id, pass: f.pass, train: f.train, valid: f.valid, all: f.all,
  checks: f.rigor?.checks, passedAll: f.rigor?.passedAll, sharpe: f.rigor?.sharpe, dsr: f.rigor?.dsr, regime: f.rigor?.regime?.weights,
}))
