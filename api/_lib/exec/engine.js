// Execution engine: mirrors one paper lab account's trades into real (or simulated) orders.
//
// Crypto (CoinSpot): a new position in the chosen lab account → BUY of a fixed AUD amount (the
// per-order cap); when the lab closes that position → SELL exactly the coins the bot bought for it
// (never anything else in the wallet). Every step is written to the audit table first, keyed by an
// idempotency key, so a retry or a second run can never place the same order twice.
// Shares (Superhero): new positions in the chosen share lab → pending orders for you to place by hand.
import { idemKey, validateOrder } from './risk.js'
import { keyPrefix } from './owners.js'

const DAY = 86_400_000
const LIVE_STATUSES = ['submitted', 'filled', 'paper_filled']

/** Real round trip on CoinSpot instant: 1% in, 1% out, plus the buy–sell gap (the lab's own figure,
 *  or 1% when it had none). Compared with the rule's expected gain before any real buy. */
export const realCost = (p, quote) => p.est == null ? null : 2 * 0.01 + (p.spread >= 0 ? p.spread : 0.01)

export function spent24h(orders, mode, now) {
  return orders.filter(o => o.mode === mode && o.venue === 'coinspot' && o.side === 'BUY' && LIVE_STATUSES.includes(o.status) && now - Date.parse(o.created_at) < DAY)
    .reduce((s, o) => s + (+o.requested_aud || 0), 0)
}

/** Simulated wallet for paper mode: a starting AUD balance, less paper buys, plus paper sells. */
export function paperWallet(orders, startAud) {
  const w = { aud: startAud, coins: {} }
  for (const o of orders) {
    if (o.mode !== 'paper' || o.venue !== 'coinspot' || o.status !== 'paper_filled') continue
    if (o.side === 'BUY') { w.aud -= +o.requested_aud; w.coins[o.asset] = (w.coins[o.asset] || 0) + (+o.filled_amount) }
    else { w.aud += (+o.filled_amount) * (+o.filled_rate) - (+o.fee_aud || 0); w.coins[o.asset] = (w.coins[o.asset] || 0) - (+o.filled_amount) }
  }
  return w
}

/**
 * deps: { mode, settings, store: { orders, put(row, allowUpdate) → 'inserted'|'updated'|'duplicate' },
 *         crypto: adapter, shares: adapter, cryptoLab: lab state, shareLab: lab state, now, paperStartAud,
 *         refPrice: optional base → live USD price, used for paper quotes CoinSpot's public feed lacks }
 */
