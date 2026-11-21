// Stop-loss watchdog (every minute, Vercel cron). The labs only look at prices once an hour, so a
// fast fall could run well past a stop before anyone noticed. This checks every REAL CoinSpot coin
// the bot bought and still holds, against the stop-loss recorded when it was bought (in US$, the
// Binance price the labs use), and sells exactly that amount on CoinSpot as soon as the price is at
// or below the stop. One sell per position (same key the normal job would use, so it can't be
// sold twice); a failed sell is retried the next minute; the kill switch stops it like any order.
import { livePrice } from './_lib/forecaster.js'
import { adapters } from './_lib/exec/adapter.js'
import { notify } from './_lib/exec/notify.js'
import { envFor, LEGACY } from './_lib/exec/owners.js'
import { validateOrder } from './_lib/exec/risk.js'
import { openPositions, store } from './_lib/exec/store.js'

const sellKey = buyKey => buyKey.replace(/:BUY$/, ':SELL')

export default async function handler(req, res) {
  const key = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) return res.status(401).json({ error: 'not allowed' })
  res.setHeader('cache-control', 'no-store')
  const t0 = Date.now()
  try {
    const got = await openPositions()
    if (got.error) return res.status(200).json({ skipped: got.error })
    const open = got.open || [], kill = got.kill || {}
    if (!open.length) return res.status(200).json({ open: 0, ms: Date.now() - t0 })
    const prices = {}
    await Promise.all([...new Set(open.map(o => o.asset))].map(async a => { try { prices[a] = await livePrice(`${a}USDT`) } catch { /* no Binance price: skip this minute */ } }))
    const actions = []
    for (const b of open) {
      const p = prices[b.asset], stop = +b.stop_usd
      if (!(p > 0) || !(stop > 0) || p > stop) continue
      const owner = b.owner || LEGACY, tag = `${owner} ${b.asset}`
      // the normal 5-minute job or an earlier minute may already be selling it
      if (b.sell_status === 'intent' && Date.now() - Date.parse(b.sell_updated) < 3 * 60_000) { actions.push(`${tag}: sell already in progress`); continue }
      if (kill[owner]) { actions.push(`${tag}: at its stop, but the kill switch is on`); continue }
      const env = envFor(process.env, owner)
      const A = adapters(env, {})
      if (A.mode !== 'live' || !env.COINSPOT_API_KEY) { actions.push(`${tag}: at its stop, but ${owner}'s account isn't in live mode with keys; sell it in CoinSpot`); continue }
      const st = store([], { alert: async row => { if (row.status === 'filled' || row.status === 'failed') await notify(owner, row.status === 'filled'
        ? `🛑 ${owner.charAt(0).toUpperCase() + owner.slice(1)}: stop-loss hit on ${b.asset} (US$${p} ≤ stop US$${stop}). Sold ${(+row.filled_amount).toPrecision(6)} at A$${(+row.filled_rate).toPrecision(6)} on CoinSpot.`
        : `⚠️ ${owner}: stop-loss hit on ${b.asset} but the CoinSpot sell FAILED (${row.reason}). It will retry every minute; you can also sell it in CoinSpot.`) } })
      const k = sellKey(b.idem_key)
      try {
        const w = await A.crypto.getWalletBalance()
        const amount = Math.min(+b.filled_amount, w.coins[b.asset] ?? 0)
        const base = { idem_key: k, owner, mode: 'live', venue: 'coinspot', source: b.source, side: 'SELL', asset: b.asset, market: 'CRYPTO', requested_amount: amount, signal_price: null, parent_idem: b.idem_key, status: 'intent', reason: `stop-loss watchdog: Binance US$${p} at or below the stop US$${stop}` }
        if ((await st.put(base)) === 'duplicate') await st.put({ ...base }, true)            // retry a failed / blocked sell
        if (!(amount > 0)) { await st.put({ idem_key: k, status: 'failed', reason: `no ${b.asset} left in the wallet to sell` }, true); actions.push(`${tag}: nothing left to sell`); continue }
        const q = await A.crypto.getQuote(b.asset, 'SELL', amount * p)
        const check = validateOrder({ side: 'SELL', aud: Math.max(0.01, amount * (q.rate || 0)) }, { mode: 'live', settings: { kill_switch: !!kill[owner] }, now: Date.now(), quoteRate: q.rate })
        if (!check.ok) { await st.put({ idem_key: k, status: 'rejected', reason: check.reason }, true); actions.push(`${tag}: ${check.reason}`); continue }
        const f = await A.crypto.placeOrder({ coin: b.asset, side: 'SELL', amount, rate: q.rate, thresholdPct: 3 })   // a stop sell accepts up to 3% slippage
        await st.put({ idem_key: k, status: f.status, quote_rate: q.rate, filled_rate: f.filledRate, filled_amount: f.filledAmount, fee_aud: f.feeAud, raw: f.raw, external_id: f.externalId || null }, true)
        actions.push(`${tag}: SOLD at the stop`)
      } catch (e) {
        try { await st.put({ idem_key: k, status: 'failed', reason: String(e.message || e) }, true) } catch { /* */ }
        actions.push(`${tag}: sell failed: ${e.message}`)
      }
    }
    res.status(200).json({ open: open.length, actions, ms: Date.now() - t0 })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
