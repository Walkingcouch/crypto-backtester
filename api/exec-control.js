// Admin controls for the Automation panel: status, kill switch, guardrail settings, and confirming
// or dismissing Superhero share orders. Requires a signed-in site account whose email is listed in
// the ADMIN_EMAILS environment variable (comma-separated). If ADMIN_EMAILS isn't set, everything is
// refused. Live mode can only be switched on in Vercel (EXECUTION_MODE, or EXECUTION_MODE_<NAME>).
// One automation account per person (owners.js): everyone can SEE every account, but every action
// only touches the signed-in person's own account, keys and orders.
import { SUPABASE_KEY, SUPABASE_URL } from './_lib/forecaster.js'
import { adapters } from './_lib/exec/adapter.js'
import { paperWallet, spent24h } from './_lib/exec/engine.js'
import { validateOrder } from './_lib/exec/risk.js'
import { alertHook, labState, loadAll, setSettingsFor, store } from './_lib/exec/store.js'
import { alertsReady, notify } from './_lib/exec/notify.js'
import { envFor, keyPrefix, LEGACY, ownerOf, ownersFrom, settingsFor } from './_lib/exec/owners.js'

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
  const me = ownerOf(who)                       // every action below touches only this person's account
  try {
    const body = req.method === 'POST' ? (typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}')) : {}
    const action = body.action || 'status'
    if (action === 'kill') {
      const settings = await setSettingsFor(me, { kill_switch: !!body.on }, who)
      await notify(me, body.on ? `🟥 Kill switch ON for ${me}'s automation (by ${who}). No orders will be placed.` : `🟩 Kill switch off for ${me}'s automation (by ${who}). Trading resumes.`)
      return res.status(200).json({ settings })
    }
    if (action === 'test_alert') {
      const r = await notify(me, `🔔 Test alert for ${me}: phone alerts from the Backtester are working.`)
      return res.status(200).json(r)
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
      return res.status(200).json({ settings: await setSettingsFor(me, patch, who) })
    }
    const all = await loadAll(body.days || 30)
    if (!all.perUser && me !== LEGACY) return res.status(200).json({ who, me, perUser: false, accounts: [], note: 'Separate automation accounts need migration 0010 in Supabase. Until then only John\'s account exists.' })
    const mine = all.orders.filter(o => (o.owner || LEGACY) === me), mySettings = settingsFor(all.settings, me)
    if (action === 'test_roundtrip') return res.status(200).json(await testRoundTrip(me, mySettings, mine, who))
    if (action === 'buy_anyway') return res.status(200).json(await buyAnyway(me, mySettings, mine, who, body.idem_key))
    if (action === 'mark_executed' || action === 'dismiss') {
      const o = mine.find(x => x.idem_key === body.idem_key)
      if (!o || o.venue !== 'superhero' || o.status !== 'pending_manual') return res.status(400).json({ error: 'not one of your pending share orders' })
      const row = action === 'dismiss'
        ? { idem_key: o.idem_key, status: 'dismissed', reason: `dismissed by ${who}` }
        : (() => {
            const price = +body.fill_price, qty = +body.quantity, fee = body.fee_aud != null ? +body.fee_aud : +mySettings.share_fee_aud
            if (!(price > 0 && qty > 0 && fee >= 0)) throw new Error('fill price and quantity must be above zero')
            return { idem_key: o.idem_key, status: 'executed_manual', filled_rate: price, filled_amount: qty, fee_aud: fee, reason: `confirmed by ${who}` }
          })()
      await store(mine).put(row, true)
      return res.status(200).json({ ok: true })
    }
    // status: every account (read-only for the others), mine first
    const names = [...new Set([me, LEGACY, ...ownersFrom(process.env).map(o => o.owner), ...all.settings.map(x => x.owner || LEGACY)])]
      .filter(o => all.perUser || o === LEGACY)
    const accounts = await Promise.all(names.map(async owner => {
      const env = envFor(process.env, owner), settings = settingsFor(all.settings, owner)
      const orders = all.orders.filter(o => (o.owner || LEGACY) === owner)
      const A = adapters(env, settings)
      const keys = !!(env.COINSPOT_API_KEY && env.COINSPOT_API_SECRET)
      let wallet = null, walletError = null
      try {
        wallet = A.mode === 'live' ? (keys ? await A.crypto.getWalletBalance() : null) : paperWallet(orders, +(env.PAPER_WALLET_AUD || 1000))
      } catch (e) { walletError = String(e.message || e) }
      const spent = spent24h(orders, A.mode, Date.now())
      return {
        owner, mine: owner === me, mode: A.mode, keysSet: keys, settings, wallet, walletError,
        spent24h: +spent.toFixed(2), remaining24h: +Math.max(0, settings.max_daily_spend_aud - spent).toFixed(2),
        orders, webhook: !!env.SHARE_ORDER_WEBHOOK_URL, alerts: alertsReady(process.env, owner),
        envNames: owner === LEGACY ? 'EXECUTION_MODE, COINSPOT_API_KEY, COINSPOT_API_SECRET' : ['EXECUTION_MODE', 'COINSPOT_API_KEY', 'COINSPOT_API_SECRET'].map(n => `${n}_${owner.toUpperCase()}`).join(', '),
      }
    }))
    return res.status(200).json({ who, me, perUser: all.perUser, accounts })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}

