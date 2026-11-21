// Admin controls for the Automation panel: status, kill switch, guardrail settings, and confirming
// or dismissing Superhero share orders. Requires a signed-in site account whose email is listed in
// the ADMIN_EMAILS environment variable (comma-separated). If ADMIN_EMAILS isn't set, everything is
// refused. Live mode can't be switched on from here: only EXECUTION_MODE in Vercel does that.
import { SUPABASE_KEY, SUPABASE_URL } from './_lib/forecaster.js'
import { adapters } from './_lib/exec/adapter.js'
import { paperWallet, spent24h } from './_lib/exec/engine.js'
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
