// Runs every 5 hours (Supabase pg_cron calls it, see supabase/migrations/0003): saves forecasts
// for the default coins plus every coin someone has opened on the Predict page, and grades
// forecasts whose time has come.
//   GET /api/forecast-cron?dry=1  -> computes the rows without saving (for checking)
import { collect } from './_lib/chatter.js'
import { HOUR, rowsFor, rpc, sb, trackedCoins } from './_lib/forecaster.js'

/** Grade forecasts whose target time has passed, using the price at that exact hour. */
async function gradeDue() {
  const r = await sb(`/rest/v1/forecasts?select=symbol,horizon,made_at,target_at&outcome=is.null&target_at=lte.${new Date().toISOString()}&order=target_at&limit=2000`)
  if (!r.ok) return `read error ${r.status}`
  const due = await r.json()
  if (!due.length) return 0
  const bySym = new Map()
  for (const d of due) { const a = bySym.get(d.symbol) ?? []; a.push(d); bySym.set(d.symbol, a) }
  const graded = []
  for (const [symbol, list] of bySym) {
    const times = list.map(d => Date.parse(d.target_at))
    const opens = new Map()
    for (let from = Math.floor(Math.min(...times) / HOUR) * HOUR, page = 0; from <= Math.max(...times) && page < 10; page++) {
      const k = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${from}&limit=1000`)
      if (!k.ok) break
      const rows = await k.json()
      if (!rows.length) break
      for (const c of rows) opens.set(+c[0], +c[1])
      from = +rows[rows.length - 1][0] + HOUR
    }
    for (const d of list) {
      const p = opens.get(Math.floor(Date.parse(d.target_at) / HOUR) * HOUR)
      if (p > 0) graded.push({ symbol, horizon: d.horizon, made_at: d.made_at, outcome: p })
    }
  }
  return graded.length ? rpc('grade_forecasts', { rows: graded }) : 0
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x')
  const dry = url.searchParams.get('dry') === '1'
  const secret = process.env.CRON_SECRET
  const authed = req.headers.authorization === `Bearer ${secret}` || url.searchParams.get('key') === secret
  if (!dry && secret && !authed) return res.status(401).json({ error: 'unauthorized' })

  const started = Date.now()
  let chatter = null
  try { chatter = await collect() } catch { /* forecasts still go ahead */ }
  const madeAt = Math.floor(Date.now() / HOUR) * HOUR   // one snapshot per hour, so re-runs don't duplicate
  const coins = await trackedCoins()

  const rows = [], errors = []
  for (let i = 0; i < coins.length; i += 4) {            // a few coins at a time
    const batch = await Promise.all(coins.slice(i, i + 4).map(([base, name]) =>
      rowsFor(base, name, chatter, madeAt).catch(e => { errors.push(`${base}: ${e.message || e}`); return [] })))
    rows.push(...batch.flat())
  }

  let saved = null, graded = null
  if (!dry && rows.length) saved = await rpc('log_forecasts', { rows })
  if (!dry) { try { graded = await gradeDue() } catch (e) { graded = `grade failed: ${e.message || e}` } }
  res.status(errors.length && !rows.length ? 500 : 200).json({
    dry, saved, graded, madeAt: new Date(madeAt).toISOString(), coins: coins.map(c => c[0]), rows: dry ? rows : rows.length, errors, ms: Date.now() - started,
    chatter: chatter ? Object.fromEntries(Object.entries(chatter.sources).map(([k, v]) => [k, v.ok])) : null,
  })
}
