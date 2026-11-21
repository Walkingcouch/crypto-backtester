// CoinSpot adapter (API v2). Implements the ExecutionAdapter interface (adapter.js).
//
// Safety:
//  - Only the endpoints in ALLOWED can ever be called. Withdrawals, sends, deposits and swaps are
//    not on the list, and any attempt throws before a request is made (unit-tested).
//  - Keys come only from server environment variables; nothing here runs in the browser.
//  - In paper mode no private endpoint is called at all: quotes come from CoinSpot's public prices
//    and fills are simulated at the quoted rate, with CoinSpot's 0.1% market-order fee.
//
// Private requests: POST, JSON body containing a strictly increasing nonce, HMAC-SHA512 of the exact
// body bytes (hex) in the `sign` header, API key in the `key` header.
import { createHmac } from 'node:crypto'

const BASE = 'https://www.coinspot.com.au'
export const ALLOWED = new Set([
  '/api/v2/ro/my/balances',
  '/api/v2/ro/my/orders/market/completed',
  '/api/v2/quote/buy/now',
  '/api/v2/quote/sell/now',
  '/api/v2/my/buy/now',
  '/api/v2/my/sell/now',
  '/api/v2/my/buy/cancel',
  '/api/v2/my/sell/cancel',
])
export const FEE = 0.01    // CoinSpot instant "buy/sell now" fee (1% each way, measured on a live test order)

let lastNonce = 0
export const nextNonce = (now = Date.now()) => (lastNonce = Math.max(now, lastNonce + 1))

export function sign(body, secret) {
  return createHmac('sha512', secret).update(body).digest('hex')
}

export class CoinSpotAdapter {
  /** opts: { mode, key, secret, fetch } */
  constructor(opts = {}) {
    this.mode = opts.mode === 'live' ? 'live' : 'paper'
    this.key = opts.key || ''
    this.secret = opts.secret || ''
    this.fetch = opts.fetch || globalThis.fetch
    this.venue = 'coinspot'
  }

  async post(path, params = {}) {
    if (!ALLOWED.has(path)) throw new Error(`blocked: ${path} is not an allowed CoinSpot endpoint`)
    if (/withdraw|send|deposit|swap/i.test(path)) throw new Error(`blocked: ${path}`)
    if (!this.key || !this.secret) throw new Error('CoinSpot API key and secret are not set')
    const body = JSON.stringify({ nonce: nextNonce(), ...params })
    const r = await this.fetch(BASE + path, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', key: this.key, sign: sign(body, this.secret) },
    })
    const text = await r.text()
    let j; try { j = JSON.parse(text) } catch { throw new Error(`CoinSpot ${r.status}: ${text.slice(0, 200)}`) }
    if (j.status && j.status !== 'ok') { const e = new Error(`CoinSpot: ${j.message || j.status}`); e.raw = j; throw e }
    return j
  }

  async publicPrice(coin) {
    const r = await this.fetch(`${BASE}/pubapi/v2/latest/${encodeURIComponent(coin)}`)
    const j = await r.json()
    const p = j?.prices || {}
    return { bid: +p.bid, ask: +p.ask, last: +p.last }
  }

  /** { aud, coins: { BTC: amount } } available in the wallet. Paper mode: the simulated wallet passed in. */
  async getWalletBalance(paperWallet) {
    if (this.mode === 'paper') return paperWallet || { aud: 0, coins: {} }
    const j = await this.post('/api/v2/ro/my/balances')
    const out = { aud: 0, coins: {} }
    for (const row of j.balances || []) for (const [k, v] of Object.entries(row)) {
      if (k.toUpperCase() === 'AUD') out.aud = +v.balance; else out.coins[k.toUpperCase()] = +v.balance
    }
    return out
  }

  /** AUD per coin to buy or sell `audAmount` worth now. */
  /** refAud: optional AUD reference price (Binance × AUD rate). In paper mode it stands in for coins
   *  CoinSpot sells but leaves out of its public price feed (HYPE, BNB, ZEC…), with the same
   *  1% buy–sell gap the labs assume for those coins. */
  async getQuote(coin, side, audAmount, refAud) {
    if (this.mode === 'paper') {
      let p = {}
      try { p = await this.publicPrice(coin) } catch { /* fall back below */ }
      const rate = side === 'BUY' ? p.ask : p.bid
      if (rate > 0) return { rate, source: 'public' }
      if (refAud > 0) return { rate: +(refAud * (side === 'BUY' ? 1.005 : 0.995)).toPrecision(10), source: 'estimated' }
      throw new Error(`no CoinSpot price for ${coin}`)
    }
    const j = await this.post(side === 'BUY' ? '/api/v2/quote/buy/now' : '/api/v2/quote/sell/now', { cointype: coin, amount: audAmount, amounttype: 'aud' })
    return { rate: +j.rate, source: 'quote', raw: j }
  }

  /**
   * Market order at the quoted rate, cancelled by CoinSpot if the price moves beyond `thresholdPct`.
   * BUY spends `aud`; SELL sells `amount` coins. Returns { status, filledRate, filledAmount, feeAud, raw }.
   */
  async placeOrder({ coin, side, aud, amount, rate, thresholdPct }) {
    if (this.mode === 'paper') {
      const coins = side === 'BUY' ? aud / (rate * (1 + FEE)) : amount
      const value = side === 'BUY' ? aud : amount * rate * (1 - FEE)
      return { status: 'paper_filled', filledRate: rate, filledAmount: coins, feeAud: side === 'BUY' ? aud * FEE : amount * rate * FEE, totalAud: value, raw: { simulated: true } }
    }
    const params = side === 'BUY'
      ? { cointype: coin, amounttype: 'aud', amount: +aud.toFixed(2), rate, threshold: thresholdPct, direction: 'UP' }
      : { cointype: coin, amounttype: 'coin', amount, rate, threshold: thresholdPct, direction: 'DOWN' }
    const j = await this.post(side === 'BUY' ? '/api/v2/my/buy/now' : '/api/v2/my/sell/now', params)
    // CoinSpot reports the coin amount and AUD total; the fee is included in the total
    const filledAmount = +j.amount || (side === 'SELL' ? amount : null)
    const total = +j.total || (side === 'BUY' ? aud : null)
    // the 1% fee is built into the price: a buy gets coins at quote × 1.01, a sell pays quote × 0.99
    const feeAud = !total ? null : side === 'BUY' ? total - total / (1 + FEE) : total * FEE / (1 - FEE)
    return { status: 'filled', filledRate: filledAmount && total ? total / filledAmount : rate, filledAmount, feeAud: feeAud == null ? null : +feeAud.toFixed(4), totalAud: total, raw: j, externalId: j.id || j.orderid || null }
  }

  async cancelOrder(id, side) {
    if (this.mode === 'paper') return { status: 'cancelled' }
    return this.post(side === 'BUY' ? '/api/v2/my/buy/cancel' : '/api/v2/my/sell/cancel', { id })
  }

  async getOrderStatus() {
    if (this.mode === 'paper') return { status: 'paper' }
    return this.post('/api/v2/ro/my/orders/market/completed', { limit: 50 })
  }
}
