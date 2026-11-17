// Stocks Lab: daily bars for large US and ASX shares from Yahoo Finance's chart feed, one step of
// the swing loop, saved as lab_state 'stocks'. Run by Vercel cron after each market closes
// (06:30 UTC for the ASX, 21:30 UTC for the US) with `Authorization: Bearer <CRON_SECRET>`.
// Without the key (or with ?dry=1) it runs on a copy and saves nothing.
import { newState, step, summary } from '../src/lib/lab.js'
import { ASX, SPREAD, STOCK, US } from '../src/lib/stocks.js'
import { audPerUsd } from './_lib/labrun.js'
import { rpc, sb } from './_lib/forecaster.js'

const DAY = 86_400_000

async function getJSON(url, ms = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; paper-lab/1.0)' }, signal: ctl.signal })
    if (!r.ok) throw new Error(`${r.status}`)
    return await r.json()
  } finally { clearTimeout(t) }
}

/**
 * ~5 years of completed daily bars. Each bar is stamped with its exchange's LOCAL trading date
 * (UTC midnight of that date), so ASX and US days line up. Today's bar is dropped until that
 * market's session has closed.
 */
async function dailyBars(sym, market) {
  let j
  for (const host of ['query1', 'query2']) {
    try { j = await getJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d&includePrePost=false&events=div%2Csplit`); break } catch (e) { j = null; if (host === 'query2') throw e }
  }
  const r = j?.chart?.result?.[0]
  if (!r?.timestamp) throw new Error('no data')
  const q = r.indicators.quote[0], adj = r.indicators.adjclose?.[0]?.adjclose
  const off = (r.meta.gmtoffset || 0) * 1000
  const reg = r.meta.currentTradingPeriod?.regular
  const out = { base: sym, market, t: [], o: [], h: [], l: [], c: [], v: [] }
  for (let i = 0; i < r.timestamp.length; i++) {
    const ts = r.timestamp[i] * 1000, o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i]
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue
    if (reg && Date.now() < reg.end * 1000 && ts >= reg.start * 1000 - 3_600_000) continue   // session still open
    // adjust for splits and dividends so returns are real (ratio of adjusted to raw close)
    const k = adj?.[i] > 0 ? adj[i] / c : 1
    out.t.push(Math.floor((ts + off) / DAY) * DAY)
    out.o.push(o * k); out.h.push(h * k); out.l.push(l * k); out.c.push(c * k); out.v.push((q.volume[i] || 0) * c)
  }
  out.live = out.c[out.c.length - 1]
  return out
}

export default async function handler(req, res) {
  const q = new URL(req.url, 'http://x').searchParams
  const key = (req.headers.authorization || '').replace(/^Bearer /, '') || q.get('key')
  const authed = !!process.env.CRON_SECRET && key === process.env.CRON_SECRET
  const dry = !authed || q.get('dry') === '1'
  const t0 = Date.now()
  try {
    let saved = null
    try { const r = await sb('/rest/v1/lab_state?id=eq.stocks&select=data'); if (r.ok) saved = (await r.json())[0]?.data ?? null } catch { /* fresh */ }
    const rate = await audPerUsd()
    const list = [...US.map(s => [s, 'US']), ...ASX.map(s => [s, 'ASX'])]
    const coins = [], errors = []
    for (let i = 0; i < list.length; i += 8) {
      const got = await Promise.all(list.slice(i, i + 8).map(([s, m]) => dailyBars(s, m).catch(e => { errors.push(`${s}: ${e.message || e}`); return null })))
      coins.push(...got.filter(Boolean))
    }
    // everything inside the engine is in USD: ASX prices are converted at today's rate
    // (a constant scale, so signals and returns are unchanged)
    for (const c of coins) if (c.market === 'ASX') for (const k of ['o', 'h', 'l', 'c']) c[k] = c[k].map(x => x / rate)
    const usable = coins.filter(c => c.c.length > 250)
    const live = Object.fromEntries(usable.map(c => [c.base, c.c[c.c.length - 1]]))
    const quotes = {}
    for (const a of STOCK.accounts) quotes[a.id] = Object.fromEntries(usable.filter(c => c.market === a.market).map(c => [c.base, SPREAD[c.market]]))
    const market = { coins: usable, held: {}, live, audPerUsd: rate, quotes, estimated: {} }
    const now = Date.now()
    const state = step(saved ? structuredClone(saved) : newState(rate, now, STOCK.accounts), market, now, STOCK)
    state.coinsScanned = usable.map(c => c.base)
    let out = null
    if (!dry) out = await rpc('lab_put', { sid: 'stocks', payload: state })
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', dry ? 'public, s-maxage=1800, stale-while-revalidate=7200' : 'no-store')
    res.status(200).send(JSON.stringify({ dry, saved: dry ? null : out, ms: Date.now() - t0, errors, summary: summary(state), state }))
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
