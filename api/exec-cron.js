// Execution job (every 5 minutes, Vercel cron). For each person's automation account, mirrors the
// chosen paper lab's trades into CoinSpot orders (simulated in paper mode) and queues share orders
// for Superhero. Each account uses only its own keys, settings and orders. Only runs with the cron
// secret: nobody can trigger orders from a browser.
import { livePrice } from './_lib/forecaster.js'
import { adapters } from './_lib/exec/adapter.js'
import { runExecution } from './_lib/exec/engine.js'
import { envFor, LEGACY, ownersFrom, settingsFor } from './_lib/exec/owners.js'
import { envWithConnections } from './_lib/exec/creds.js'
import { alertHook, labState, loadAll, store } from './_lib/exec/store.js'

export default async function handler(req, res) {
  const key = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) return res.status(401).json({ error: 'not allowed' })
  const t0 = Date.now()
  try {
    const all = await loadAll(30)
    // everyone in ADMIN_EMAILS (John always, as the original account), each with their own settings
    const owners = [...new Set([LEGACY, ...ownersFrom(process.env).map(o => o.owner), ...all.settings.map(s => s.owner || LEGACY)])]
      .filter(o => all.perUser || o === LEGACY)
    const labs = {}
    const lab = id => (labs[id] ||= labState(id))
    const out = {}
    for (const owner of owners) {
      try {
        const env = await envWithConnections(owner)
        const settings = settingsFor(all.settings, owner)
        const A = adapters(env, settings)
        if (A.mode === 'live' && (!env.COINSPOT_API_KEY || !env.COINSPOT_API_SECRET)) throw new Error(`live mode needs ${owner === LEGACY ? 'COINSPOT_API_KEY / COINSPOT_API_SECRET' : `COINSPOT_API_KEY_${owner.toUpperCase()} / COINSPOT_API_SECRET_${owner.toUpperCase()}`}`)
        const orders = all.orders.filter(o => (o.owner || LEGACY) === owner)
        const [cryptoLab, shareLab] = await Promise.all([lab(settings.crypto_source_lab), lab(settings.share_source_lab)])
        const actions = await runExecution({
          owner, mode: A.mode, settings, store: store(orders, { alert: await alertHook(owner, orders) }), crypto: A.crypto, shares: A.shares, cryptoLab, shareLab,
          now: Date.now(), refPrice: base => livePrice(`${base}USDT`), paperStartAud: +(env.PAPER_WALLET_AUD || 1000),
        })
        out[owner] = { mode: A.mode, kill: settings.kill_switch, actions }
      } catch (e) { out[owner] = { error: String(e && e.message || e) } }
    }
    res.setHeader('cache-control', 'no-store')
    res.status(200).json({ owners: out, ms: Date.now() - t0 })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
