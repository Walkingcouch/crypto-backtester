import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankFound, scoreSnapshots, stepBenchmark, takeSnapshot, SC } from '../src/lib/scorecard.js'

const DAY = 86_400_000, T0 = Date.UTC(2026, 10, 23)
// 40 rules; rule k's later trades earn (40 - k) × 0.1% each, so a good ranking should show
const found = Array.from({ length: 40 }, (_, k) => ({ id: `r${k}`, spec: { q: 40 - k }, text: `rule ${k}`, pass: false, train: { n: 50, t: 4 - k * 0.1 }, rigor: { checks: { a: k < 10 } } }))
const eventsOf = spec => Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * DAY, exitT: T0 + (i + 3) * DAY, g: spec.q * 0.001, sp: 0.05 }))

test('ranking follows passes, then checks, then the older-data t-score; too few trades are left out', () => {
  const r = rankFound([...found, { id: 'thin', train: { n: 3, t: 9 } }])
  assert.equal(r.length, 40); assert.equal(r[0].id, 'r0'); assert.equal(r[39].id, 'r39')
  assert.ok(r.every((x, i) => x.rank === i + 1))
})

test('a snapshot saves three groups once a week, and the samples can be re-drawn exactly', () => {
  const a = {}, b = {}
  const s1 = takeSnapshot(a, rankFound(found), T0, { lab: 'swing', cost: 0.004, horizonDays: 28 })
  takeSnapshot(b, rankFound(found), T0, { lab: 'swing', cost: 0.004, horizonDays: 28 })
  assert.deepEqual(a, b)
  const g = k => s1.rules.filter(r => r.group === k)
  assert.equal(g('top').length, SC.groupSize); assert.equal(g('near').length, SC.groupSize); assert.equal(g('random').length, SC.groupSize)
  assert.ok(g('near').every(r => r.rank > 5 && r.rank <= 20)); assert.ok(g('random').every(r => r.rank > 20))
  assert.ok(g('top').every(r => r.spec && r.text))                       // frozen definitions kept
  assert.equal(takeSnapshot(a, rankFound(found), T0 + 2 * DAY, { lab: 'swing', cost: 0.004, horizonDays: 28 }), null)   // not again within the week
  assert.equal(a.scorecard.snaps.length, 1)
})

test('scoring follows the frozen rules forward: a good ranking shows up as top > near > random and a positive rank correlation', () => {
  const st = {}
  takeSnapshot(st, rankFound(found), T0, { lab: 'swing', cost: 0.004, horizonDays: 28 })
  const sum = scoreSnapshots(st, eventsOf, T0 + 60 * DAY, { specById: id => found.find(f => f.id === id)?.spec })
  assert.ok(sum.groups.top.r > sum.groups.near.r && sum.groups.near.r > sum.groups.random.r)
  assert.ok(sum.ic > 0.9)
  assert.equal(st.scorecard.snaps[0].final, true)
  // trades that hadn't closed yet are not counted
  const st2 = {}
  takeSnapshot(st2, rankFound(found), T0, { lab: 'swing', cost: 0.004, horizonDays: 28 })
  const early = scoreSnapshots(st2, eventsOf, T0 + 4 * DAY)
  assert.equal(early.groups.top.n, SC.groupSize * 2)                     // only the first two days' trades had closed
  assert.equal(st2.scorecard.snaps[0].final, undefined)
})

test('BTC-and-cash benchmark holds BTC in the same proportion as the account and pays for changes', () => {
  const st = {}
  stepBenchmark(st, { now: 0, btc: 100, accountValue: 1000, exposure: 0.5 })
  const b = stepBenchmark(st, { now: 1, btc: 120, accountValue: 1050, exposure: 0.5 })
  assert.ok(Math.abs(b.value - 1000 * (1 - 0.5 * 0.0015) * 1.1) < 0.01)   // half in BTC: +10%, minus the cost of buying in
  stepBenchmark(st, { now: 2, btc: 60, accountValue: 900, exposure: 0 })
  assert.ok(st.benchmark.maxDD > 0.2); assert.ok(st.benchmark.acctMaxDD > 0.14)
})
