// The Explorer: invents NEW strategies by combining building blocks (blocks.js), keeps the
// fittest, and breeds variations of them — a small genetic search. Only ideas that survive an
// honest check graduate to paper trading, using the same loop as the Lab (lab.js step/coach).
//
// Guarding against "found by luck":
//  - Ideas are bred and ranked on OLDER data only (everything before the last 180 days).
//  - Each idea gets ONE look at the held-back last 180 days, and only once it clears a bar that
//    RISES with the number of ideas tried (the expected best t-score of that many coin flips).
//  - Simpler ideas are preferred: each extra condition costs fitness.
import { allTrials, assess, RIGOR_V } from './rigor.js'
import { preSeal, sealedLast } from './exam.js'
import { comboId, describeCombo, HOLDS, randomCond, STOPS, validCombo } from './blocks.js'
import { DAY, events, LAB, stats } from './lab.js'

export const EXPLORE = {
  ...LAB,
  coachEveryDays: 0,      // the coach runs every time (graduates appear any run)
  promoteAfter: 12,
  population: 40,         // ideas kept between runs
  randomPerRun: 48,
  mutantsPerRun: 60,
  crossPerRun: 18,
  minTrades: 30,          // to be ranked at all
  minGradTrades: 60,      // to get a look at the held-back data
  complexityCost: 0.3,    // fitness lost per extra condition
  graduates: 8,
}

/** Small seeded generator so a run can be reproduced from its seed. */
export function rng(seed) {
  let s = seed >>> 0 || 1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
}

/** The bar an idea must clear: the t-score the luckiest of N useless ideas would reach. */
export const hurdle = tried => Math.max(2.5, Math.sqrt(2 * Math.log(Math.max(10, tried / 10))))

function mutate(spec, rnd) {
  const s = { conds: spec.conds.map(c => ({ ...c })), H: spec.H, stopM: spec.stopM }
  const r = rnd()
  if (r < 0.2) s.H = HOLDS[Math.floor(rnd() * HOLDS.length)]
  else if (r < 0.35) s.stopM = STOPS[Math.floor(rnd() * STOPS.length)]
  else if (r < 0.55 && s.conds.length < 3) s.conds.push(randomCond(rnd))
  else if (r < 0.7 && s.conds.length > 1) s.conds.splice(Math.floor(rnd() * s.conds.length), 1)
  else s.conds[Math.floor(rnd() * s.conds.length)] = randomCond(rnd)
  return s
}

function cross(a, b, rnd) {
  const pool = [...a.conds, ...b.conds]
  const n = 1 + Math.floor(rnd() * Math.min(3, pool.length))
  const conds = []
  while (conds.length < n && pool.length) conds.push({ ...pool.splice(Math.floor(rnd() * pool.length), 1)[0] })
  return { conds, H: rnd() < 0.5 ? a.H : b.H, stopM: rnd() < 0.5 ? a.stopM : b.stopM }
}

function randomSpec(rnd) {
  const n = 1 + Math.floor(rnd() * 3)
  return { conds: Array.from({ length: n }, () => randomCond(rnd)), H: HOLDS[Math.floor(rnd() * HOLDS.length)], stopM: STOPS[Math.floor(rnd() * STOPS.length)] }
}

/**
 * One generation. Called by lab.step() in place of the Lab's fixed discover().
 * Returns the graduates in the Lab's "found" format so the same coach can trade them.
 */
