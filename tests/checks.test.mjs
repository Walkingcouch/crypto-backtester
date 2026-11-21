import { test } from 'node:test'
import assert from 'node:assert/strict'
import { portfolioReplay, allTrials, HUMAN_TRIALS } from '../src/lib/rigor.js'
import { preSeal, sitExam, currentSeal, halfYear } from '../src/lib/exam.js'

const DAY = 86_400_000, T0 = Date.UTC(2024, 0, 1)

test('portfolio replay only takes trades the account has room for', () => {
  // 10 trades all on the same day, each +10%: with 3 slots only 3 are taken
  const ev = Array.from({ length: 10 }, (_, i) => ({ t: T0, exitT: T0 + 5 * DAY, base: 'C' + i, g: 0.1 }))
  const p = portfolioReplay(ev, e => e.g, { maxOpen: 3, slot: 0.25 })
  assert.equal(p.taken, 3); assert.equal(p.available, 10)
  assert.ok(Math.abs(p.total - 0.075) < 1e-9)                 // 3 × 25% × 10%
})
test('portfolio replay: one position per coin, slots free up when trades end', () => {
  const ev = [
    { t: T0, exitT: T0 + 2 * DAY, base: 'A', g: 0.1 }, { t: T0 + DAY, exitT: T0 + 3 * DAY, base: 'A', g: 0.1 },   // same coin while open: skipped
    { t: T0 + 3 * DAY, exitT: T0 + 4 * DAY, base: 'A', g: -0.05 },                                                // after it closed: taken
  ]
  const p = portfolioReplay(ev, e => e.g, { maxOpen: 3, slot: 0.5 })
  assert.equal(p.taken, 2)
})
test('choosing never sees the sealed half-year; the exam is sat once per half-year and kept', () => {
  const now = Date.UTC(2026, 10, 22), seal = currentSeal(now)
  assert.equal(seal.id, '2026H2'); assert.equal(seal.start, Date.UTC(2026, 6, 1))
  const ev = [{ t: seal.start - 10 * DAY, exitT: seal.start - 5 * DAY, g: 0.01 }, { t: seal.start - DAY, exitT: seal.start + DAY, g: 0.5 }, ...Array.from({ length: 12 }, (_, i) => ({ t: seal.start + i * DAY, exitT: seal.start + (i + 2) * DAY, g: 0.02 }))]
  assert.equal(preSeal(ev, seal).length, 1)                    // a trade still open at the seal is excluded too
  const state = {}
  const a = sitExam(state, 'r1', ev, e => e.g - 0.003, now, seal)
  assert.equal(a.n, 12); assert.equal(a.passed, true)
  const b = sitExam(state, 'r1', ev.map(e => ({ ...e, g: -1 })), e => e.g, now + DAY, seal)   // later data can't change it
  assert.equal(b.at, now); assert.equal(b.passed, true)
})
test('a new half-year unseals the old one; its own exam opens after three months, until then the old result counts', () => {
  const state = { exams: { '2026H2|r1': { n: 20, mean: 0.01, passed: true, at: 1 } } }
  const jan = Date.UTC(2027, 0, 10), s = currentSeal(jan)
  assert.equal(s.id, '2027H1'); assert.equal(s.prev.id, '2026H2')
  const carried = sitExam(state, 'r1', [], e => e.g, jan, s)
  assert.equal(carried.passed, true); assert.equal(carried.carried, true)
  assert.equal(state.exams['2027H1|r1'], undefined)               // not sat early
  const apr = Date.UTC(2027, 3, 15), s2 = currentSeal(apr)
  const fresh = sitExam(state, 'r1', [{ t: Date.UTC(2027, 1, 1), exitT: Date.UTC(2027, 1, 5), g: -0.05 }], e => e.g, apr, s2)
  assert.equal(fresh.half, '2027H1'); assert.equal(fresh.passed, false)
  assert.equal(halfYear(Date.UTC(2027, 6, 1)).id, '2027H2')
})
test('luck is counted across every lab plus the hand-made ideas', () => {
  assert.equal(allTrials({ trialsOthers: 1000 }, 58), 1058 + HUMAN_TRIALS)
})

