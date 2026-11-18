// Shared runner for the three shares labs (swing, new ideas, day trading): Yahoo Finance prices
// for US and ASX shares, one step of the lab, saved to lab_state. Run by Vercel cron with
// `Authorization: Bearer <CRON_SECRET>`; without the key (or with ?dry=1) nothing is saved.
import { newState, summary } from '../../src/lib/lab.js'
import { audPerUsd } from './labrun.js'
import { rpc, sb } from './forecaster.js'
import { weekCalendar } from './econ.js'

const DAY = 86_400_000, HOUR = 3_600_000

async function getJSON(url, ms = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: ctl.signal })
    if (!r.ok) throw new Error(`${r.status}`)
    return await r.json()
  } finally { clearTimeout(t) }
}

async function chart(sym, range, interval) {
  let last
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`)
      const r = j?.chart?.result?.[0]
      if (r?.timestamp) return r
      last = new Error('no data')
    } catch (e) { last = e }
  }
  throw last
}

/**
 * Completed bars, stamped with the exchange's LOCAL trading date `d` (UTC midnight of that date) so
 * ASX and US days line up. Daily bars use t = d; hourly bars keep their real start time in t.
 * Daily prices are adjusted for splits and dividends. Today's unfinished bar is left out.
 */
export async function yahooBars(sym, market, { range = '5y', interval = '1d' } = {}) {
  const r = await chart(sym, range, interval)
  const q = r.indicators.quote[0], adj = r.indicators.adjclose?.[0]?.adjclose
  const off = (r.meta.gmtoffset || 0) * 1000
  const reg = r.meta.currentTradingPeriod?.regular
  const daily = interval === '1d', step = daily ? DAY : HOUR
  const now = Date.now()
  const out = { base: sym, market, t: [], o: [], h: [], l: [], c: [], v: [], d: [] }
  for (let i = 0; i < r.timestamp.length; i++) {
    const ts = r.timestamp[i] * 1000, o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i]
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue
    const inSession = reg && now < reg.end * 1000 && ts >= reg.start * 1000 - HOUR
    const barEnd = !daily && reg && ts < reg.end * 1000 ? Math.min(ts + step, reg.end * 1000) : ts + step   // last bar ends at the close
    if (inSession && (daily || barEnd > now)) continue              // still forming
    const k = daily && adj?.[i] > 0 ? adj[i] / c : 1
    const d = Math.floor((ts + off) / DAY) * DAY
    out.t.push(daily ? d : ts); out.d.push(d)
    out.o.push(o * k); out.h.push(h * k); out.l.push(l * k); out.c.push(c * k); out.v.push((q.volume[i] || 0) * c)
  }
  // Yahoo adds a closing-price snapshot (e.g. 16:00 after the 15:30 bar) to the newest sessions:
  // it isn't a full bar, so drop any day's last bar that starts less than an hour after the one before
  if (!daily) {
    const keep = out.t.map((t, i) => !(i > 0 && out.d[i - 1] === out.d[i] && (i + 1 === out.t.length || out.d[i + 1] !== out.d[i]) && t - out.t[i - 1] < HOUR))
    for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = out[k].filter((_, i) => keep[i])
  }
  out.live = r.meta.regularMarketPrice > 0 ? r.meta.regularMarketPrice : out.c[out.c.length - 1]
  out.session = reg ? { day: Math.floor((reg.start * 1000 + off) / DAY) * DAY, start: reg.start * 1000, end: reg.end * 1000 } : null
  return out
}

/**
 * opts: { sid, list: [[symbol, market]], accounts, spread: { US, ASX }, stepFn(state, market, now, saved),
 *         bars: (saved, now) => ({ range, interval }), minBars }
 */
export function sharesHandler(opts) {
  return async function handler(req, res) {
    const q = new URL(req.url, 'http://x').searchParams
    const key = (req.headers.authorization || '').replace(/^Bearer /, '') || q.get('key')
    const authed = !!process.env.CRON_SECRET && key === process.env.CRON_SECRET
    const dry = !authed || q.get('dry') === '1'
    const t0 = Date.now()
    try {
      let saved = null
      try { const r = await sb(`/rest/v1/lab_state?id=eq.${opts.sid}&select=data`); if (r.ok) saved = (await r.json())[0]?.data ?? null } catch { /* fresh */ }
      const now = Date.now()
      const want = opts.bars ? opts.bars(saved, now) : { range: '10y', interval: '1d' }   // 10 years: includes the 2020 crash and the 2022 bear market
      const rate = await audPerUsd()
      const coins = [], errors = []
      for (let i = 0; i < opts.list.length; i += 8) {
        const got = await Promise.all(opts.list.slice(i, i + 8).map(([s, m]) => yahooBars(s, m, want).catch(e => { errors.push(`${s}: ${e.message || e}`); return null })))
        coins.push(...got.filter(Boolean))
      }
      // the engines work in USD: ASX prices are converted at today's rate (a constant scale, so
      // signals and returns are unchanged)
      for (const c of coins) if (c.market === 'ASX') { for (const k of ['o', 'h', 'l', 'c']) c[k] = c[k].map(x => x / rate); c.live /= rate }
      const usable = coins.filter(c => c.c.length > (opts.minBars ?? 250))
      const live = Object.fromEntries(usable.map(c => [c.base, c.live]))
      const quotes = {}
      for (const a of opts.accounts) quotes[a.id] = Object.fromEntries(usable.filter(c => c.market === a.market).map(c => [c.base, opts.spread[c.market]]))
      const sessions = {}
      for (const c of usable) if (c.session && !sessions[c.market]) sessions[c.market] = c.session
      const market = { coins: usable, held: {}, live, audPerUsd: rate, quotes, estimated: {}, sessions, full: want.full ?? true }
      if (opts.events) market.events = await weekCalendar().catch(() => [])
      const state = opts.stepFn(saved ? structuredClone(saved) : newState(rate, now, opts.accounts), market, now)
      if (want.full !== false) state.coinsScanned = usable.map(c => c.base)
      let out = null
      if (!dry) out = await rpc('lab_put', { sid: opts.sid, payload: state })
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', dry ? 'public, s-maxage=1800, stale-while-revalidate=7200' : 'no-store')
      res.status(200).send(JSON.stringify({ dry, saved: dry ? null : out, ms: Date.now() - t0, errors, summary: summary(state), state }))
    } catch (e) {
      res.status(500).json({ error: String(e && e.message || e) })
    }
  }
}
