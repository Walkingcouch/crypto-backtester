// Shared runner for the three paper-trading labs (Lab, Explorer, Day trade): loads the saved
// state, takes a market snapshot (prices, candles, live exchange spreads), runs one step and
// saves. Called by Supabase pg_cron with `Authorization: Bearer <CRON_SECRET>`. Without the
// key (or with ?dry=1) it runs on a copy and saves nothing: the pages use that as a preview.
import { newState, summary } from '../../src/lib/lab.js'
import { rpc, sb } from './forecaster.js'
import { weekCalendar } from './econ.js'

export const API = 'https://data-api.binance.vision/api/v3'
export const DAY = 86_400_000
const STABLES = new Set(['U', 'USDD', 'FRAX', 'USDF', 'USDQ', 'USDG', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDS', 'USDE', 'USD1', 'XUSD', 'RLUSD', 'EUR', 'EURI', 'AEUR', 'GBP', 'PYUSD', 'USTC', 'UST', 'SUSD', 'BFUSD', 'USDT'])
const NOT_COINS = new Set(['WBTC', 'WBETH', 'WETH', 'PAXG', 'XAUT', 'BETH', 'STETH'])
// Binance's tokenised US stocks and ETFs (e.g. NVDAB, SOXLB) trade like coins but aren't crypto
// New tokenised stocks keep appearing (SPCXB, MUB…): treat any short ticker ending in B as one,
// except real coins that happen to end in B.
const REAL_B = new Set(['BNB', 'ARB', 'BB', 'BOB', 'SNB', 'ORB', 'WOB', 'SUB', 'JOB', 'DOB', 'ZRB'])
const isStockToken = b => STOCK_RE.test(b) || (/^[A-Z]{2,5}B$/.test(b) && !REAL_B.has(b))
const STOCK_RE = /^(AAPL|AMZN|AMD|BABA|COIN|CRCL|GOOGL|GOOG|HOOD|INTC|META|MSFT|MSTR|NFLX|NVDA|ORCL|PLTR|QQQ|SOXL|SPY|SQQQ|TQQQ|TSLA|TSM|UBER|AVGO|ARM|SMCI|GME|AMC|DIS|JPM|V|MA|IWM|GLD|SLV|TLT|XLE|XLF|NKE|PYPL|SHOP|SNOW|RIVN|LCID|BA|KO|PEP|WMT|COST|IBIT|MSTU|CRWV|IREN|CIFR|SBET|BMNR|GLXY|RKLB|OKLO|HIMS|ASTS)B$/

export async function getJSON(url, ms = 9000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'crypto-backtester' }, signal: ctl.signal })
    if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`)
    return await r.json()
  } finally { clearTimeout(t) }
}

export async function audPerUsd() {
  try { const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=aud'); if (j.tether?.aud > 0) return j.tether.aud } catch { /* */ }
  const j = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD')
  return j.rates.AUD
}

const STEP = { '1d': DAY, '1h': 3_600_000 }
/** Completed candles, newest last. pages × 1000 bars (paged backwards from now). */
export async function bars(base, interval = '1d', pages = 1) {
  let rows = [], end = Date.now()
  for (let p = 0; p < pages; p++) {
    const k = await getJSON(`${API}/klines?symbol=${base}USDT&interval=${interval}&limit=1000&endTime=${end}`)
    if (!k.length) break
    rows = k.concat(rows)
    end = +k[0][0] - 1
    if (k.length < 1000) break
  }
  const done = rows.filter(k => +k[0] + STEP[interval] <= Date.now())
  return { base, t: done.map(k => +k[0]), o: done.map(k => +k[1]), h: done.map(k => +k[2]), l: done.map(k => +k[3]), c: done.map(k => +k[4]), v: done.map(k => +k[7]) }
}

export async function coinspotSpreads() {
  const out = {}
  try {
    const j = await getJSON('https://www.coinspot.com.au/pubapi/v2/latest')
    for (const [k, v] of Object.entries(j.prices || {})) {
      if (k.includes('_')) continue
      const bid = +v.bid, ask = +v.ask
      if (bid > 0 && ask >= bid) out[k.toUpperCase()] = (ask - bid) / ((ask + bid) / 2)
    }
  } catch { /* no quotes → entries skipped */ }
  return out
}

export async function binanceSpreads() {
  const out = {}
  try {
    for (const t of await getJSON(`${API}/ticker/bookTicker`)) {
      if (!t.symbol.endsWith('USDT')) continue
      const bid = +t.bidPrice, ask = +t.askPrice
      if (bid > 0 && ask >= bid) out[t.symbol.slice(0, -4)] = (ask - bid) / ((ask + bid) / 2)
    }
  } catch { /* */ }
  return out
}

// CoinSpot lists many more coins than its public price feed covers (e.g. PEPE), so for a
// scanned coin missing from the feed the Lab assumes a cautious 1% spread and labels it.
const COINSPOT_EST_SPREAD = 0.01

export async function coinbaseSpreads(bases) {
  const out = {}
  await Promise.all(bases.map(async b => {
    try {
      const j = await getJSON(`https://api.exchange.coinbase.com/products/${b}-USD/ticker`, 6000)
      const bid = +j.bid, ask = +j.ask
      if (bid > 0 && ask >= bid) out[b] = (ask - bid) / ((ask + bid) / 2)
    } catch { /* not on Coinbase, or no quote */ }
  }))
  return out
}


