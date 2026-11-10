// Runs every 5 hours (Supabase pg_cron calls it, see supabase/migrations/0003): saves forecasts for the main coins to
// Supabase so they can be graded when their date arrives. Also logs news buzz, headline
// tone and Fear & Greed per coin, so chatter can later be tested as a predictor.
//   GET /api/forecast-cron?dry=1  -> computes and returns the rows without saving (for checking)
import { attachMood, forecastAt, HORIZONS, prepare } from '../src/lib/forecast.js'
import { collect, mentions } from './_lib/chatter.js'

const COINS = [['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['SOL', 'Solana'], ['XRP', 'XRP'], ['ADA', 'Cardano'],
  ['DOGE', 'Dogecoin'], ['LINK', 'Chainlink'], ['AVAX', 'Avalanche'], ['DOT', 'Polkadot'], ['LTC', 'Litecoin']]
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qjwvgqbicynngklppcjy.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_Oe-8FkDpfZvG294EIFE72A_iSsFOCjx'
const DAY = 86_400_000
const HOUR = 3_600_000
const sb = (path, init = {}) => fetch(`${SUPABASE_URL}${path}`, {
  ...init, headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json', ...(init.headers || {}) },
})
async function livePrice(symbol) {
  const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`)
  if (!r.ok) throw new Error(`price ${symbol} ${r.status}`)
  const p = +(await r.json()).price
  if (!(p > 0)) throw new Error(`bad price ${symbol}`)
  return p
}

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
    const start = Math.floor(Math.min(...times) / HOUR) * HOUR
    const opens = new Map()
    for (let from = start, page = 0; from <= Math.max(...times) && page < 10; page++) {
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
  if (!graded.length) return 0
  const g = await sb('/rest/v1/rpc/grade_forecasts', { method: 'POST', body: JSON.stringify({ secret: process.env.FORECAST_SECRET || '', rows: graded }) })
  return g.ok ? await g.json() : `grade error ${g.status}: ${(await g.text()).slice(0, 160)}`
}

async function dailyBars(symbol) {
  const out = []
  let start = Date.parse('2019-01-01T00:00:00Z')
  for (let page = 0; page < 6; page++) {
    const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${start}&limit=1000`)
    if (!r.ok) throw new Error(`Binance ${symbol} ${r.status}`)
    const rows = await r.json()
    if (!rows.length) break
    for (const k of rows) out.push([+k[0], +k[4]])
    start = +rows[rows.length - 1][0] + DAY
    if (rows.length < 1000) break
  }
  return out.filter(([t]) => t + DAY <= Date.now()) // completed days only
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
  const fngHist = chatter?.fng?.history || []
  const nowMs = Date.now()
  const madeAt = Math.floor(nowMs / HOUR) * HOUR   // one snapshot per hour, so re-runs don't duplicate

  const rows = [], errors = []
  for (const [base, name] of COINS) {
    try {
      const bars = await dailyBars(base + 'USDT')
      if (bars.length < 400) throw new Error('not enough history')
      const t = bars.map(b => b[0]), closes = bars.map(b => b[1])
      const P = prepare(closes)
      if (fngHist.length) attachMood(P, t, fngHist)
      const news = (chatter?.news || []).filter(i => mentions(`${i.title} ${i.summary}`, base, name))
      const recent = news.filter(i => i.time && nowMs - i.time < DAY)
      const live = await livePrice(base + 'USDT')
      const tone = news.length ? news.slice(0, 30).reduce((s, i) => s + i.tone, 0) / Math.min(30, news.length) : null
      for (const { days } of HORIZONS) {
        const f = forecastAt(P, P.n - 1, days)
        if (!f) continue
        const fm = P.mood ? forecastAt(P, P.n - 1, days, { mood: true }) : null
        const L = f.levels, k = live / f.price      // centre today's ranges on the live price
        rows.push({
          as_of: new Date(t[P.n - 1]).toISOString().slice(0, 10), symbol: base + 'USDT', horizon: days, price: live,
          made_at: new Date(madeAt).toISOString(), target_at: new Date(madeAt + days * DAY).toISOString(),
          p5: L.p5 * k, p10: L.p10 * k, p25: L.p25 * k, p75: L.p75 * k, p90: L.p90 * k, p95: L.p95 * k, p_up: f.pUp,
          p_up_mood: fm?.usedMood ? fm.pUp : null, fng: fm?.mood ?? null,
          news_24h: recent.length, news_tone: tone,
        })
      }
    } catch (e) { errors.push(`${base}: ${e.message || e}`) }
  }

  let saved = null, graded = null
  if (!dry && rows.length) {
    const r = await sb('/rest/v1/rpc/log_forecasts', { method: 'POST', body: JSON.stringify({ secret: process.env.FORECAST_SECRET || '', rows }) })
    saved = r.ok ? await r.json() : `error ${r.status}: ${(await r.text()).slice(0, 200)}`
  }
  if (!dry) { try { graded = await gradeDue() } catch (e) { graded = `grade failed: ${e.message || e}` } }
  res.status(errors.length && !rows.length ? 500 : 200).json({
    dry, saved, graded, madeAt: new Date(madeAt).toISOString(), rows: dry ? rows : rows.length, errors, ms: Date.now() - started,
    chatter: chatter ? Object.fromEntries(Object.entries(chatter.sources).map(([k, v]) => [k, v.ok])) : null,
  })
}
