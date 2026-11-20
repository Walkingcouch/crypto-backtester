// Smart money backtest, run daily: rates every stream of smart-money data (politicians, insiders,
// ASX directors, Truth Social, central banks, crypto futures crowding) on what prices did after
// each signal was published. Also keeps a permanent archive of every signal ever seen, so streams
// that the live feed only keeps for 90 days build up history over time.
// Saves lab_state 'smart-test' (results) and 'signals-archive' (history). ?dry=1 saves nothing.
import { rpc, sb } from './_lib/forecaster.js'
import { yahooBars } from './_lib/sharesrun.js'
import { bars as binanceBars } from './_lib/labrun.js'
import { archiveRow, benchKey, buildEvents, priceKey, rateStreams } from './_lib/signals/backtest.js'

const MAX_TICKERS = 1200
const load = async id => { const r = await sb(`/rest/v1/lab_state?id=eq.${id}&select=data`); return r.ok ? (await r.json())[0]?.data ?? null : null }

export default async function handler(req, res) {
  const t0 = Date.now()
  const q = new URL(req.url, 'http://x').searchParams
  const key = (req.headers.authorization || '').replace(/^Bearer /, '') || q.get('key')
  const dry = !(process.env.CRON_SECRET && key === process.env.CRON_SECRET) || q.get('dry') === '1'
  try {
    const [sig, arch] = await Promise.all([load('signals'), load('signals-archive')])
    const signals = sig?.signals || []
    // 1. archive: every signal ever seen (deduplicated), so short-lived streams accumulate history
    const archive = arch?.rows || []
    const k = r => `${r.category}|${r.entity_name}|${r.asset_ticker}|${r.action}|${r.trade_date || ''}|${r.post_id || Math.floor(r.disclosed_at / 3_600_000)}`
    const have = new Set(archive.map(k))
    let archived = 0
    for (const s of signals) { const r = archiveRow(s); if (r.asset_ticker && !have.has(k(r))) { have.add(k(r)); archive.push(r); archived++ } }
    archive.sort((a, b) => a.disclosed_at - b.disclosed_at)
    if (archive.length > 30000) archive.splice(0, archive.length - 30000)

    // 2. events and the prices they need
    const { events, lagDays } = buildEvents({ signals, ledger: sig?.ledger, archive })
    const count = new Map()
    for (const e of events) { const pk = priceKey(e.market, e.ticker); count.set(pk, (count.get(pk) || 0) + 1) }
    // smaller streams first (each of their shares matters), then the busiest politician shares
    const small = new Set(events.filter(e => e.cat !== 'politician_us').map(e => priceKey(e.market, e.ticker)))
    const want = [...count.entries()].sort((a, b) => (small.has(b[0]) - small.has(a[0])) || b[1] - a[1]).slice(0, MAX_TICKERS).map(([pk]) => pk)
    for (const m of ['US', 'ASX', 'CRYPTO']) if (!want.includes(benchKey(m))) want.push(benchKey(m))
    const prices = {}, failed = []
    for (let i = 0; i < want.length; i += 10) {
      await Promise.all(want.slice(i, i + 10).map(async pk => {
        const [m, tk] = pk.split('|')
        try {
          const b = m === 'CRYPTO' ? await binanceBars(tk, '1d', 2) : await yahooBars(m === 'US' ? tk.replace('.', '-') : tk, m, { range: '5y', interval: '1d' })
          if (b?.t?.length > 30) prices[pk] = { t: b.t, o: b.o, c: b.c }
          else failed.push(tk)
        } catch { failed.push(tk) }
      }))
      if (Date.now() - t0 > 200_000) break      // stay well inside the time limit
    }

    // 3. rate every stream
    const result = rateStreams(events, prices)
    const byCat = {}
    for (const e of events) byCat[e.cat] = (byCat[e.cat] || 0) + 1
    const state = {
      ...result, lagDays, events: events.length, byCategory: byCat,
      oldest: events.length ? Math.min(...events.map(e => e.t)) : null,
      prices: Object.keys(prices).length, wanted: want.length, distinctAssets: count.size, priceMissing: failed.slice(0, 40), priceMissingCount: failed.length, archived: archive.length, ms: Date.now() - t0,
    }
    if (!dry) {
      await rpc('lab_put', { sid: 'signals-archive', payload: { rows: archive, updated: Date.now() } })
      await rpc('lab_put', { sid: 'smart-test', payload: state })
    }
    res.setHeader('cache-control', dry ? 'public, s-maxage=600' : 'no-store')
    res.status(200).json({ dry, archivedNew: archived, ...state })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