export async function runExecution(deps) {
  const { mode, settings: S, store, crypto, shares, now = Date.now() } = deps
  // each person's orders are keyed under their own name (John's keep the original, unprefixed keys)
  const owner = deps.owner || 'john', pfx = keyPrefix(owner)
  const K = x => pfx + idemKey(x)
  const orders = store.orders
  const byKey = new Map(orders.map(o => [o.idem_key, o]))
  const log = []
  const save = async (row, update = false) => {
    const res = await store.put(update ? row : { owner, ...row }, update)
    if (res === 'duplicate') return res
    const prev = byKey.get(row.idem_key)
    if (prev) Object.assign(prev, row)            // update in place so totals in this run stay correct
    else { const o = { created_at: new Date(now).toISOString(), ...row }; byKey.set(row.idem_key, o); orders.unshift(o) }
    return res
  }

  // ---------------- crypto via CoinSpot
  const lab = deps.cryptoLab, acctId = S.crypto_source_account, labId = S.crypto_source_lab
  const acct = lab?.accounts?.[acctId]
  if (acct) {
    const rate = lab.audPerUsd || 1.5
    const ruleOf = v => (lab.rules || []).find(r => r.v === v)
    const ref = async base => { try { return deps.refPrice ? +(await deps.refPrice(base)) * rate : null } catch { return null } }
    let wallet = null
    const getWallet = async () => (wallet ||= await crypto.getWalletBalance(mode === 'paper' ? paperWallet(orders, deps.paperStartAud ?? 1000) : undefined))
    // exits first: sell what the bot bought for positions the lab has closed
    const open = new Set(acct.positions.map(p => `${p.base}:${p.t}`))
    for (const buy of orders.filter(o => o.venue === 'coinspot' && o.mode === mode && o.side === 'BUY' && ['filled', 'paper_filled'].includes(o.status) && o.idem_key.startsWith(`${pfx}${labId}:${acctId}:`))) {
      const [, , base, openedAt] = buy.idem_key.split(':')
      if (open.has(`${base}:${openedAt}`)) continue
      const key = K({ lab: labId, account: acctId, base, openedAt, side: 'SELL' })
      const prev = byKey.get(key)
      if (prev && !['rejected', 'failed', 'intent'].includes(prev.status)) continue          // done already
      const closed = (acct.closed || []).find(c => c.base === base && String(c.t) === openedAt)
      const w = await getWallet()
      const amount = Math.min(+buy.filled_amount, mode === 'live' ? (w.coins[base] ?? 0) : +buy.filled_amount)
      const row = { idem_key: key, mode, venue: 'coinspot', source: buy.source, side: 'SELL', asset: base, market: 'CRYPTO', requested_amount: amount, requested_aud: null, signal_price: closed ? +(closed.exitPx * rate).toFixed(6) : null, parent_idem: buy.idem_key, status: 'intent' }
      if (!prev) await save(row); else await save({ ...row, status: 'intent', reason: null }, true)
      let quote = null
      try { quote = await crypto.getQuote(base, 'SELL', amount * (closed?.exitPx || 0) * rate, await ref(base)) } catch (e) { quote = { error: String(e.message || e) } }
      // a sell is never blocked for being "stale" or unproven, and retries every run until it goes through
      const check = validateOrder({ side: 'SELL', aud: Math.max(0.01, amount * (quote.rate || 0)), signalPrice: null }, { mode, settings: S, now, quoteRate: quote.rate })
      if (!check.ok || !(amount > 0) || quote.error) {
        const reason = !check.ok ? check.reason : quote.error || 'no coins left to sell'
        await save({ idem_key: key, status: 'rejected', reason, quote_rate: quote.rate || null }, true); log.push(`SELL ${base} rejected: ${reason}`); continue
      }
      try {
        const f = await crypto.placeOrder({ coin: base, side: 'SELL', amount, rate: quote.rate, thresholdPct: S.max_slippage_pct })
        await save({ idem_key: key, status: f.status, quote_rate: quote.rate, filled_rate: f.filledRate, filled_amount: f.filledAmount, fee_aud: f.feeAud, raw: f.raw, external_id: f.externalId || null }, true)
        log.push(`SELL ${base} ${f.status}`)
        if (w.coins[base] != null) w.coins[base] -= amount
      } catch (e) {
        await save({ idem_key: key, status: 'failed', reason: String(e.message || e), raw: e.raw || null }, true); log.push(`SELL ${base} failed: ${e.message}`)
      }
    }
    // entries: new positions in the lab account
    for (const p of acct.positions) {
      const key = K({ lab: labId, account: acctId, base: p.base, openedAt: p.t, side: 'BUY' })
      if (byKey.has(key)) continue                                        // handled (filled, rejected or in flight)
      const r = ruleOf(p.v)
      const proven = !!(r && !r.practice && r.rigor?.passedAll)
      const audAmt = +S.max_order_aud
      const signalPrice = +(p.entryPx * rate).toFixed(6)
      const row = { idem_key: key, mode, venue: 'coinspot', source: `${labId}/${acctId} v${p.v}${r ? ` ${r.id}` : ''}${proven ? '' : ' (unproven)'}`, side: 'BUY', asset: p.base, market: 'CRYPTO', requested_aud: audAmt, signal_price: signalPrice, status: 'intent',
        stop_usd: p.stop > 0 ? +p.stop : null, exit_by: p.exitT ? new Date(p.exitT).toISOString() : null }   // the watchdog sells at this stop
      if ((await save(row)) === 'duplicate') { log.push(`BUY ${p.base} duplicate suppressed`); continue }
      let quote = {}, w = null
      try { [quote, w] = await Promise.all([crypto.getQuote(p.base, 'BUY', audAmt, await ref(p.base)), getWallet()]) } catch (e) { quote = { error: String(e.message || e) } }
      const check = quote.error ? { ok: false, reason: `quote or balance failed: ${quote.error}` }
        : validateOrder({ side: 'BUY', aud: audAmt, signalPrice, signalAt: p.t, expected: p.est ?? null, cost: realCost(p, quote) }, { mode, settings: S, now, spent24h: spent24h(orders, mode, now), walletAud: w?.aud, quoteRate: quote.rate, proven })
      if (!check.ok) { await save({ idem_key: key, status: 'rejected', reason: check.reason, quote_rate: quote.rate || null }, true); log.push(`BUY ${p.base} rejected: ${check.reason}`); continue }
      try {
        const f = await crypto.placeOrder({ coin: p.base, side: 'BUY', aud: audAmt, rate: quote.rate, thresholdPct: S.max_slippage_pct })
        await save({ idem_key: key, status: f.status, quote_rate: quote.rate, filled_rate: f.filledRate, filled_amount: f.filledAmount, fee_aud: f.feeAud, raw: f.raw, external_id: f.externalId || null }, true)
        // keep the in-run view current so the next order in this run sees the new totals
        if (w) { w.aud -= audAmt; w.coins[p.base] = (w.coins[p.base] || 0) + (f.filledAmount || 0) }
        log.push(`BUY ${p.base} ${f.status}`)
      } catch (e) {
        await save({ idem_key: key, status: 'failed', reason: String(e.message || e), raw: e.raw || null }, true); log.push(`BUY ${p.base} failed: ${e.message}`)
      }
    }
  }

  // ---------------- shares via the Superhero queue
  const sl = deps.shareLab, sLab = S.share_source_lab
  if (sl?.accounts) {
    for (const [aid, a] of Object.entries(sl.accounts)) {
      const live = new Set(a.positions.map(p => `${p.base}:${p.t}`))
      for (const p of a.positions) {
        const key = K({ lab: sLab, account: aid, base: p.base, openedAt: p.t, side: 'BUY' })
        if (byKey.has(key)) continue
        const r = (sl.rules || []).find(x => x.v === p.v)
        const market = a.market || (p.base.endsWith('.AX') ? 'ASX' : 'US')
        const row = { idem_key: key, mode, venue: 'superhero', source: `${sLab}/${aid} v${p.v}${r ? ` ${r.id}` : ''}${r && !r.practice && r.rigor?.passedAll ? '' : ' (unproven)'}`, side: 'BUY', asset: p.base.replace('.AX', ''), market, requested_aud: +S.share_order_aud, signal_price: p.entryPx, status: 'intent' }
        if ((await save(row)) === 'duplicate') continue
        if (S.kill_switch) { await save({ idem_key: key, status: 'rejected', reason: 'kill switch is on: all orders halted' }, true); continue }
        const f = await shares.placeOrder({ ticker: row.asset, market, side: 'BUY', aud: +S.share_order_aud, rate: p.entryPx, source: row.source })
        await save({ idem_key: key, status: f.status, raw: f.raw }, true); log.push(`share BUY ${row.asset} queued`)
      }
      // exits: queue a sell for shares you confirmed buying; expire buys you never placed
      for (const o of orders.filter(x => x.venue === 'superhero' && x.side === 'BUY' && x.idem_key.startsWith(`${pfx}${sLab}:${aid}:`))) {
        const [, , base, openedAt] = o.idem_key.split(':')
        if (live.has(`${base}:${openedAt}`)) continue
        if (o.status === 'pending_manual') { await save({ idem_key: o.idem_key, status: 'dismissed', reason: 'the lab closed this position before it was placed' }, true); continue }
        if (o.status !== 'executed_manual') continue
        const key = K({ lab: sLab, account: aid, base, openedAt, side: 'SELL' })
        if (byKey.has(key)) continue
        const closed = (a.closed || []).find(c => c.base === base && String(c.t) === openedAt)
        const row = { idem_key: key, mode, venue: 'superhero', source: o.source, side: 'SELL', asset: o.asset, market: o.market, requested_amount: o.filled_amount, signal_price: closed?.exitPx ?? null, parent_idem: o.idem_key, status: 'intent' }
        if ((await save(row)) === 'duplicate') continue
        const f = await shares.placeOrder({ ticker: o.asset, market: o.market, side: 'SELL', aud: (+o.filled_amount || 0) * (closed?.exitPx || 0), rate: closed?.exitPx || 0, source: o.source })
        await save({ idem_key: key, status: f.status, raw: f.raw }, true); log.push(`share SELL ${o.asset} queued`)
      }
    }
  }
  return log
}