export function evolve(data, S = EXPLORE, state, now) {
  const ex = (state.explore ||= { gen: 0, tried: 0, holdoutTests: 0, population: [], graduates: [], seen: [], log: [] })
  ex.gen++
  const rnd = rng((now / 3_600_000) ^ (ex.gen * 2654435761))
  const last = sealedLast(data)              // breeding and the held-back look never see the sealed exam window
  const cut = last - S.validDays * DAY
  const seen = new Set(ex.seen)
  if (S.benchmarks && !data.bench) { data.bench = {}; for (const [m, b] of Object.entries(S.benchmarks)) data.bench[m] = data.coins.find(c => c.base === b) }

  // breed
  const pop = ex.population
  const parent = () => {   // tournament of 3 on fitness
    let best = null
    for (let k = 0; k < 3 && pop.length; k++) { const p = pop[Math.floor(rnd() * pop.length)]; if (!best || p.fitness > best.fitness) best = p }
    return best
  }
  const kids = []
  for (let k = 0; k < S.randomPerRun * (pop.length ? 1 : 4); k++) kids.push(randomSpec(rnd))   // seed wide on the first run
  for (let k = 0; k < S.mutantsPerRun && pop.length; k++) kids.push(mutate(parent().spec, rnd))
  for (let k = 0; k < S.crossPerRun && pop.length > 1; k++) kids.push(cross(parent().spec, parent().spec, rnd))

  // evaluate on OLDER data only
  let added = 0
  for (const spec of kids) {
    if (!validCombo(spec)) continue
    const id = comboId(spec)
    if (seen.has(id)) continue
    seen.add(id); ex.tried++; added++
    const full = { kind: 'combo', ...spec, ...(S.asset ? { asset: S.asset } : {}) }
    const ev = preSeal(events(full, data))
    const train = stats(ev.filter(e => e.exitT < cut), S.refCost)
    if (train.n < S.minTrades) continue
    const fitness = train.t - S.complexityCost * (spec.conds.length - 1)
    pop.push({ id, spec: full, text: describeCombo(full), train, fitness, gen: ex.gen, tested: false })
  }
  ex.seen = [...seen].slice(-3000)
  pop.sort((a, b) => b.fitness - a.fitness)
  // keep variety: at most 2 versions of the same set of conditions (differing only in hold/stop)
  const per = new Map()
  ex.population = pop.filter((p, i, a) => {
    if (a.findIndex(q => q.id === p.id) !== i) return false
    const sig = p.id.split(':H')[0]
    per.set(sig, (per.get(sig) || 0) + 1)
    return per.get(sig) <= 2
  }).slice(0, S.population)

  // one honest look at the held-back period, only for ideas that clear the rising bar
  const bar = hurdle(ex.tried)
  ex.hurdle = bar
  // luck is counted by genuinely different ideas: versions that only differ in hold or stop are
  // near-copies, so each distinct set of conditions counts once (scaled to everything ever tried)
  const sigs = new Set(ex.seen.map(id => id.split(':H')[0]))
  state.trialsEff = Math.max(1, Math.round(ex.tried * sigs.size / Math.max(1, ex.seen.length)))
  state.trialsGroups = { groups: sigs.size, rules: ex.seen.length }
  for (const p of ex.population) {
    if (p.tested || p.train.t < bar || p.train.n < S.minGradTrades) continue
    p.tested = true; ex.holdoutTests++
    const evAll = events(p.spec, data), ev = preSeal(evAll)
    p.valid = stats(ev.filter(e => e.t >= cut), S.refCost)
    p.all = stats(evAll)
    p.passed = p.valid.n >= 15 && p.valid.mean > 0 && p.valid.t >= 1
    // the same professional checks as the fixed labs, with every idea ever bred counted as a try
    const [checked] = assess([{ id: p.id, spec: p.spec, ev, evAll, pass: p.passed, train: p.train }], data, { cost: S.refCost, trials: allTrials(state, state.trialsEff), family: () => p.id, portfolio: { maxOpen: S.maxOpen, slot: Math.min(S.maxPosition, S.maxInvested / S.maxOpen) }, exam: { state, now } })
    p.rigor = checked.rigor; p.basicPassed = p.passed; p.passed = checked.pass
    ex.log.push({ t: now, id: p.id, text: p.text, trainT: p.train.t, valid: p.valid, passed: p.passed, rigor: p.rigor })
    if (p.passed && !ex.graduates.some(g => g.id === p.id)) ex.graduates.push({ id: p.id, spec: p.spec, text: p.text, train: p.train, valid: p.valid, all: p.all, rigor: p.rigor, gen: p.gen, at: now })
  }
  ex.log = ex.log.slice(-60)
  // one entry per idea (the same idea could graduate twice from separate population slots)
  ex.graduates = ex.graduates.filter((g, i, a) => a.findIndex(x => x.id === g.id) === i)
  if (S.asset) for (const g of ex.graduates) { g.spec = { ...g.spec, asset: S.asset }; g.text = describeCombo(g.spec) }
  ex.graduates.sort((a, b) => b.train.t - a.train.t)
  ex.graduates = ex.graduates.slice(0, S.graduates)
  ex.lastRun = { at: now, added, bar }

  // graduates checked under older checks (or none) must pass the current ones, or they leave
  ex.graduates = ex.graduates.filter(g => {
    if (g.rigor?.v === RIGOR_V) return true
    const evAll = events(g.spec, data), ev = preSeal(evAll)
    const [c] = assess([{ id: g.id, spec: g.spec, ev, evAll, pass: true, train: g.train }], data, { cost: S.refCost, trials: allTrials(state, state.trialsEff), family: () => g.id, portfolio: { maxOpen: S.maxOpen, slot: Math.min(S.maxPosition, S.maxInvested / S.maxOpen) }, exam: { state, now } })
    g.rigor = c.rigor
    if (!c.pass) ex.log.push({ t: now, id: g.id, text: g.text, trainT: g.train.t, valid: g.valid, passed: false, rigor: c.rigor, note: 'removed: failed the updated professional checks (real daily ups and downs, beating random by more than costs, beating the index)' })
    return c.pass
  })
  // refresh graduates' full-period stats (the cost gate uses them) and hand them to the coach
  return ex.graduates.map(g => {
    const all = stats(events(g.spec, data))
    g.all = all
    return { id: g.id, spec: g.spec, text: g.text, H: g.spec.H, train: g.train, valid: g.valid, all, rigor: g.rigor, pass: true }
  })
}
