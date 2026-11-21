// Admin controls for the Automation panel: status, kill switch, guardrail settings, and confirming
// or dismissing Superhero share orders. Requires a signed-in site account whose email is listed in
// the ADMIN_EMAILS environment variable (comma-separated). If ADMIN_EMAILS isn't set, everything is
// refused. Live mode can't be switched on from here: only EXECUTION_MODE in Vercel does that.
import { SUPABASE_KEY, SUPABASE_URL } from './_lib/forecaster.js'
import { adapters } from './_lib/exec/adapter.js'
import { paperWallet, spent24h } from './_lib/exec/engine.js'
import { validateOrder } from './_lib/exec/risk.js'
import { loadExec, setSettings, store } from './_lib/exec/store.js'

const LIMITS = {       // sanity bounds so a typo can't set a $25,000 order
  max_order_aud: [1, 1000], max_daily_spend_aud: [1, 5000], min_wallet_buffer_aud: [0, 100000],
  max_slippage_pct: [0.1, 5], max_signal_age_min: [5, 1440], share_order_aud: [10, 20000], share_fee_aud: [0, 50],
}
const TEXT = ['crypto_source_lab', 'crypto_source_account', 'share_source_lab']
const LABS = ['main', 'explorer', 'daytrade', 'stocks', 'stocks-explore', 'stocks-day']

