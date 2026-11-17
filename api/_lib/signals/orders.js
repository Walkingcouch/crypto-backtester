// Order details for politicians' trades. Disclosures give only a dollar range and a date, so:
//  - price: the share's closing price on the trade date (Yahoo Finance daily data)
//  - shares: the disclosed dollar range divided by that price
//  - since: how the share has moved since the trade
//  - for sales, the matching earlier buys by the same person (first in, first out) from a ledger of
//    their past filings, and the estimated result: buy price → sell price, % gain, and the dollar gain
//    implied by the disclosed sale range (gain = proceeds × g / (1 + g)).
// The ledger is filled gradually: each run reads a few more past filings for people with unmatched sales.
import { houseIndex, houseParse, senateSession } from './sources.js'

const DAY = 86_400_000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const norm = s => (s || '').toLowerCase().replace(/^(sen|rep)\.\s*/, '').replace(/[^a-z]/g, '')
const ledgerKey = t => `${norm(t.entity_name)}|${t.asset_ticker}|${t.action}|${t.trade_date}|${t.trade_size_usd}`

/** Daily closes for the last ~2 years, oldest first. */
async function closes(ticker, market) {
  const sym = market === 'ASX' ? `${ticker}.AX` : ticker.replace('.', '-')
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`, { headers: { 'user-agent': 'Mozilla/5.0' } })
  const res = (await r.json()).chart?.result?.[0]
  if (!res?.timestamp) return null
  const off = (res.meta.gmtoffset || 0) * 1000, c = res.indicators.quote[0].close
  const t = [], p = []
  for (let i = 0; i < res.timestamp.length; i++) if (c[i] > 0) { t.push(Math.floor((res.timestamp[i] * 1000 + off) / DAY) * DAY); p.push(c[i]) }
  return { t, p, cur: res.meta.currency || (market === 'ASX' ? 'AUD' : 'USD'), last: res.meta.regularMarketPrice || p[p.length - 1] }
}
/** Close on day d, or the last trading day before it. */
function closeOn(h, d) {
  if (!h || d == null || d < h.t[0]) return null
  let lo = 0, hi = h.t.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (h.t[mid] <= d) lo = mid; else hi = mid - 1 }
  return h.p[lo]
}

/**
 * Read more past filings for people whose sales have no matching buy yet (a few per run).
 * ledger = { trades: [...], houseDocs: [...], senateLinks: [...], senateNames: [...] }
 */
export async function backfillLedger(ledger, signals, { pdfText, maxHouse = 10, maxSenate = 3 } = {}) {
  ledger.trades ||= []; ledger.houseDocs ||= []; ledger.senateLinks ||= []; ledger.senateDone ||= []
  const have = new Set(ledger.trades.map(ledgerKey))
  const add = ts => { for (const t of ts) { const k = ledgerKey(t); if (!have.has(k)) { have.add(k); ledger.trades.push(slim(t)) } } }
  add(signals.filter(s => s.category === 'politician_us' && s.trade_date))
  const unmatched = signals.filter(s => s.category === 'politician_us' && s.action === 'SELL' && !s.order?.buys?.length)
  const people = [...new Map(unmatched.map(s => [norm(s.entity_name), s])).values()]
  const notes = { house: 0, senate: 0 }

  // House: every electronic PTR the person filed this year and last year
  const houseNames = people.filter(s => s.entity_name.startsWith('Rep.')).map(s => norm(s.entity_name))
  if (houseNames.length) {
    const y = new Date().getUTCFullYear()
    const idx = (await houseIndex([y, y - 1]).catch(() => [])).filter(r => houseNames.includes(norm(r.name)) && !ledger.houseDocs.includes(r.doc))
    for (const r of idx.slice(0, maxHouse)) {
      try { add(await houseParse(r, pdfText)); notes.house++ } catch { /* unreadable */ }
      ledger.houseDocs.push(r.doc)
      await sleep(200)
    }
  }
  // Senate: the person's filings over the last two years
  const senators = people.filter(s => s.entity_name.startsWith('Sen.') && !ledger.senateDone.includes(norm(s.entity_name))).slice(0, maxSenate)
  if (senators.length) {
    const S = await senateSession()
    for (const s of senators) {
      const [first, ...rest] = s.entity_name.replace(/^Sen\.\s*/, '').split(' ')
      const rows = await S.search({ since: Date.now() - 730 * DAY, first, last: rest.join(' '), max: 60 }).catch(() => [])
      for (const row of rows) {
        if (ledger.senateLinks.includes(row.href)) continue
        try { add(await S.parse(row)); notes.senate++ } catch { /* skip */ }
        ledger.senateLinks.push(row.href)
        await sleep(250)
      }
      ledger.senateDone.push(norm(s.entity_name))
    }
  }
  ledger.trades = ledger.trades.filter(t => t.trade_date > Date.now() - 3 * 365 * DAY).slice(-6000)
  ledger.houseDocs = ledger.houseDocs.slice(-4000); ledger.senateLinks = ledger.senateLinks.slice(-2000)
  return notes
}
const slim = t => ({ entity_name: t.entity_name, asset_ticker: t.asset_ticker, action: t.action, trade_date: t.trade_date, trade_size_usd: t.trade_size_usd, trade_size_range: t.trade_size_range, partial: t.partial || false })

/** Attach order details to every politician trade (prices fetched once per ticker per run). */
export async function enrichOrders(signals, ledger, { maxTickers = 160 } = {}) {
  const pol = signals.filter(s => s.category.startsWith('politician') && s.asset_ticker && (s.action === 'BUY' || s.action === 'SELL'))
  const want = [...new Map(pol.map(s => [`${s.market}|${s.asset_ticker}`, s])).keys()].slice(0, maxTickers)
  const hist = {}
  for (let i = 0; i < want.length; i += 8) {
    await Promise.all(want.slice(i, i + 8).map(async k => { const [m, tk] = k.split('|'); hist[k] = await closes(tk, m).catch(() => null) }))
  }
  const buysBy = new Map()
  for (const t of ledger.trades || []) if (t.action === 'BUY') { const k = `${norm(t.entity_name)}|${t.asset_ticker}`; buysBy.set(k, [...(buysBy.get(k) || []), t]) }
  for (const v of buysBy.values()) v.sort((a, b) => a.trade_date - b.trade_date)
  const ledgerStart = Math.min(...(ledger.trades || []).map(t => t.trade_date), Date.now())

  for (const s of pol) {
    const h = hist[`${s.market}|${s.asset_ticker}`]
    if (!h) continue
    const day = s.trade_date ?? Math.floor(s.disclosed_at / DAY) * DAY
    const px = closeOn(h, day), now = h.last
    const rng = s.trade_size_range
    const o = {
      currency: h.cur, date: day, dateIsTrade: !!s.trade_date, price: px ? +px.toFixed(2) : null, now: now ? +now.toFixed(2) : null,
      since: px && now ? +(now / px - 1).toFixed(4) : null,
      shares: px && rng ? [Math.round(rng[0] / px), rng[1] ? Math.round(rng[1] / px) : null] : null,
    }
    if (s.action === 'SELL' && s.market === 'US' && px) {
      const buys = (buysBy.get(`${norm(s.entity_name)}|${s.asset_ticker}`) || []).filter(b => b.trade_date < day && b.trade_date > day - 3 * 365 * DAY)
      if (buys.length) {
        const priced = buys.map(b => ({ date: b.trade_date, range: b.trade_size_range, price: closeOn(h, b.trade_date) })).filter(b => b.price)
        if (priced.length) {
          // weighted by each buy's disclosed size (midpoint); first in, first out isn't knowable from ranges alone
          const w = priced.map(b => (b.range ? (b.range[0] + (b.range[1] || b.range[0])) / 2 : 1))
          const avg = priced.reduce((a, b, i) => a + b.price * w[i], 0) / w.reduce((a, b) => a + b, 0)
          const g = px / avg - 1
          o.buys = priced.slice(-4).map(b => ({ date: b.date, price: +b.price.toFixed(2), range: b.range }))
          o.buyAvg = +avg.toFixed(2)
          o.gain = +g.toFixed(4)
          o.gainUsd = rng ? [Math.round(rng[0] * g / (1 + g)), rng[1] ? Math.round(rng[1] * g / (1 + g)) : null] : null
          o.held = Math.round((day - priced[0].date) / DAY)
        }
      } else o.noBuySince = ledgerStart
    }
    s.order = o
  }
  return want.length
}
