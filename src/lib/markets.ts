// Market data for the Markets page: every actively trading Binance USDT spot pair,
// ranked by performance. Uses Binance's public market-data host (no key, CORS-enabled).
const API = 'https://data-api.binance.vision/api/v3'

export type Period = '24h' | '7d' | '30d' | '90d' | '1y'
export const PERIODS: { id: Period; label: string; days: number }[] = [
  { id: '24h', label: '24h', days: 1 }, { id: '7d', label: '7 days', days: 7 }, { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 }, { id: '1y', label: '1 year', days: 365 },
]

export interface Coin {
  symbol: string          // e.g. BTCUSDT
  base: string            // e.g. BTC
  price: number
  quoteVolume: number     // 24h volume in USDT
  trades24h: number
  ret: Partial<Record<Period, number | null>> // fractional return, null = not enough history
  vol30?: number | null   // annualised volatility from last 30 daily returns
  trend?: 'up' | 'down' | 'mixed' | null
  fromATH?: number | null // % below the 1-year high
  historyDays?: number
}

const STABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDS', 'USDE', 'USD1', 'XUSD', 'RLUSD', 'EUR', 'EURI', 'AEUR', 'GBP', 'PYUSD', 'USTC', 'UST', 'SUSD', 'BFUSD', 'USDT'])
const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/

interface Ticker { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string; count: number; closeTime: number }

export async function loadTickers(): Promise<Coin[]> {
  const res = await fetch(`${API}/ticker/24hr`)
  if (!res.ok) throw new Error(`Couldn't load market list (${res.status}).`)
  const rows: Ticker[] = await res.json()
  const now = Date.now()
  return rows
    .filter(r => r.symbol.endsWith('USDT'))
    .map(r => ({ r, base: r.symbol.slice(0, -4) }))
    .filter(({ r, base }) => !STABLES.has(base) && !LEVERAGED.test(base) && r.count > 0 && now - r.closeTime < 2 * 86_400_000 && +r.lastPrice > 0)
    .map(({ r, base }) => ({
      symbol: r.symbol, base, price: +r.lastPrice, quoteVolume: +r.quoteVolume, trades24h: r.count,
      ret: { '24h': +r.priceChangePercent / 100 },
    }))
}

/** Daily closes for the last ~400 days. */
async function dailyCloses(symbol: string): Promise<number[]> {
  const res = await fetch(`${API}/klines?symbol=${symbol}&interval=1d&limit=400`)
  if (!res.ok) throw new Error(String(res.status))
  const rows: (string | number)[][] = await res.json()
  return rows.map(r => +r[4])
}

const sma = (x: number[], n: number) => (x.length >= n ? x.slice(-n).reduce((a, b) => a + b, 0) / n : NaN)

export function enrich(c: Coin, closes: number[]): Coin {
  // the last daily candle is still forming; use the live price as "now"
  const now = c.price
  const past = (days: number) => (closes.length > days ? closes[closes.length - 1 - days] : null)
  const ret = { ...c.ret }
  for (const p of PERIODS) if (p.id !== '24h') { const v = past(p.days); ret[p.id] = v ? now / v - 1 : null }
  const done = closes.slice(0, -1)
  const r30 = done.slice(-31).map((x, i, a) => (i ? x / a[i - 1] - 1 : NaN)).slice(1)
  let vol30: number | null = null
  if (r30.length >= 20) {
    const m = r30.reduce((a, b) => a + b, 0) / r30.length
    vol30 = Math.sqrt(r30.reduce((a, b) => a + (b - m) ** 2, 0) / (r30.length - 1)) * Math.sqrt(365)
  }
  const s50 = sma(done, 50), s200 = sma(done, 200)
  const trend = Number.isNaN(s200) ? (Number.isNaN(s50) ? null : now > s50 ? 'up' : 'down')
    : now > s50 && s50 > s200 ? 'up' : now < s50 && s50 < s200 ? 'down' : 'mixed'
  const hi = Math.max(...closes.slice(-365), now)
  return { ...c, ret, vol30, trend, fromATH: now / hi - 1, historyDays: closes.length }
}

/** Loads daily history for many coins with limited concurrency, reporting progress. */
export async function loadHistory(coins: Coin[], onEach: (c: Coin, done: number) => void, signal?: { cancelled: boolean }) {
  let i = 0, done = 0
  const worker = async () => {
    while (i < coins.length && !signal?.cancelled) {
      const c = coins[i++]
      try { onEach(enrich(c, await dailyCloses(c.symbol)), ++done) }
      catch { onEach(c, ++done) }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
}

/** Price path for the comparison chart, sized to the chosen period. */
const CHART: Record<Period, { interval: string; limit: number }> = {
  '24h': { interval: '15m', limit: 97 }, '7d': { interval: '1h', limit: 169 }, '30d': { interval: '4h', limit: 181 },
  '90d': { interval: '1d', limit: 91 }, '1y': { interval: '1d', limit: 366 },
}
const chartCache = new Map<string, { t: number[]; c: number[] }>()
export async function pricePath(symbol: string, period: Period) {
  const key = symbol + period
  if (chartCache.has(key)) return chartCache.get(key)!
  const { interval, limit } = CHART[period]
  const res = await fetch(`${API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`)
  if (!res.ok) throw new Error(`Couldn't load ${symbol} prices (${res.status}).`)
  const rows: (string | number)[][] = await res.json()
  const out = { t: rows.map(r => +r[0]), c: rows.map(r => +r[4]) }
  chartCache.set(key, out)
  return out
}

export const fmtPrice = (p: number) =>
  p >= 1000 ? p.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : p >= 1 ? p.toLocaleString(undefined, { maximumFractionDigits: 3 })
      : p.toPrecision(3)

export const fmtVol = (v: number, sym = '$') =>
  v >= 1e9 ? `${sym}${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${sym}${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${sym}${(v / 1e3).toFixed(0)}K` : `${sym}${v.toFixed(0)}`
