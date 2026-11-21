// Server-side guardrails, checked before EVERY order. Pure function: no network, easy to test.
// Returns { ok: true } or { ok: false, rule, reason } with a plain-words reason for the audit log.
//
// order:    { side: 'BUY'|'SELL', aud, signalPrice, signalAt }
// ctx:      { mode, settings, spent24h (AUD of buys in the last 24 h, same mode),
//             walletAud (available AUD), quoteRate (AUD per coin from a live quote), now,
//             duplicate (an order with this idempotency key already exists), proven (rule passed every check) }

export const DEFAULTS = {
  kill_switch: false, max_order_aud: 25, max_daily_spend_aud: 100, min_wallet_buffer_aud: 50,
  max_slippage_pct: 1.0, max_signal_age_min: 90, require_proven: true,
}

const aud = x => `A$${(+x).toFixed(2)}`

export function validateOrder(order, ctx) {
  const S = { ...DEFAULTS, ...(ctx.settings || {}) }
  const no = (rule, reason) => ({ ok: false, rule, reason })
  if (ctx.mode !== 'paper' && ctx.mode !== 'live') return no('mode', `unknown execution mode "${ctx.mode}"`)
  if (S.kill_switch) return no('kill_switch', 'kill switch is on: all orders halted')
  if (ctx.duplicate) return no('duplicate', 'this signal was already handled (same idempotency key)')
  if (!(order.aud > 0)) return no('amount', 'order amount must be above zero')
  if (order.side === 'BUY') {
    if (ctx.mode === 'live' && S.require_proven && !ctx.proven) return no('unproven', 'the rule behind this signal has not passed every professional check (live mode only mirrors proven rules)')
    if (order.signalAt && ctx.now - order.signalAt > S.max_signal_age_min * 60_000) return no('stale', `signal is ${Math.round((ctx.now - order.signalAt) / 60_000)} min old (limit ${S.max_signal_age_min} min)`)
    if (order.aud > S.max_order_aud + 1e-9) return no('max_order', `${aud(order.aud)} is above the per-order cap of ${aud(S.max_order_aud)}`)
    if ((ctx.spent24h || 0) + order.aud > S.max_daily_spend_aud + 1e-9) return no('daily_cap', `would take 24-hour spending to ${aud((ctx.spent24h || 0) + order.aud)}, above the cap of ${aud(S.max_daily_spend_aud)}`)
    if (!(ctx.walletAud >= 0)) return no('balance', 'could not read the wallet balance')
    if (ctx.walletAud - order.aud < S.min_wallet_buffer_aud - 1e-9) return no('buffer', `would leave ${aud(ctx.walletAud - order.aud)} in the wallet, below the ${aud(S.min_wallet_buffer_aud)} reserve`)
  }
  if (order.signalPrice > 0) {
    if (!(ctx.quoteRate > 0)) return no('quote', 'no live quote available')
    const dev = (ctx.quoteRate / order.signalPrice - 1) * 100
    // buying higher or selling lower than the signal is the costly direction; allow the same either way
    if (Math.abs(dev) > S.max_slippage_pct + 1e-9) return no('slippage', `live price ${dev > 0 ? '+' : ''}${dev.toFixed(2)}% from the signal price, beyond the ${S.max_slippage_pct}% limit`)
  }
  return { ok: true }
}

/** Idempotency key: one per lab position and side, so retries and replays map to the same row. */
export const idemKey = ({ lab, account, base, openedAt, side }) => `${lab}:${account}:${base}:${openedAt}:${side}`