import { splitSegments } from '../api/_lib/labrun.js'
import { events } from '../src/lib/lab.js'
test('a reused ticker is split at the pause, so the old coin\'s crash and the new coin are separate', () => {
  const t = [], o = [], h = [], l = [], c = [], v = []
  for (let i = 0; i < 40; i++) { const gap = i >= 20 ? 18 : 0; t.push(T0 + (i + gap) * DAY); const p = i < 20 ? 100 * Math.pow(0.7, i) : 5; o.push(p); h.push(p); l.push(p); c.push(p); v.push(1) }
  const [now, old] = splitSegments({ base: 'LUNA', t, o, h, l, c, v })
  assert.equal(now.base, 'LUNA'); assert.equal(now.t.length, 20)
  assert.equal(old.base, 'LUNA~1'); assert.equal(old.t.length, 20)
})
test('a coin is only tested on days it was in the top list', () => {
  const n = 600, t = [], o = [], h = [], l = [], c = [], v = []
  let p = 100, sd = 3; const R = () => (sd = (sd * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < n; i++) { p *= Math.exp(0.003 + (R() - 0.5) * 0.04); t.push(T0 + i * DAY); o.push(p); h.push(p * 1.01); l.push(p * 0.99); c.push(p); v.push(1) }
  const mk = () => ({ base: 'X', t, o, h, l, c, v })
  const r = { kind: 'breakout', n: 20, H: 5, stopM: 2.5 }
  const all = events(r, { coins: [mk()] })
  const cutoff = T0 + 400 * DAY
  const some = events(r, { coins: [mk()], member: (b, tt) => tt >= cutoff })
  const none = events(r, { coins: [mk()], member: () => false })
  assert.ok(all.length > 0); assert.equal(none.length, 0)
  assert.ok(some.length <= all.length && some.every(e => e.t >= cutoff))
})

import { venueCosts, withLiveCost } from '../src/lib/lab.js'
test('rules are chosen at the live exchange\'s real round trip, and each exchange is costed separately', () => {
  const accounts = { john: { id: 'john', exchange: 'CoinSpot', fee: 0.01 }, binance: { id: 'binance', exchange: 'Binance', fee: 0.001 } }
  const market = { coins: [{ base: 'BTC' }, { base: 'ETH' }, { base: 'DODO' }], quotes: { john: { BTC: 0.008, ETH: 0.01, DODO: 0.03 }, binance: { BTC: 0.0001, ETH: 0.0002, DODO: 0.001 } } }
  const v = venueCosts(accounts, market, { slippage: 0.0005 })
  assert.equal(v.john.cost, +(0.02 + 0.01 + 0.001).toFixed(4))          // 1% each way + median gap 1% + slippage
  assert.ok(v.binance.cost < 0.005)
  const state = { accounts }
  const S2 = withLiveCost(state, market, { refCost: 0.003, slippage: 0.0005 })
  assert.equal(S2.refCost, v.binance.cost); assert.equal(state.selectCost.exchange, 'Binance')
})

import { EXITS, ruleId, describe as describeRule } from '../src/lib/lab.js'
// a coin that breaks out, rises 30%, then gives it all back
function runUp() {
  const t = [], o = [], h = [], l = [], c = [], v = []
  let p = 100, s = 5; const R = () => (s = (s * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 260; i++) {
    const drift = i < 230 ? (R() - 0.5) * 0.02 : i < 245 ? 0.02 : -0.03
    const op = p; p *= Math.exp(drift)
    t.push(T0 + i * DAY); o.push(op); c.push(p); h.push(Math.max(op, p) * 1.003); l.push(Math.min(op, p) * 0.997); v.push(1)
  }
  return { base: 'X', t, o, h, l, c, v }
}
test('exit styles: a trailing stop or a target keeps profit that a plain time exit gives back', () => {
  const base = { kind: 'breakout', n: 20, regime: 'any', H: 20 }
  const plain = events(base, { coins: [runUp()] }).find(e => e.t >= T0 + 230 * DAY)
  const trail = events({ ...base, exit: { k: 'trail', m: 3 } }, { coins: [runUp()] }).find(e => e.t >= T0 + 230 * DAY)
  const tp = events({ ...base, exit: { k: 'tp', r: 2 } }, { coins: [runUp()] }).find(e => e.t >= T0 + 230 * DAY)
  assert.ok(plain && trail && tp)
  assert.ok(trail.g > plain.g, `trail ${trail.g} vs plain ${plain.g}`)
  assert.ok(tp.g > 0 && tp.exitT < plain.exitT)
})
test('every exit style is its own rule with its own id and wording', () => {
  const ids = EXITS.map(x => ruleId({ kind: 'breakout', n: 20, regime: 'any', H: 10, exit: x }))
  assert.equal(new Set(ids).size, EXITS.length)
  assert.match(describeRule({ kind: 'breakout', n: 20, regime: 'any', H: 10, exit: { k: 'trail', m: 3 } }), /Trailing stop/)
  assert.match(describeRule({ kind: 'dip', k: 1.5, regime: 'any', H: 5, exit: { k: 'tp', r: 2 } }), /Takes profit at 2×/)
})

import { effectiveCount } from '../src/lib/rigor.js'
test('near-copies count once in the luck check; genuinely different ideas count separately', () => {
  let sd = 9; const R = () => (sd = (sd * 16807) % 2147483647) / 2147483647 - 0.5
  const mk = base => { const x = base.map(v => v + R() * 0.001); x.start = 100; return x }
  const a = Array.from({ length: 200 }, () => R() * 0.02), b = Array.from({ length: 200 }, () => R() * 0.02)
  const copiesOfA = [mk(a), mk(a), mk(a)], copiesOfB = [mk(b), mk(b)]
  assert.equal(effectiveCount([...copiesOfA, ...copiesOfB]), 2)
})
