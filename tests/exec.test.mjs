// Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { validateOrder, idemKey } from '../api/_lib/exec/risk.js'
import { CoinSpotAdapter, ALLOWED, sign, nextNonce } from '../api/_lib/exec/coinspot.js'
import { executionMode } from '../api/_lib/exec/adapter.js'
import { runExecution, spent24h } from '../api/_lib/exec/engine.js'

const NOW = Date.UTC(2026, 10, 21, 6)
const S = { kill_switch: false, max_order_aud: 25, max_daily_spend_aud: 100, min_wallet_buffer_aud: 50, max_slippage_pct: 1, max_signal_age_min: 90, require_proven: true,
  crypto_source_lab: 'daytrade', crypto_source_account: 'john', share_source_lab: 'stocks', share_order_aud: 500, share_fee_aud: 2 }
const ctx = (over = {}) => ({ mode: 'live', settings: S, now: NOW, spent24h: 0, walletAud: 200, quoteRate: 100, proven: true, ...over })
const buy = (over = {}) => ({ side: 'BUY', aud: 25, signalPrice: 100, signalAt: NOW - 60_000, ...over })

// ---------- risk validator
test('passes a normal order', () => assert.equal(validateOrder(buy(), ctx()).ok, true))
test('kill switch blocks everything, buys and sells', () => {
  const c = ctx({ settings: { ...S, kill_switch: true } })
  assert.equal(validateOrder(buy(), c).rule, 'kill_switch')
  assert.equal(validateOrder({ side: 'SELL', aud: 10 }, c).rule, 'kill_switch')
})
test('per-order cap', () => assert.equal(validateOrder(buy({ aud: 25.01 }), ctx()).rule, 'max_order'))
test('order exactly at the cap is allowed', () => assert.equal(validateOrder(buy({ aud: 25 }), ctx()).ok, true))
test('rolling 24h spend cap', () => {
  assert.equal(validateOrder(buy(), ctx({ spent24h: 80 })).rule, 'daily_cap')
  assert.equal(validateOrder(buy(), ctx({ spent24h: 75 })).ok, true)
})
test('wallet buffer is never touched', () => {
  assert.equal(validateOrder(buy(), ctx({ walletAud: 74 })).rule, 'buffer')
  assert.equal(validateOrder(buy(), ctx({ walletAud: 75 })).ok, true)
  assert.equal(validateOrder(buy(), ctx({ walletAud: undefined })).rule, 'balance')
})
test('slippage beyond the limit is rejected, either direction', () => {
  assert.equal(validateOrder(buy(), ctx({ quoteRate: 101.5 })).rule, 'slippage')
  assert.equal(validateOrder(buy(), ctx({ quoteRate: 98.5 })).rule, 'slippage')
  assert.equal(validateOrder(buy(), ctx({ quoteRate: 100.9 })).ok, true)
  assert.equal(validateOrder(buy(), ctx({ quoteRate: undefined })).rule, 'quote')
})
test('duplicate signal is suppressed', () => assert.equal(validateOrder(buy(), ctx({ duplicate: true })).rule, 'duplicate'))
test('stale signal is rejected', () => assert.equal(validateOrder(buy({ signalAt: NOW - 91 * 60_000 }), ctx()).rule, 'stale'))
test('live mode refuses unproven rules; paper mode allows them', () => {
  assert.equal(validateOrder(buy(), ctx({ proven: false })).rule, 'unproven')
  assert.equal(validateOrder(buy(), ctx({ proven: false, mode: 'paper' })).ok, true)
})
test('unknown mode is refused', () => assert.equal(validateOrder(buy(), ctx({ mode: 'yolo' })).rule, 'mode'))
test('mode can only be live when the environment says exactly "live"', () => {
  assert.equal(executionMode({}), 'paper'); assert.equal(executionMode({ EXECUTION_MODE: 'LIVE' }), 'paper'); assert.equal(executionMode({ EXECUTION_MODE: 'live' }), 'live')
})

