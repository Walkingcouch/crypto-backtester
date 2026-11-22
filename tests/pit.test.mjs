// Point in time: every decision made "as of" a date must be identical whether the engine is given
// data that ends on that date, or later data cut back to it. If any later bar or trade outcome
// leaks into choosing, checking, ranking or the cost gate, these tests fail.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discover, LAB } from '../src/lib/lab.js'
import { discoverDay, DT } from '../src/lib/daytrade.js'
import { knownAt } from '../src/lib/exam.js'
import { rankFound } from '../src/lib/scorecard.js'

const DAY = 86_400_000, HOUR = 3_600_000
const rng = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647

function coins({ n, start, end, step, seed, prefix = 'C' }) {
  const R = rng(seed), out = []
  for (let k = 0; k < n; k++) {
    const t = [], o = [], h = [], l = [], c = [], v = []
    let p = 10 + R() * 90, drift = (R() - 0.45) * 0.004
    for (let x = start; x < end; x += step) {
      if (R() < 0.01) drift = (R() - 0.45) * 0.004          // regime changes, so trends come and go
      const op = p, vol = 0.01 + 0.04 * R() * (step === DAY ? 1 : 0.25)
      p = Math.max(0.01, p * Math.exp(drift + (R() - 0.5) * 2 * vol))
      t.push(x); o.push(op); c.push(p); h.push(Math.max(op, p) * (1 + R() * vol)); l.push(Math.min(op, p) * (1 - R() * vol)); v.push(1e6 * (1 + R()))
    }
    out.push({ base: k === 0 ? 'BTC' : `${prefix}${k}`, t, o, h, l, c, v })
  }
  return out
}
// strip what differs only by object identity (event lists, internal caches) and compare the decisions
const decisions = found => found.map(f => ({
  id: f.id, pass: f.pass, train: f.train, valid: f.valid, all: f.all,
  checks: f.rigor?.checks, passedAll: f.rigor?.passedAll, sharpe: f.rigor?.sharpe, dsr: f.rigor?.dsr, regime: f.rigor?.regime?.weights,
}))

const AUG1 = Date.UTC(2026, 7, 1), NOV20 = Date.UTC(2026, 10, 20)

test('swing lab: July decisions are identical with data to 31 Jul or data to November cut back', () => {
  const full = { coins: coins({ n: 14, start: Date.UTC(2022, 0, 1), end: NOV20, step: DAY, seed: 11 }) }
  const july = { coins: full.coins.map(c => { const n = c.t.findIndex(t => t >= AUG1); return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, n) : v])) }) }
  const S = { ...LAB, refCost: 0.004 }
  const a = discover(july, S, null, AUG1)
  const b = discover(full, S, null, AUG1)
  assert.ok(a.some(f => f.all.n > 30), 'the synthetic market should produce trades')
  assert.deepEqual(decisions(b), decisions(a))
  assert.deepEqual(rankFound(b).map(r => [r.id, r.rank, r.score]), rankFound(a).map(r => [r.id, r.rank, r.score]))
  // and the cut really matters: with November data and no cut, results differ
  const c = discover(full, S, null, NOV20)
  assert.notDeepEqual(decisions(c).map(d => d.all), decisions(a).map(d => d.all))
})

test('day lab: decisions at a cut-off hour are identical with or without later hours', () => {
  const cutAt = Date.UTC(2026, 7, 1)
  const full = { coins: coins({ n: 5, start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 8, 15), step: HOUR, seed: 5 }) }
  const cutData = knownAt(full, cutAt)
  const S = { ...DT, refCost: 0.003, validDays: 30, minTrain: 20, minValid: 5 }
  const a = discoverDay(cutData, S, null, cutAt)
  const b = discoverDay(full, S, null, cutAt)
  assert.ok(a.some(f => f.all.n > 20))
  assert.deepEqual(decisions(b), decisions(a))
})

test('knownAt drops later bars and every cached feature', () => {
  const [c] = coins({ n: 1, start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 1, 1), step: DAY, seed: 3 })
  c.F = { stale: true }; c.tIdx = new Map()
  const cut = knownAt({ coins: [c], xs: new Map() }, Date.UTC(2026, 0, 11))
  assert.equal(cut.coins[0].t.length, 10)
  assert.equal(cut.coins[0].F, undefined); assert.equal(cut.coins[0].tIdx, undefined); assert.equal(cut.xs, undefined)
  assert.equal(c.t.length, 31)                                  // the original is untouched
  const same = { coins: [c] }
  assert.equal(knownAt(same, Date.UTC(2027, 0, 1)), same)       // nothing later: no copy
})
