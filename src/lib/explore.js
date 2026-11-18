// Learning mode for the day labs, used while no rule has passed the strict checks. Instead of
// waiting for a perfect rule, several different ideas trade the paper accounts at once, and each is
// given time to show what it really does:
//  - eligible: the rule fired often enough in the last 14 days (so it actually produces trades)
//    and isn't on the bench
//  - slots: the best-scoring rule of each different family (momentum, breakout, reversal…), plus one
//    "explorer" slot for the eligible rule with the least live record, so untried ideas get tested
//  - patience: an active idea keeps its slot for at least `minHoldDays` (crypto) or sessions'
//    worth of days (shares), whatever happens in between. Losing trades are expected.
//  - judged against its own normal: for every rule and every coin/share, the backtest gives the
//    usual result per trade and how much it normally swings. Each live trade is compared with what
//    is normal for that rule on that asset. A rule is benched only when, after `failAfter`+ live
//    trades AND `minHoldDays`, its live results sit so far below its own normal range that bad luck
//    is very unlikely (z below `failZ`, about a 1-in-40 chance by luck alone). A run of losses that
//    is normal for that rule in that market is NOT a reason to drop it.
// Every active rule trades the paper accounts with full fees and price gaps charged.

const DAY = 86_400_000

const meanSd = g => {
  const n = g.length
  if (!n) return { n: 0, mean: 0, sd: 0 }
  const mean = g.reduce((a, b) => a + b, 0) / n
  const sd = n > 1 ? Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  return { n, mean, sd }
}

/** Live record of a rule (kept by rule id, so it survives the rule being benched and coming back). */
export function liveStats(state, id, cost, since = 0) {
  const { n, mean, sd } = meanSd((state.liveBy?.[id] || []).filter(x => x.t >= since).map(x => x.g - cost))
  return { n, mean, sum: mean * n, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 }
}

export function recordLive(state, r, t, base, g) {
  const list = ((state.liveBy ||= {})[r.id] ||= [])
  list.push({ t, base, g })
  if (list.length > 300) list.splice(0, list.length - 300)
}

/** What's normal for a rule: per asset (and overall) mean and spread of its backtest trades. */
function norms(f) {
  const by = {}
  for (const e of f.ev || []) (by[e.base] ||= []).push(e.g)
  const all = meanSd((f.ev || []).map(e => e.g))
  const out = { _all: { m: +all.mean.toFixed(5), s: +all.sd.toFixed(5), n: all.n } }
  for (const [b, g] of Object.entries(by)) {
    const x = meanSd(g)
    if (x.n >= 15) out[b] = { m: +x.mean.toFixed(5), s: +x.sd.toFixed(5), n: x.n }
  }
  return out
}

/**
 * How live trades compare with the rule's own normal, asset by asset:
 * z = Σ(result − normal mean for that asset) / √Σ(normal spread²). Around 0 = behaving as usual;
 * below −2 = clearly worse than its history would explain.
 */
export function vsNormal(state, r, since = 0) {
  const trades = (state.liveBy?.[r.id] || []).filter(x => x.t >= since)
  if (!trades.length || !r.norm) return { n: trades.length, z: 0, expected: 0, got: 0 }
  let dev = 0, v = 0, expected = 0, got = 0
  for (const x of trades) {
    const nm = r.norm[x.base] || r.norm._all
    if (!nm || !(nm.s > 0)) continue
    dev += x.g - nm.m; v += nm.s * nm.s; expected += nm.m; got += x.g
  }
  return { n: trades.length, z: v > 0 ? dev / Math.sqrt(v) : 0, expected: expected / trades.length, got: got / trades.length }
}

export function exploreScore(state, f, S) {
  const live = liveStats(state, f.id, S.refCost)
  const w = Math.min(1, live.n / 40)               // live results take over slowly as they build up
  return (1 - w) * (0.5 * f.all.t + 0.5 * f.valid.t) + w * 2 * live.t
}

