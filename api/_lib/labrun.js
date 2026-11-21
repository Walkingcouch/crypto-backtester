// Shared runner for the three paper-trading labs (Lab, Explorer, Day trade): loads the saved
// state, takes a market snapshot (prices, candles, live exchange spreads), runs one step and
// saves. Called by Supabase pg_cron with `Authorization: Bearer <CRON_SECRET>`. Without the
// key (or with ?dry=1) it runs on a copy and saves nothing: the pages use that as a preview.
import { withLedger } from './trials.js'
import { newState, summary } from '../../src/lib/lab.js'
import { rpc, sb } from './forecaster.js'
import { weekCalendar } from './econ.js'

export const API = 'https://data-api.binance.vision/api/v3'
export const DAY = 86_400_000
export const STABLES = new Set(['U', 'USDD', 'FRAX', 'USDF', 'USDQ', 'USDG', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDS', 'USDE', 'USD1', 'XUSD', 'RLUSD', 'EUR', 'EURI', 'AEUR', 'GBP', 'PYUSD', 'USTC', 'UST', 'SUSD', 'BFUSD', 'USDT'])
export const NOT_COINS = new Set(['WBTC', 'WBETH', 'WETH', 'PAXG', 'XAUT', 'BETH', 'STETH'])
// Binance's tokenised US stocks and ETFs (e.g. NVDAB, SOXLB) trade like coins but aren't crypto
// New tokenised stocks keep appearing (SPCXB, MUB…): treat any short ticker ending in B as one,
// except real coins that happen to end in B.
const REAL_B = new Set(['BNB', 'ARB', 'BB', 'BOB', 'SNB', 'ORB', 'WOB', 'SUB', 'JOB', 'DOB', 'ZRB', 'SHIB'])
export const isStockToken = b => STOCK_RE.test(b) || (/^[A-Z]{2,5}B$/.test(b) && !REAL_B.has(b))
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

/**
 * Binance reuses some tickers (the old LUNA's history runs straight into the new LUNA's after a
 * pause), which would look like a 5,000,000% jump. A series is split wherever trading stopped for
 * 5+ days or the price moved more than 20× between bars: the latest piece keeps the ticker, older
 * pieces become 'LUNA~1', 'LUNA~2' (testing only, judged as LUNA for the top-list check).
 */
export function splitSegments(c) {
  if (!c) return [c]
  const cuts = []
  for (let i = 1; i < c.t.length; i++) {
    const r = c.c[i - 1] > 0 ? c.o[i] / c.c[i - 1] : 1
    if (c.t[i] - c.t[i - 1] > 5 * DAY || r > 20 || r < 1 / 20) cuts.push(i)
  }
  if (!cuts.length) return [c]
  const bounds = [0, ...cuts, c.t.length], out = []
  for (let k = 0; k < bounds.length - 1; k++) {
    const [a, b] = [bounds[k], bounds[k + 1]]
    const seg = Object.fromEntries(['t', 'o', 'h', 'l', 'c', 'v'].map(f => [f, c[f]?.slice(a, b)]))
    seg.base = k === bounds.length - 2 ? c.base : `${c.base}~${bounds.length - 2 - k}`
    out.push(seg)
  }
  return out.reverse()                                        // current piece first
}

/** Point-in-time top lists by month (api/pit-cron.js), or null until the first build finishes. */
async function loadPit() {
  try { const r = await sb('/rest/v1/lab_state?id=eq.pit-universe&select=data'); return r.ok ? ((await r.json())[0]?.data ?? null) : null } catch { return null }
}

/** Coins CoinSpot actually sells (from this site's /api/listings, which checks CoinSpot's public
 *  API and is cached for an hour). null when unknown: then every coin is allowed, as before. */
export async function coinspotListed() {
  try {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || 'crypto-backtester-au.vercel.app'
    const j = await getJSON(`https://${host}/api/listings`, 30000)
    const cs = j?.exchanges?.coinspot
    return cs?.ok && !cs.partial ? new Set(cs.coins) : null
  } catch { return null }
}

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
      const nPages = typeof pages === 'function' ? pages(saved, Date.now()) : pages
      const csListed = await coinspotListed()
      // wide mode (Day trading): trade every coin CoinSpot sells that Binance also lists with real
      // volume. Rules are still chosen and checked on the deep-history top coins (5 years); the rest
      // get the latest 1000 bars, enough for signals, stops and the learning record.
      let wideCoins = []
      if (opts.wide && csListed) {
        wideCoins = tickers
          .filter(t => t.symbol.endsWith('USDT') && +t.lastPrice > 0 && t.count > 0 && +t.quoteVolume >= (opts.wideMinVolUsd ?? 1e6))
          .map(t => t.symbol.slice(0, -4))
          .filter(b => csListed.has(b) && !universe.includes(b) && !STABLES.has(b) && !NOT_COINS.has(b) && !isStockToken(b) && !/(UP|DOWN|BULL|BEAR)$/.test(b))
      }
      // point-in-time history (pit-cron): coins that WERE in the top list during the tested years,
      // including ones since delisted, so the past isn't tested only on today's survivors
      let history = [], member = null
      const pit = opts.pit === false ? null : await loadPit()
      if (pit?.months && (interval === '1d' || nPages > 1)) {
        const sets = new Map(Object.entries(pit.months).map(([m, list]) => [m, new Set(list.slice(0, N))]))
        const keys = [...sets.keys()].sort()
        member = (b0, t) => { const b = b0.split('~')[0], m = new Date(t).toISOString().slice(0, 7); const s = sets.get(m) || sets.get(m < keys[0] ? keys[0] : keys[keys.length - 1]); return s ? s.has(b) : true }
        const from = new Date(Date.now() - nPages * 1000 * STEP[interval]).toISOString().slice(0, 7)
        history = [...new Set(keys.filter(k => k >= from).flatMap(k => [...sets.get(k)]))].filter(b => !universe.includes(b) && !held.has(b))
      }
      const want = [...new Set([...universe, ...wideCoins, ...held, ...history])]
      const deepSet = new Set([...universe, ...held, ...history])
      const fetchBars = async () => {                 // at most 16 requests in flight, to stay polite to Binance
        const out = new Array(want.length); let k = 0
        await Promise.all(Array.from({ length: 16 }, async () => {
          while (k < want.length) { const i = k++; out[i] = await bars(want[i], interval, deepSet.has(want[i]) ? nPages : 1).catch(() => null) }
        }))
        return out
      }

      const [rate, cs, cb, bn, coins] = await Promise.all([
        audPerUsd(), coinspotSpreads(), coinbaseSpreads([...deepSet]), binanceSpreads(), fetchBars(),
      ])
      // split reused tickers; older pieces only ever join the testing history
      const pieces = coins.map(splitSegments)
      coins.length = 0
      const oldPieces = []
      for (const ps of pieces) { coins.push(ps[0]); oldPieces.push(...ps.slice(1).filter(Boolean)) }
      const live = {}
      for (const t of tickers) if (t.symbol.endsWith('USDT')) live[t.symbol.slice(0, -4)] = +t.lastPrice
      const market = {
        coins: coins.filter(c => c && c.c.length > minBars && (universe.includes(c.base) || wideCoins.includes(c.base))),
        deep: opts.wide ? coins.filter(c => c && c.c.length > minBars && universe.includes(c.base)) : undefined,
        history: [...coins.filter(c => c && c.c.length > 30 && history.includes(c.base)), ...oldPieces.filter(c => c.c.length > 30)],   // past members only: for testing, never traded
        member,
        held: Object.fromEntries(coins.filter(c => c && held.has(c.base)).map(c => [c.base, c])),
        live, audPerUsd: rate,
        quotes: { john: { ...cs }, mark: cb, binance: bn }, estimated: { john: {} },
      }
      // a coin missing from CoinSpot's price feed gets an estimated spread only if CoinSpot sells it;
      // one it doesn't sell (e.g. MMT) gets no quote, so the CoinSpot account can't buy it
      market.unlisted = { john: {} }
      for (const c of market.coins) if (market.quotes.john[c.base] == null) {
        if (csListed && !csListed.has(c.base)) { market.unlisted.john[c.base] = true; continue }
        market.quotes.john[c.base] = COINSPOT_EST_SPREAD; market.estimated.john[c.base] = true
      }
      if (opts.events) market.events = await weekCalendar().catch(() => [])
      const now = Date.now()
      const state = await withLedger(sid, saved ? structuredClone(saved) : newState(rate, now), s => stepFn(s, market, now), { dry })
      if (!dry) saved = await rpc('lab_put', { sid, payload: state })
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', dry ? 'public, s-maxage=1800, stale-while-revalidate=7200' : 'no-store')
      res.status(200).send(JSON.stringify({
        dry, saved: dry ? null : saved, ms: Date.now() - t0, summary: summary(state),
        wide: wideCoins.length, history: history.length, pitMonths: pit?.months ? Object.keys(pit.months).length : 0, quotes: { coinspot: Object.keys(cs).length, coinbase: Object.keys(cb).length, binance: Object.keys(bn).length }, state,
      }))
    } catch (e) {
      res.status(500).json({ error: String(e && e.message || e) })
    }
  }
}
