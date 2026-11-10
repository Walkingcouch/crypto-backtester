// Daily job (Vercel Cron, see vercel.json): saves today's forecasts for the main coins to
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
  if (!dry && secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' })

  const started = Date.now()
  let chatter = null
  try { chatter = await collect() } catch { /* forecasts still go ahead */ }
  const fngHist = chatter?.fng?.history || []
  const nowMs = Date.now()

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
      const tone = news.length ? news.slice(0, 30).reduce((s, i) => s + i.tone, 0) / Math.min(30, news.length) : null
      for (const { days } of HORIZONS) {
        const f = forecastAt(P, P.n - 1, days)
        if (!f) continue
        const fm = P.mood ? forecastAt(P, P.n - 1, days, { mood: true }) : null
        const L = f.levels
        rows.push({
          as_of: new Date(t[P.n - 1]).toISOString().slice(0, 10), symbol: base + 'USDT', horizon: days, price: f.price,
          p5: L.p5, p10: L.p10, p25: L.p25, p75: L.p75, p90: L.p90, p95: L.p95, p_up: f.pUp,
          p_up_mood: fm?.usedMood ? fm.pUp : null, fng: fm?.mood ?? null,
          news_24h: recent.length, news_tone: tone,
        })
      }
    } catch (e) { errors.push(`${base}: ${e.message || e}`) }
  }

  let saved = null
  if (!dry && rows.length) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/log_forecasts`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ secret: process.env.FORECAST_SECRET || '', rows }),
    })
    saved = r.ok ? await r.json() : `error ${r.status}: ${(await r.text()).slice(0, 200)}`
  }
  res.status(errors.length && !rows.length ? 500 : 200).json({
    dry, saved, rows: dry ? rows : rows.length, errors, ms: Date.now() - started,
    chatter: chatter ? Object.fromEntries(Object.entries(chatter.sources).map(([k, v]) => [k, v.ok])) : null,
  })
}