// Test order: buy the per-order amount of BTC, then sell exactly what was bought a few seconds later.
// Proves the whole live path (quote, buy, balance, sell) without waiting for a lab signal. Goes
// through the same guardrails (kill switch, per-order and daily caps, reserve, slippage) and is
// written to the same audit log, marked as a manual test.
async function testRoundTrip(owner, S, orders, who) {
  const coin = 'BTC'
  const env = envFor(process.env, owner)
  const A = adapters(env, S)
  const mode = A.mode, crypto = A.crypto, st = store(orders, { alert: await alertHook(owner, orders) }), now = Date.now()
  const key = `${keyPrefix(owner)}test:manual:${coin}:${now}`
  const audAmt = +S.max_order_aud
  const steps = []
  const wallet = async () => mode === 'live' ? crypto.getWalletBalance() : paperWallet(orders, +(env.PAPER_WALLET_AUD || 1000))
  const w0 = await wallet()
  const qb = await crypto.getQuote(coin, 'BUY', audAmt)
  const check = validateOrder({ side: 'BUY', aud: audAmt }, { mode, settings: S, now, spent24h: spent24h(orders, mode, now), walletAud: w0.aud, quoteRate: qb.rate, proven: true })
  const buyRow = { idem_key: `${key}:BUY`, owner, mode, venue: 'coinspot', source: `manual test by ${who}`, side: 'BUY', asset: coin, market: 'CRYPTO', requested_aud: audAmt, signal_price: qb.rate, quote_rate: qb.rate, status: 'intent' }
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
  const sellRow = { idem_key: `${key}:SELL`, owner, mode, venue: 'coinspot', source: `manual test by ${who}`, side: 'SELL', asset: coin, market: 'CRYPTO', requested_amount: amount, parent_idem: buyRow.idem_key, status: 'intent' }
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

// "Buy anyway": the owner overrides a blocked lab signal (e.g. expected gain below cost). Only for a
// crypto BUY that was refused, while the lab still holds that position. Bought at today's quote for the
// per-order amount, still inside the kill switch, per-order and daily caps and the wallet reserve.
// The row keeps the lab's key, so the normal job sells exactly this amount when the lab closes it.
async function buyAnyway(owner, S, orders, who, key) {
  const o = orders.find(x => x.idem_key === key)
  const env = envFor(process.env, owner)
  const A = adapters(env, S)
  if (!o || o.venue !== 'coinspot' || o.side !== 'BUY' || o.status !== 'rejected') return { ok: false, error: 'only a blocked crypto buy can be overridden' }
  if (o.mode !== A.mode) return { ok: false, error: `that signal was handled in ${o.mode} mode; the bot is now in ${A.mode} mode` }
  const [lab, acct, base, openedAt] = key.slice(keyPrefix(owner).length).split(':')
  const L = await labState(lab)
  const pos = L?.accounts?.[acct]?.positions?.find(p => p.base === base && String(p.t) === openedAt)
  if (!pos) return { ok: false, error: `the lab has already sold ${base}, so there's nothing to follow` }
  const now = Date.now(), audAmt = +S.max_order_aud
  const w = A.mode === 'live' ? await A.crypto.getWalletBalance() : paperWallet(orders, +(env.PAPER_WALLET_AUD || 1000))
  const q = await A.crypto.getQuote(base, 'BUY', audAmt)
  const check = validateOrder({ side: 'BUY', aud: audAmt }, { mode: A.mode, settings: S, now, spent24h: spent24h(orders, A.mode, now), walletAud: w.aud, quoteRate: q.rate, proven: true })
  if (!check.ok) return { ok: false, error: check.reason }
  const st = store(orders, { alert: await alertHook(owner, orders) })
  try {
    const f = await A.crypto.placeOrder({ coin: base, side: 'BUY', aud: audAmt, rate: q.rate, thresholdPct: S.max_slippage_pct })
    await st.put({ idem_key: key, status: f.status, requested_aud: audAmt, quote_rate: q.rate, filled_rate: f.filledRate, filled_amount: f.filledAmount, fee_aud: f.feeAud, raw: f.raw, external_id: f.externalId || null, reason: `bought anyway by ${who} (was blocked: ${o.reason})`, stop_usd: pos.stop > 0 ? +pos.stop : null, exit_by: pos.exitT ? new Date(pos.exitT).toISOString() : null }, true)
    return { ok: true, base, amount: f.filledAmount, rate: f.filledRate }
  } catch (e) {
    return { ok: false, error: `CoinSpot refused: ${e.message}` }
  }
}
