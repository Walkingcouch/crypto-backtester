// Execution job (every 15 minutes, Vercel cron). Mirrors the chosen paper lab's trades into CoinSpot
// orders (simulated in paper mode) and queues share orders for Superhero. Only runs with the cron
// secret: nobody can trigger orders from a browser.
import { adapters } from './_lib/exec/adapter.js'
import { runExecution } from './_lib/exec/engine.js'
import { labState, loadExec, store } from './_lib/exec/store.js'

export default async function handler(req, res) {
  const key = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) return res.status(401).json({ error: 'not allowed' })
  const t0 = Date.now()
  try {
    const { settings, orders } = await loadExec(30)
    const A = adapters(process.env, settings)
    if (A.mode === 'live' && (!process.env.COINSPOT_API_KEY || !process.env.COINSPOT_API_SECRET)) throw new Error('live mode needs COINSPOT_API_KEY and COINSPOT_API_SECRET')
    const [cryptoLab, shareLab] = await Promise.all([labState(settings.crypto_source_lab), labState(settings.share_source_lab)])
    const log = await runExecution({
      mode: A.mode, settings, store: store(orders), crypto: A.crypto, shares: A.shares, cryptoLab, shareLab,
      now: Date.now(), paperStartAud: +(process.env.PAPER_WALLET_AUD || 1000),
    })
    res.setHeader('cache-control', 'no-store')
    res.status(200).json({ mode: A.mode, kill: settings.kill_switch, actions: log, ms: Date.now() - t0 })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
