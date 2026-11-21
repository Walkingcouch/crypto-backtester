// Superhero adapter: shares are NOT executed automatically. Superhero has no documented public
// retail trading API, so instead of browser automation or storing credentials, each share signal
// becomes a "pending share order" for you to place by hand in the Superhero app, then confirm here.
// Same interface as CoinSpotAdapter, so a real API can replace the queue later without touching the engine.

export class SuperheroAdapter {
  constructor(opts = {}) { this.venue = 'superhero'; this.mode = opts.mode || 'paper'; this.fee = opts.feeAud ?? 2; this.webhook = opts.webhook || null; this.fetch = opts.fetch || globalThis.fetch }

  async getWalletBalance() { return { aud: null, coins: {}, note: 'Superhero balance is not readable: no public API' } }

  /** The signal's own price is the suggested limit price (no live quote without an API). */
  async getQuote(_ticker, _side, _aud, signalPrice) { return { rate: signalPrice, source: 'signal' } }

  /** Queue it: returns pending_manual. Optionally POSTs the payload to a webhook (e.g. a phone notification service). */
  async placeOrder({ ticker, market, side, aud, rate, source }) {
    const payload = { ticker, market, side, suggestedAud: +aud.toFixed(2), limitPrice: +(+rate).toFixed(market === 'ASX' ? 3 : 2), signalSource: source, brokerage: this.fee }
    if (this.webhook) { try { await this.fetch(this.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) } catch { /* notification is best-effort */ } }
    return { status: 'pending_manual', raw: payload }
  }

  async cancelOrder() { return { status: 'dismissed' } }
  async getOrderStatus() { return { status: 'manual' } }
}