export function exploreCoach(state, found, now, S, log) {
  const byId = new Map(found.map(f => [f.id, f]))
  for (const r of state.rules) { const f = byId.get(r.id); if (f) { r.train = f.train; r.valid = f.valid; r.all = f.all; r.pass = f.pass; r.rigor = f.rigor; r.norm = norms(f) } }
  state.bench ||= {}
  if (!state.liveBy) { state.liveBy = {}; for (const r of state.rules) for (const x of r.live?.trades || []) recordLive(state, r, x.t, x.base, x.g) }
  for (const [id, until] of Object.entries(state.bench)) if (until <= now) delete state.bench[id]
  const last = Math.max(...found.flatMap(f => f.ev?.length ? [f.ev[f.ev.length - 1].t] : []), 0)
  const recent = f => (f.ev || []).filter(e => e.t >= last - 14 * DAY).length / 14
  const eligible = found.filter(f => !state.bench[f.id] && recent(f) >= S.minPerDay)
  const scored = eligible.map(f => ({ f, s: exploreScore(state, f, S) })).sort((a, b) => b.s - a.s)

  // ideas still inside their minimum run keep their slot, whatever their score
  const active = state.rules.filter(r => r.practice && r.status !== 'retired')
  // (rules carried over from the old practice mode, before the diverse line-up existed, get no protection)
  const protectedR = state.learning?.v === 2 ? active.filter(r => now - (r.since || 0) < S.minHoldDays * DAY && byId.has(r.id)) : []
  const want = protectedR.map(r => ({ f: byId.get(r.id), s: exploreScore(state, byId.get(r.id), S), slot: r.explorer ? 'explorer' : 'challenger', kept: true }))
  const kinds = new Set(want.filter(w => w.slot !== 'explorer').map(w => w.f.spec.kind))
  const mainSlots = S.practiceRules - 1
  for (const x of scored) {
    if (want.filter(w => w.slot !== 'explorer').length >= mainSlots) break
    if (want.some(w => w.f.id === x.f.id) || kinds.has(x.f.spec.kind)) continue
    kinds.add(x.f.spec.kind); want.push({ ...x, slot: 'challenger' })
  }
  if (!want.some(w => w.slot === 'explorer')) {
    const rest = scored.filter(x => !want.some(w => w.f.id === x.f.id))
    // prefer a family not already trading, then the least-tried, then the best score
    rest.sort((a, b) => kinds.has(a.f.spec.kind) - kinds.has(b.f.spec.kind) || liveStats(state, a.f.id, 0).n - liveStats(state, b.f.id, 0).n || b.s - a.s)
    if (rest[0]) want.push({ ...rest[0], slot: 'explorer' })
  }
  // top score among the non-explorer slots is labelled the lead idea
  const lead = want.filter(w => w.slot !== 'explorer').sort((a, b) => b.s - a.s)[0]
  if (lead) lead.slot = 'champion'

  const prevActive = new Set(active.map(r => r.id))
  for (const r of active) {
    if (!want.some(w => w.f.id === r.id)) { r.status = 'retired'; r.reason = now - (r.since || now) >= S.minHoldDays * DAY ? `had its ${S.minHoldDays}-day run; replaced by a stronger or untried idea` : 'made way for a different family of idea'; log('retire', `v${r.v} (learning) stepped aside: ${r.reason}.`) }
  }
  for (const w of want) {
    const f = w.f
    let r = state.rules.find(x => x.id === f.id && x.status !== 'retired')
    if (!r) { r = { v: state.nextV++, id: f.id, spec: f.spec, text: f.text, since: now, train: f.train, valid: f.valid, all: f.all, pass: f.pass, live: { trades: [] } }; state.rules.push(r) }
    if (!prevActive.has(f.id)) r.since = now
    r.practice = true
    r.rigor = f.rigor
    r.norm = norms(f)
    r.status = w.slot === 'champion' ? 'champion' : 'challenger'
    r.explorer = w.slot === 'explorer'
    r.score = +w.s.toFixed(2)
    r.reason = reasonFor(state, r, S, now)
    if (!prevActive.has(f.id)) log('promote', `Learning: v${r.v} starts a ${S.minHoldDays}-day run on paper (${w.slot === 'explorer' ? 'untried idea' : 'best of its kind'}): ${r.text}`)
  }
  state.learning = { v: 2, since: state.learning?.since || now, active: want.length, eligible: eligible.length, benched: Object.keys(state.bench).length, minHoldDays: S.minHoldDays, failAfter: S.failAfter }
}

function reasonFor(state, r, S, now) {
  const nm = vsNormal(state, r, r.since)
  const days = Math.floor((now - r.since) / DAY)
  const left = Math.max(0, S.minHoldDays - days)
  let txt = `learning: ${r.explorer ? 'untried idea, ' : ''}day ${days + 1} of at least ${S.minHoldDays}`
  if (nm.n) txt += ` · ${nm.n} live trade${nm.n === 1 ? '' : 's'}, averaging ${(nm.got * 100).toFixed(2)}% vs its normal ${(nm.expected * 100).toFixed(2)}% on the same coins or shares`
  if (nm.n && nm.n < S.failAfter) txt += ` · too few trades to judge`
  else if (nm.n) txt += nm.z < -1 ? ' · running below its normal, still within luck' : ' · within its normal range'
  if (left) txt += ` · protected for ${left} more day${left === 1 ? '' : 's'}`
  return txt
}

/**
 * Bench an active learning rule only when its live results are far outside what's normal for it on
 * those assets, after enough trades and enough time. Returns true if one was benched.
 */
export function failFast(state, now, S, log) {
  let any = false
  for (const r of state.rules) {
    if (!r.practice || r.status === 'retired') continue
    const nm = vsNormal(state, r, r.since)
    const ranFor = now - (r.since || now)
    if (nm.n >= S.failAfter && ranFor >= S.minHoldDays * DAY && nm.z < S.failZ) {
      r.status = 'retired'
      r.reason = `benched for ${S.benchDays} days: over ${nm.n} live trades it averaged ${(nm.got * 100).toFixed(2)}% a trade vs its normal ${(nm.expected * 100).toFixed(2)}% on the same assets, too far below to be bad luck (z ${nm.z.toFixed(1)})`
      ;(state.bench ||= {})[r.id] = now + S.benchDays * DAY
      log('retire', `v${r.v} ${r.reason}. Its slot goes to the next idea.`)
      any = true
    } else r.reason = reasonFor(state, r, S, now)
  }
  return any
}
