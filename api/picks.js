// Recommendations: today's picks from the research-based rules, last week's picks (to show
// changes), and a walk-forward track record of following them at several fee levels.
// Heavy (≈50 coins of daily history), so cached 6 hours at Vercel's edge.
import { backtestPicks, picksAt, SETTINGS } from '../src/lib/picks.js'

const API = 'https://data-api.binance.vision/api/v3'
const DAY = 86_400_000
const STABLES = new Set(['U', 'USDD', 'FRAX', 'USDF', 'USDQ', 'USDG', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDS', 'USDE', 'USD1', 'XUSD', 'RLUSD', 'EUR', 'EURI', 'AEUR', 'GBP', 'PYUSD', 'USTC', 'UST', 'SUSD', 'BFUSD', 'USDT'])
const NOT_COINS = new Set(['WBTC', 'WBETH', 'WETH', 'PAXG', 'XAUT', 'BETH', 'STETH'])   // wrapped coins and gold tokens
const FEES = [0.001, 0.0025, 0.004, 0.005, 0.006, 0.0085, 0.01]

async function getJSON(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0].split('/').pop()}`)
  return r.json()
}

async function history(symbol) {
  const out = []
  let start = Date.parse('2019-01-01T00:00:00Z')
  for (let page = 0; page < 6; page++) {
    const rows = await getJSON(`${API}/klines?symbol=${symbol}&interval=1d&startTime=${start}&limit=1000`)
    if (!rows.length) break
    for (const k of rows) out.push([+k[0], +k[4], +k[7]])
    start = +rows[rows.length - 1][0] + DAY
    if (rows.length < 1000) break
  }
  return out.filter(([t]) => t + DAY <= Date.now())
}

function thin(run, every = 7) {
  const keep = (_, i, a) => i % every === 0 || i === a.length - 1
  return { days: run.days.filter(keep), eq: run.eq.filter(keep).map(x => +x.toFixed(5)), metrics: run.metrics, trades: run.trades, feesPaid: run.feesPaid, avgExposure: run.avgExposure }
}

export default async function handler(req, res) {
  const t0 = Date.now()
  try {
    const tickers = await getJSON(`${API}/ticker/24hr`)
    const cands = tickers
      .filter(t => t.symbol.endsWith('USDT') && +t.lastPrice > 0 && t.count > 0)
      .map(t => ({ base: t.symbol.slice(0, -4), qv: +t.quoteVolume }))
      .filter(t => !STABLES.has(t.base) && !NOT_COINS.has(t.base) && !/(UP|DOWN|BULL|BEAR)$/.test(t.base))
      .sort((a, b) => b.qv - a.qv).slice(0, 50)
    if (!cands.some(c => c.base === 'BTC')) cands.push({ base: 'BTC' })

    const series = []
    for (let i = 0; i < cands.length; i += 8) {
      const batch = await Promise.all(cands.slice(i, i + 8).map(async c => {
        try { return { base: c.base, rows: await history(c.base + 'USDT') } } catch { return null }
      }))
      series.push(...batch.filter(Boolean))
    }
    // align on a common daily calendar
    const first = Math.min(...series.map(s => s.rows[0]?.[0] ?? Infinity))
    const last = Math.max(...series.map(s => s.rows[s.rows.length - 1]?.[0] ?? 0))
    const days = []
    for (let t = first; t <= last; t += DAY) days.push(t)
    const pos = new Map(days.map((t, i) => [t, i]))
    const coins = series.filter(s => s.rows.length).map(s => {
      const close = new Array(days.length).fill(NaN), qv = new Array(days.length).fill(NaN)
      for (const [t, c, v] of s.rows) { const i = pos.get(t); if (i != null) { close[i] = c; qv[i] = v } }
      for (let i = 1; i < days.length; i++) if (!Number.isFinite(close[i]) && Number.isFinite(close[i - 1]) && i > 0) {
        // fill rare single-day gaps (exchange outages) with the previous close
        const firstSeen = close.findIndex(Number.isFinite)
        if (firstSeen >= 0 && i > firstSeen) close[i] = close[i - 1]
      }
      return { base: s.base, close, qv }
    })
    const data = { days, coins }
    const n = days.length - 1
    const now = picksAt(data, n)
    const prev = picksAt(data, n - 7)
    const tests = FEES.map(fee => {
      const b = backtestPicks(data, fee)
      return { fee, start: b.start, strategy: thin(b.strategy), btc: thin(b.btc), basket: thin(b.basket) }
    })
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'public, s-maxage=21600, stale-while-revalidate=86400')
    if (new URL(req.url, 'http://x').searchParams.get('summary') === '1') {
      return res.status(200).send(JSON.stringify({
        asOf: new Date(days[n]).toISOString().slice(0, 10), coinsChecked: coins.length, ms: Date.now() - t0, cash: now.cash,
        picks: now.universe.map(a => `${a.base} ${a.verdict} ${(a.weight * 100).toFixed(1)}% ${a.checks}/${a.of} vol${(a.vol * 100).toFixed(0)}%`),
        tests: tests.map(t => ({ fee: t.fee, from: new Date(t.start).toISOString().slice(0, 10),
          picks: t.strategy.metrics, exposure: t.strategy.avgExposure, trades: t.strategy.trades, btc: t.btc.metrics, basket: t.basket.metrics })),
      }))
    }
    res.status(200).send(JSON.stringify({
      updated: new Date().toISOString(), asOf: days[n], settings: SETTINGS, coinsChecked: coins.length,
      now, prev: { day: prev.day, weights: Object.fromEntries(prev.universe.filter(a => a.weight > 0).map(a => [a.base, a.weight])) },
      tests, ms: Date.now() - t0,
    }))
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