/**
 * opts: { sid, stepFn(state, market, now), universe, interval, pages, minBars }
 */
export function labHandler(opts) {
  const { sid, stepFn, universe: N = 20, interval = '1d', pages = 1, minBars = 250 } = opts
  return async function handler(req, res) {
    const q = new URL(req.url, 'http://x').searchParams
    const key = (req.headers.authorization || '').replace(/^Bearer /, '') || q.get('key')
    const authed = !!process.env.CRON_SECRET && key === process.env.CRON_SECRET
    const dry = !authed || q.get('dry') === '1'
    const t0 = Date.now()
    try {
      let saved = null
      try {
        const r = await sb(`/rest/v1/lab_state?id=eq.${sid}&select=data`)
        if (r.ok) saved = (await r.json())[0]?.data ?? null
      } catch { /* table missing → fresh */ }

      const tickers = await getJSON(`${API}/ticker/24hr`)
      const universe = tickers
        .filter(t => t.symbol.endsWith('USDT') && +t.lastPrice > 0 && t.count > 0)
        .map(t => ({ base: t.symbol.slice(0, -4), qv: +t.quoteVolume }))
        .filter(t => !STABLES.has(t.base) && !NOT_COINS.has(t.base) && !isStockToken(t.base) && !/(UP|DOWN|BULL|BEAR)$/.test(t.base))
        .sort((a, b) => b.qv - a.qv).slice(0, N).map(t => t.base)
      if (!universe.includes('BTC')) universe.push('BTC')
      const held = new Set()
      for (const a of Object.values(saved?.accounts || {})) for (const p of a.positions) held.add(p.base)
      for (const s of saved?.shadow || []) held.add(s.base)
      const want = [...new Set([...universe, ...held])]

      const [rate, cs, cb, bn, coins] = await Promise.all([
        audPerUsd(), coinspotSpreads(), coinbaseSpreads(want), binanceSpreads(),
        Promise.all(want.map(b => bars(b, interval, typeof pages === 'function' ? pages(saved, Date.now()) : pages).catch(() => null))),
      ])
      const live = {}
      for (const t of tickers) if (t.symbol.endsWith('USDT')) live[t.symbol.slice(0, -4)] = +t.lastPrice
      const market = {
        coins: coins.filter(c => c && c.c.length > minBars && universe.includes(c.base)),
        held: Object.fromEntries(coins.filter(c => c && held.has(c.base)).map(c => [c.base, c])),
        live, audPerUsd: rate,
        quotes: { john: { ...cs }, mark: cb, binance: bn }, estimated: { john: {} },
      }
      for (const c of market.coins) if (market.quotes.john[c.base] == null) { market.quotes.john[c.base] = COINSPOT_EST_SPREAD; market.estimated.john[c.base] = true }
      if (opts.events) market.events = await weekCalendar().catch(() => [])
      const now = Date.now()
      const state = stepFn(saved ? structuredClone(saved) : newState(rate, now), market, now)
      if (!dry) saved = await rpc('lab_put', { sid, payload: state })
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', dry ? 'public, s-maxage=1800, stale-while-revalidate=7200' : 'no-store')
      res.status(200).send(JSON.stringify({
        dry, saved: dry ? null : saved, ms: Date.now() - t0, summary: summary(state),
        quotes: { coinspot: Object.keys(cs).length, coinbase: Object.keys(cb).length, binance: Object.keys(bn).length }, state,
      }))
    } catch (e) {
      res.status(500).json({ error: String(e && e.message || e) })
    }
  }
}
