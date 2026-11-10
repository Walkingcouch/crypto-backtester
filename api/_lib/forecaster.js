// Shared by the 5-hourly job and /api/track: build and save forecast rows for one coin.
import { attachMood, forecastAt, HORIZONS, prepare } from '../../src/lib/forecast.js'
import { mentions } from './chatter.js'

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qjwvgqbicynngklppcjy.supabase.co'
export const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_Oe-8FkDpfZvG294EIFE72A_iSsFOCjx'
export const DAY = 86_400_000
export const HOUR = 3_600_000
export const DEFAULT_COINS = [['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['SOL', 'Solana'], ['XRP', 'XRP'], ['ADA', 'Cardano'],
  ['DOGE', 'Dogecoin'], ['LINK', 'Chainlink'], ['AVAX', 'Avalanche'], ['DOT', 'Polkadot'], ['LTC', 'Litecoin']]

export const sb = (path, init = {}) => fetch(`${SUPABASE_URL}${path}`, {
  ...init, headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json', ...(init.headers || {}) },
})
export const rpc = async (name, body) => {
  const r = await sb(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify({ secret: process.env.FORECAST_SECRET || '', ...body }) })
  return r.ok ? await r.json() : `error ${r.status}: ${(await r.text()).slice(0, 200)}`
}

export async function livePrice(symbol) {
  const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`)
  if (!r.ok) throw new Error(r.status === 400 ? `${symbol} isn't listed on Binance` : `price ${symbol} ${r.status}`)
  const p = +(await r.json()).price
  if (!(p > 0)) throw new Error(`bad price ${symbol}`)
  return p
}

export async function dailyBars(symbol) {
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

/** Coins added by viewing them on the Predict page (plus the defaults). */
export async function trackedCoins() {
  const coins = new Map(DEFAULT_COINS.map(([b, n]) => [b, n]))
  try {
    const r = await sb('/rest/v1/tracked_coins?select=symbol,name&order=added_at&limit=60')
    if (r.ok) for (const t of await r.json()) { const b = t.symbol.replace(/USDT$/, ''); if (!coins.has(b)) coins.set(b, t.name || b) }
  } catch { /* defaults only */ }
  return [...coins]
}

/** Forecast rows for one coin at hour `madeAt`, centred on the live price. */
export async function rowsFor(base, name, chatter, madeAt) {
  const symbol = base + 'USDT'
  const bars = await dailyBars(symbol)
  if (bars.length < 400) throw new Error(`${base} has only ${bars.length} days of history (needs 400)`)
  const t = bars.map(b => b[0]), closes = bars.map(b => b[1])
  const P = prepare(closes)
  const fngHist = chatter?.fng?.history || []
  if (fngHist.length) attachMood(P, t, fngHist)
  const news = (chatter?.news || []).filter(i => mentions(`${i.title} ${i.summary}`, base, name))
  const recent = news.filter(i => i.time && Date.now() - i.time < DAY)
  const tone = news.length ? news.slice(0, 30).reduce((s, i) => s + i.tone, 0) / Math.min(30, news.length) : null
  const live = await livePrice(symbol)
  const rows = []
  for (const { days } of HORIZONS) {
    const f = forecastAt(P, P.n - 1, days)
    if (!f) continue
    const fm = P.mood ? forecastAt(P, P.n - 1, days, { mood: true }) : null
    const L = f.levels, k = live / f.price
    rows.push({
      as_of: new Date(t[P.n - 1]).toISOString().slice(0, 10), symbol, horizon: days, price: live,
      made_at: new Date(madeAt).toISOString(), target_at: new Date(madeAt + days * DAY).toISOString(),
      p5: L.p5 * k, p10: L.p10 * k, p25: L.p25 * k, p75: L.p75 * k, p90: L.p90 * k, p95: L.p95 * k, p_up: f.pUp,
      p_up_mood: fm?.usedMood ? fm.pUp : null, fng: fm?.mood ?? null,
      news_24h: recent.length, news_tone: tone,
    })
  }
  return rows
}