// ---------- CoinSpot adapter
test('withdrawal and send endpoints are blocked before any request', async () => {
  let called = false
  const a = new CoinSpotAdapter({ mode: 'live', key: 'k', secret: 's', fetch: async () => { called = true } })
  for (const p of ['/api/v2/my/coin/withdraw/send', '/api/v2/my/coin/withdraw/senddetails', '/api/v2/my/coin/withdraw/send/async', '/api/v2/my/coin/deposit', '/api/v2/my/swap/now'])
    await assert.rejects(() => a.post(p), /blocked/)
  assert.equal(called, false)
  for (const p of ALLOWED) assert.ok(!/withdraw|send|deposit|swap/i.test(p))
})
test('signature is HMAC-SHA512 of the exact body; nonce strictly increases', async () => {
  const body = '{"nonce":1}'
  assert.equal(sign(body, 'secret'), createHmac('sha512', 'secret').update(body).digest('hex'))
  const a = nextNonce(1000), b = nextNonce(1000), c = nextNonce(999)
  assert.ok(b > a && c > b)
  let seen
  const ad = new CoinSpotAdapter({ mode: 'live', key: 'KEY', secret: 'SEC', fetch: async (url, init) => { seen = { url, init }; return { status: 200, text: async () => '{"status":"ok","balances":[{"AUD":{"balance":120}},{"BTC":{"balance":0.01}}]}' } } })
  const w = await ad.getWalletBalance()
  assert.equal(w.aud, 120); assert.equal(w.coins.BTC, 0.01)
  assert.equal(seen.init.headers.key, 'KEY')
  assert.equal(seen.init.headers.sign, createHmac('sha512', 'SEC').update(seen.init.body).digest('hex'))
  assert.ok(JSON.parse(seen.init.body).nonce > 0)
})
test('paper mode never calls private endpoints', async () => {
  const urls = []
  const a = new CoinSpotAdapter({ mode: 'paper', fetch: async url => { urls.push(url); return { json: async () => ({ prices: { bid: 99, ask: 101, last: 100 } }) } } })
  const q = await a.getQuote('BTC', 'BUY', 25)
  const f = await a.placeOrder({ coin: 'BTC', side: 'BUY', aud: 25, rate: q.rate })
  assert.equal(q.rate, 101); assert.equal(f.status, 'paper_filled')
  assert.ok(urls.every(u => u.includes('/pubapi/')))
})
test('paper quote falls back to the reference price when CoinSpot\'s feed lacks the coin', async () => {
  const a = new CoinSpotAdapter({ mode: 'paper', fetch: async () => ({ json: async () => ({ status: 'error', prices: {} }) }) })
  const q = await a.getQuote('HYPE', 'BUY', 25, 100)
  assert.equal(q.source, 'estimated'); assert.equal(q.rate, 100.5)
  assert.equal((await a.getQuote('HYPE', 'SELL', 25, 100)).rate, 99.5)
  await assert.rejects(() => a.getQuote('HYPE', 'BUY', 25), /no CoinSpot price/)
})
test('exchange error status is surfaced, not treated as a fill', async () => {
  const a = new CoinSpotAdapter({ mode: 'live', key: 'k', secret: 's', fetch: async () => ({ status: 200, text: async () => '{"status":"error","message":"Insufficient funds"}' }) })
  await assert.rejects(() => a.placeOrder({ coin: 'BTC', side: 'BUY', aud: 25, rate: 100, thresholdPct: 1 }), /Insufficient funds/)
})

// ---------- engine: end-to-end with fakes
function fakeStore(orders = []) {
  const rows = new Map(orders.map(o => [o.idem_key, o]))
  return { orders, rows, put: async (row, upd) => { if (rows.has(row.idem_key)) { if (!upd) return 'duplicate'; Object.assign(rows.get(row.idem_key), row); return 'updated' } rows.set(row.idem_key, { created_at: new Date(NOW).toISOString(), ...row }); return 'inserted' } }
}
function fakeCrypto() {
  const calls = []
  return { calls, getWalletBalance: async () => ({ aud: 500, coins: { SOL: 1 } }), getQuote: async () => ({ rate: 150 }),
    placeOrder: async o => { calls.push(o); return { status: 'filled', filledRate: 150, filledAmount: o.side === 'BUY' ? o.aud / 150 : o.amount, feeAud: 0.03, raw: {} } } }
}
const lab = (positions, closed = []) => ({ audPerUsd: 1.5, rules: [{ v: 6, id: 'rev', practice: false, rigor: { passedAll: true } }], accounts: { john: { positions, closed } } })
const pos = { base: 'SOL', t: NOW - 30 * 60_000, entryPx: 100, v: 6 }

test('engine buys once per signal; a second run is suppressed', async () => {
  const store = fakeStore(), crypto = fakeCrypto()
  const deps = { mode: 'live', settings: S, store, crypto, shares: null, cryptoLab: lab([pos]), now: NOW }
  await runExecution(deps)
  await runExecution(deps)
  assert.equal(crypto.calls.length, 1)
  const row = store.rows.get(idemKey({ lab: 'daytrade', account: 'john', base: 'SOL', openedAt: pos.t, side: 'BUY' }))
  assert.equal(row.status, 'filled'); assert.equal(row.requested_aud, 25)
})
test('engine logs a guardrail rejection and never calls the exchange', async () => {
  const store = fakeStore(), crypto = fakeCrypto()
  await runExecution({ mode: 'live', settings: { ...S, kill_switch: true }, store, crypto, cryptoLab: lab([pos]), now: NOW })
  assert.equal(crypto.calls.length, 0)
  const row = [...store.rows.values()][0]
  assert.equal(row.status, 'rejected'); assert.match(row.reason, /kill switch/)
})
test('engine sells exactly what it bought when the lab closes the position', async () => {
  const store = fakeStore(), crypto = fakeCrypto()
  await runExecution({ mode: 'live', settings: S, store, crypto, cryptoLab: lab([pos]), now: NOW })
  store.orders.splice(0, store.orders.length, ...store.rows.values())
  await runExecution({ mode: 'live', settings: S, store, crypto, cryptoLab: lab([], [{ ...pos, exitPx: 101 }]), now: NOW + 3_600_000 })
  const sell = crypto.calls.find(c => c.side === 'SELL')
  assert.ok(sell); assert.ok(Math.abs(sell.amount - 25 / 150) < 1e-12)
})
test('daily cap counts orders placed earlier in the same run', async () => {
  const store = fakeStore(), crypto = fakeCrypto()
  const many = ['A', 'B', 'C', 'D', 'E'].map((b, i) => ({ ...pos, base: b, t: pos.t + i }))
  await runExecution({ mode: 'live', settings: S, store, crypto, cryptoLab: lab(many), now: NOW })
  assert.equal(crypto.calls.length, 4)                       // 4 × A$25 = A$100 cap
  assert.equal([...store.rows.values()].filter(r => r.status === 'rejected' && /cap/.test(r.reason)).length, 1)
  assert.equal(spent24h(store.orders, 'live', NOW), 100)
})
