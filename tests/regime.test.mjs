import { test } from 'node:test'
import assert from 'node:assert/strict'
import { regimeProfile, regimeAt, regimeWeight, W_MIN, W_MAX } from '../src/lib/regime.js'
import { dailySeries } from '../src/lib/rigor.js'

const DAY = 86_400_000, T0 = Date.UTC(2020, 0, 1)
// a Bitcoin that rises for 400 days, falls for 400, rises for 400
function btc() {
  const t = [], o = [], h = [], l = [], c = []
  let p = 100, s = 3
  const R = () => (s = (s * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 1200; i++) {
    const drift = Math.floor(i / 400) === 1 ? -0.004 : 0.004
    const op = p; p *= Math.exp(drift + (R() - 0.5) * 0.02)
    t.push(T0 + i * DAY); o.push(op); c.push(p); h.push(Math.max(op, p)); l.push(Math.min(op, p))
  }
  return { base: 'BTC', t, o, h, l, c }
}
const data = { coins: [btc()] }

test('market type is read from closed days only, and changes with the trend', () => {
  assert.equal(regimeAt(data, '', T0 + 350 * DAY).trend, 'up')
  assert.equal(regimeAt(data, '', T0 + 790 * DAY).trend, 'down')
  assert.equal(regimeAt(data, '', T0 + 10 * DAY), null)          // not enough history yet
})

test('a rule that only works in downtrends is confirmed as such, and sized up / down, never switched off', () => {
  let s = 9; const R = () => (s = (s * 16807) % 2147483647) / 2147483647
  const ev = []
  for (let d = 240; d < 1190; d++) for (let k = 0; k < 2; k++) {
    const down = regimeAt(data, '', T0 + d * DAY)?.trend === 'down'
    ev.push({ t: T0 + d * DAY, exitT: T0 + (d + 3) * DAY, m: '', base: 'BTC', g: (down ? 0.02 : -0.005) + (R() - 0.5) * 0.02 })
  }
  const p = regimeProfile(ev, data, e => e.g)
  assert.equal(p.verdicts.trend.down, 'suits')
  assert.equal(p.verdicts.trend.up, 'struggles')
  assert.ok(p.weights.trend.down > 1 && p.weights.trend.down <= W_MAX)
  assert.ok(p.weights.trend.up < 1 && p.weights.trend.up >= W_MIN)
  assert.ok(regimeWeight(p, { trend: 'up', vol: 'normal' }) >= W_MIN)
})

test('no real difference → no confirmed verdict, normal size', () => {
  let s = 5; const R = () => (s = (s * 16807) % 2147483647) / 2147483647
  const ev = []
  for (let d = 240; d < 1190; d++) ev.push({ t: T0 + d * DAY, exitT: T0 + (d + 3) * DAY, m: '', base: 'BTC', g: 0.003 + (R() - 0.5) * 0.04 })
  const p = regimeProfile(ev, data, e => e.g)
  for (const k of ['up', 'mixed', 'down']) assert.ok(!['suits', 'struggles'].includes(p.verdicts.trend[k]))
  assert.equal(regimeWeight(p, { trend: 'down', vol: 'wild' }), 1)
})

test('daily series marks trades to real closes (ups and downs inside a trade are no longer hidden)', () => {
  const c = data.coins[0]
  const net = [{ t: c.t[300], exitT: c.t[320], base: 'BTC', r: c.c[320] / c.o[301] - 1 }]
  const mtm = dailySeries(net, data), flat = dailySeries(net)
  const sd = x => { const m = x.reduce((a, b) => a + b, 0) / x.length; return Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / x.length) }
  assert.ok(sd(mtm) > 3 * sd(flat))
  const tot = x => x.reduce((a, r) => a + Math.log(1 + r), 0)
  assert.ok(Math.abs(tot(mtm) - tot(flat)) < 1e-9)              // same total result either way
})