async function admin(req) {
  const allow = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (!allow.length) return null
  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (!token) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = await r.json()
  return u?.email && allow.includes(u.email.toLowerCase()) ? u.email : null
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store')
  const who = await admin(req).catch(() => null)
  if (!who) return res.status(403).json({ error: process.env.ADMIN_EMAILS ? 'Sign in with an admin account to use the automation controls.' : 'Automation controls are locked: ADMIN_EMAILS is not set in Vercel.' })
  try {
    const body = req.method === 'POST' ? (typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}')) : {}
    const action = body.action || 'status'
    if (action === 'kill') {
      return res.status(200).json({ settings: await setSettings({ kill_switch: !!body.on }, who) })
    }
    if (action === 'settings') {
      const patch = {}
      for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (body.patch?.[k] != null) {
        const v = +body.patch[k]
        if (!(v >= lo && v <= hi)) return res.status(400).json({ error: `${k} must be between ${lo} and ${hi}` })
        patch[k] = v
      }
      for (const k of TEXT) if (body.patch?.[k] != null) {
        if (k.endsWith('_lab') && !LABS.includes(body.patch[k])) return res.status(400).json({ error: `unknown lab ${body.patch[k]}` })
        patch[k] = String(body.patch[k]).slice(0, 40)
      }
      if (body.patch?.require_proven != null) patch.require_proven = !!body.patch.require_proven
      return res.status(200).json({ settings: await setSettings(patch, who) })
    }
    const { settings, orders } = await loadExec(body.days || 30)
    if (action === 'test_roundtrip') return res.status(200).json(await testRoundTrip(settings, orders, who))
    if (action === 'mark_executed' || action === 'dismiss') {
      const o = orders.find(x => x.idem_key === body.idem_key)
      if (!o || o.venue !== 'superhero' || o.status !== 'pending_manual') return res.status(400).json({ error: 'not a pending share order' })
      const row = action === 'dismiss'
        ? { idem_key: o.idem_key, status: 'dismissed', reason: `dismissed by ${who}` }
        : (() => {
            const price = +body.fill_price, qty = +body.quantity, fee = body.fee_aud != null ? +body.fee_aud : +settings.share_fee_aud
            if (!(price > 0 && qty > 0 && fee >= 0)) throw new Error('fill price and quantity must be above zero')
            return { idem_key: o.idem_key, status: 'executed_manual', filled_rate: price, filled_amount: qty, fee_aud: fee, reason: `confirmed by ${who}` }
          })()
      await store(orders).put(row, true)
      return res.status(200).json({ ok: true })
    }
    // status
    const A = adapters(process.env, settings)
    const keys = !!(process.env.COINSPOT_API_KEY && process.env.COINSPOT_API_SECRET)
    let wallet = null, walletError = null
    try {
      wallet = A.mode === 'live' ? (keys ? await A.crypto.getWalletBalance() : null) : paperWallet(orders, +(process.env.PAPER_WALLET_AUD || 1000))
    } catch (e) { walletError = String(e.message || e) }
    const spent = spent24h(orders, A.mode, Date.now())
    return res.status(200).json({
      who, mode: A.mode, keysSet: keys, settings, wallet, walletError,
      spent24h: +spent.toFixed(2), remaining24h: +Math.max(0, settings.max_daily_spend_aud - spent).toFixed(2),
      orders, webhook: !!process.env.SHARE_ORDER_WEBHOOK_URL,
    })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}

// Test order: buy the per-order amount of BTC, then sell exactly what was bought a few seconds later.
// Proves the whole live path (quote, buy, balance, sell) without waiting for a lab signal. Goes
// through the same guardrails (kill switch, per-order and daily caps, reserve, slippage) and is
// written to the same audit log, marked as a manual test.
async function testRoundTrip(S, orders, who) {
  const coin = 'BTC'
  const A = adapters(process.env, S)
  const mode = A.mode, crypto = A.crypto, st = store(orders), now = Date.now()
  const key = `test:manual:${coin}:${now}`
  const audAmt = +S.max_order_aud
  const steps = []
  const wallet = async () => mode === 'live' ? crypto.getWalletBalance() : paperWallet(orders, +(process.env.PAPER_WALLET_AUD || 1000))
  const w0 = await wallet()
  const qb = await crypto.getQuote(coin, 'BUY', audAmt)
  const check = validateOrder({ side: 'BUY', aud: audAmt }, { mode, settings: S, now, spent24h: spent24h(orders, mode, now), walletAud: w0.aud, quoteRate: qb.rate, proven: true })
  const buyRow = { idem_key: `${key}:BUY`, mode, venue: 'coinspot', source: `manual test by ${who}`, side: 'BUY', asset: coin, market: 'CRYPTO', requested_aud: audAmt, signal_price: qb.rate, quote_rate: qb.rate, status: 'intent' }
  await st.put(buyRow)
  if (!check.ok) { await st.put({ idem_key: buyRow.idem_key, status: 'rejected', reason: check.reason }, true); return { ok: false, mode, steps: [`BUY blocked: ${check.reason}`] } }
  let fb
  try { fb = await crypto.placeOrder({ coin, side: 'BUY', aud: audAmt, rate: qb.rate, thresholdPct: S.max_slippage_pct }) }
  catch (e) { await st.put({ idem_key: buyRow.idem_key, status: 'failed', reason: String(e.message || e), raw: e.raw || null }, true); return { ok: false, mode, steps: [`BUY failed: ${e.message}`] } }
  await st.put({ idem_key: buyRow.idem_key, status: fb.status, filled_rate: fb.filledRate, filled_amount: fb.filledAmount, fee_aud: fb.feeAud, raw: fb.raw, external_id: fb.externalId || null }, true)
  steps.push(`BUY ${coin} ${fb.status}: ${fb.filledAmount} at ${fb.filledRate}`)
  // sell exactly what this test bought: the smaller of what CoinSpot reported and what the wallet gained
  let amount = +fb.filledAmount || 0
  if (mode === 'live') {
    await new Promise(r => setTimeout(r, 3000))
    const w1 = await wallet()
    const gained = (w1.coins[coin] || 0) - (w0.coins[coin] || 0)
    if (gained > 0) amount = amount > 0 ? Math.min(amount, gained) : gained
  }
  const sellRow = { idem_key: `${key}:SELL`, mode, venue: 'coinspot', source: `manual test by ${who}`, side: 'SELL', asset: coin, market: 'CRYPTO', requested_amount: amount, parent_idem: buyRow.idem_key, status: 'intent' }
  await st.put(sellRow)
  if (!(amount > 0)) { await st.put({ idem_key: sellRow.idem_key, status: 'failed', reason: 'could not tell how much BTC was bought; sell it in CoinSpot by hand' }, true); return { ok: false, mode, steps: [...steps, 'SELL skipped: bought amount unknown'] } }
  try {
    const qs = await crypto.getQuote(coin, 'SELL', amount * qb.rate)
    const fs = await crypto.placeOrder({ coin, side: 'SELL', amount, rate: qs.rate, thresholdPct: S.max_slippage_pct })
    await st.put({ idem_key: sellRow.idem_key, status: fs.status, quote_rate: qs.rate, signal_price: qs.rate, filled_rate: fs.filledRate, filled_amount: fs.filledAmount, fee_aud: fs.feeAud, raw: fs.raw, external_id: fs.externalId || null }, true)
    steps.push(`SELL ${coin} ${fs.status}: ${amount} at ${fs.filledRate}`)
    const back = fs.totalAud ?? amount * fs.filledRate
    return { ok: true, mode, steps, spent: audAmt, back: +(+back).toFixed(2), cost: +(audAmt - back).toFixed(2) }
  } catch (e) {
    await st.put({ idem_key: sellRow.idem_key, status: 'failed', reason: String(e.message || e), raw: e.raw || null }, true)
    return { ok: false, mode, steps: [...steps, `SELL failed: ${e.message}. The BTC is in your wallet; sell it in CoinSpot or try again.`] }
  }
}
