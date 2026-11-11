// The Lab's paper-trading loop. Called every 5 hours by Supabase pg_cron (with ?key=),
// which loads the saved state, runs one step and saves it. ?dry=1 runs a step on a copy
// (or a fresh state) without saving — public, cached, used by the Lab page as a preview.
import { LAB, newState, step, summary } from '../src/lib/lab.js'
import { rpc, sb } from './_lib/forecaster.js'

const API = 'https://data-api.binance.vision/api/v3'
const DAY = 86_400_000
const STABLES = new Set(['U', 'USDD', 'FRAX', 'USDF', 'USDQ', 'USDG', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDS', 'USDE', 'USD1', 'XUSD', 'RLUSD', 'EUR', 'EURI', 'AEUR', 'GBP', 'PYUSD', 'USTC', 'UST', 'SUSD', 'BFUSD', 'USDT'])
const NOT_COINS = new Set(['WBTC', 'WBETH', 'WETH', 'PAXG', 'XAUT', 'BETH', 'STETH'])

async function getJSON(url, ms = 9000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'crypto-backtester' }, signal: ctl.signal })
    if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`)
    return await r.json()
  } finally { clearTimeout(t) }
}

async function audPerUsd() {
  try { const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=aud'); if (j.tether?.aud > 0) return j.tether.aud } catch { /* */ }
  const j = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD')
  return j.rates.AUD
}

async function bars(base) {
  const rows = await getJSON(`${API}/klines?symbol=${base}USDT&interval=1d&limit=1000`)
  const done = rows.filter(k => +k[0] + DAY <= Date.now())
  return { base, t: done.map(k => +k[0]), o: done.map(k => +k[1]), h: done.map(k => +k[2]), l: done.map(k => +k[3]), c: done.map(k => +k[4]) }
}

async function coinspotSpreads() {
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

async function coinbaseSpreads(bases) {
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

export default async function handler(req, res) {
  const q = new URL(req.url, 'http://x').searchParams
  const key = q.get('key') || (req.headers.authorization || '').replace(/^Bearer /, '')
  const authed = !!process.env.CRON_SECRET && key === process.env.CRON_SECRET
  const dry = !authed || q.get('dry') === '1'
  const t0 = Date.now()
  try {
    let saved = null
    try {
      const r = await sb('/rest/v1/lab_state?id=eq.main&select=data')
      if (r.ok) saved = (await r.json())[0]?.data ?? null
    } catch { /* table missing → fresh */ }

    const tickers = await getJSON(`${API}/ticker/24hr`)
    const universe = tickers
      .filter(t => t.symbol.endsWith('USDT') && +t.lastPrice > 0 && t.count > 0)
      .map(t => ({ base: t.symbol.slice(0, -4), qv: +t.quoteVolume }))
      .filter(t => !STABLES.has(t.base) && !NOT_COINS.has(t.base) && !/(UP|DOWN|BULL|BEAR)$/.test(t.base))
      .sort((a, b) => b.qv - a.qv).slice(0, LAB.universe).map(t => t.base)
    const held = new Set()
    for (const a of Object.values(saved?.accounts || {})) for (const p of a.positions) held.add(p.base)
    for (const s of saved?.shadow || []) held.add(s.base)
    const want = [...new Set([...universe, ...held])]

    const [rate, cs, cb, coins] = await Promise.all([
      audPerUsd(), coinspotSpreads(), coinbaseSpreads(want),
      Promise.all(want.map(b => bars(b).catch(() => null))),
    ])
    const live = {}
    for (const t of tickers) if (t.symbol.endsWith('USDT')) live[t.symbol.slice(0, -4)] = +t.lastPrice
    const market = {
      coins: coins.filter(c => c && c.c.length > 250 && universe.includes(c.base)), live, audPerUsd: rate,
      quotes: { john: cs, mark: cb },
    }
    const now = Date.now()
    const state = step(saved ? structuredClone(saved) : newState(rate, now), market, now)
    if (!dry) saved = await rpc('lab_put', { sid: 'main', payload: state })
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', dry ? 'public, s-maxage=1800, stale-while-revalidate=7200' : 'no-store')
    res.status(200).send(JSON.stringify({
      dry, saved: dry ? null : saved, ms: Date.now() - t0, summary: summary(state),
      quotes: { coinspot: Object.keys(cs).length, coinbase: Object.keys(cb).length }, state,
    }))
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
