// Smart Money & Political Flow: runs every connector that's due, merges new items into the stored
// feed (duplicates boost confidence instead of repeating), scores them, and saves the feed as
// lab_state 'signals'. Vercel cron runs it every 30 minutes; without the cron key (or with ?dry=1)
// nothing is saved.
import { extractText, getDocumentProxy } from 'unpdf'
import { merge, rangeLoHi, score } from './_lib/signals/schema.js'
import { asx3Y, auPoliticians, centralBanks, cryptoDerivatives, housePTRs, secForm4, senatePTRs, truthSocial } from './_lib/signals/sources.js'
import { weekCalendar } from './_lib/econ.js'
import { backfillLedger, enrichOrders } from './_lib/signals/orders.js'
import { rpc, sb } from './_lib/forecaster.js'
import { ASX } from '../src/lib/stocks.js'

const HOUR = 3_600_000, DAY = 86_400_000
const pdfText = async bytes => { const doc = await getDocumentProxy(bytes); const { text } = await extractText(doc, { mergePages: true }); return text }

// how often each connector runs (fast catalysts every half hour, slow disclosures a few times a day)
const EVERY = { truth: 0, okx: 0, sec: 0, senate: 6 * HOUR, house: 6 * HOUR, asx3y: 3 * HOUR, auMPs: 12 * HOUR, banks: 2 * HOUR }

/** Is each BUY's asset at a new 20-day closing high? (technical-confirmation badge) */
async function breakouts(list) {
  const want = [...new Set(list.filter(s => s.action === 'BUY' && s.asset_ticker && s.asset_ticker !== 'MARKET' && Date.now() - s.disclosed_at < 30 * DAY).map(s => `${s.market}|${s.asset_ticker}`))].slice(0, 40)
  const out = {}
  await Promise.all(want.map(async k => {
    const [m, tk] = k.split('|')
    try {
      let closes
      if (m === 'CRYPTO') {
        const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${tk}USDT&interval=1d&limit=25`)
        closes = (await r.json()).map(x => +x[4])
      } else {
        const sym = m === 'ASX' ? `${tk}.AX` : tk.replace('.', '-')
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=3mo&interval=1d`, { headers: { 'user-agent': 'Mozilla/5.0' } })
        closes = ((await r.json()).chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(x => x > 0)
      }
      if (closes.length > 21) out[k] = closes[closes.length - 1] >= Math.max(...closes.slice(-21, -1))
    } catch { /* no badge */ }
  }))
  return out
}

export default async function handler(req, res) {
  const q = new URL(req.url, 'http://x').searchParams
  const key = (req.headers.authorization || '').replace(/^Bearer /, '') || q.get('key')
  const dry = !(process.env.CRON_SECRET && key === process.env.CRON_SECRET) || q.get('dry') === '1'
  const now = Date.now(), t0 = now
  let state = null
  try { const r = await sb('/rest/v1/lab_state?id=eq.signals&select=data'); if (r.ok) state = (await r.json())[0]?.data ?? null } catch { /* fresh */ }
  state ||= { signals: [], runs: {}, status: {}, derivatives: {}, banksSeen: [] }
  const due = k => q.get('all') === '1' || !state.runs[k] || now - state.runs[k] >= EVERY[k] - 5 * 60_000
  const incoming = [], status = {}
  const run = async (k, fn) => {
    if (!due(k)) return
    const s0 = Date.now()
    try {
      const got = await fn()
      if (got?.skipped) { status[k] = { ok: false, note: got.skipped }; return }
      incoming.push(...got); status[k] = { ok: true, n: got.length, ms: Date.now() - s0 }; state.runs[k] = now
    } catch (e) { status[k] = { ok: false, note: String(e.message || e).slice(0, 160) } }
  }
  await Promise.all([
    run('truth', () => truthSocial()),
    run('okx', async () => { const d = await cryptoDerivatives({ prevOI: state.derivatives }); state.derivatives = d.snapshot; return d.signals }),
    run('banks', async () => { const b = await centralBanks({ seen: state.banksSeen }); state.banksSeen = [...state.banksSeen, ...b.map(x => x.post_id)].slice(-50); return b }),
    run('auMPs', () => auPoliticians()),
    run('asx3y', () => asx3Y({ codes: ASX.map(s => s.replace('.AX', '')).filter(c => !['IOZ', 'VAS', 'STW'].includes(c)) })),
  ])
  // the slower official sites one after another, to stay polite
  await run('sec', () => secForm4({ contact: process.env.SEC_CONTACT }))
  await run('senate', () => senatePTRs())
  await run('house', () => housePTRs({ pdfText }))

  const { list, added } = merge(state.signals, incoming, now)
  const events = await weekCalendar().catch(() => [])
  const ctx = { events, derivatives: Object.fromEntries(Object.entries(state.derivatives || {}).map(([k, v]) => [k, { funding: v.funding }])), breakout: await breakouts(list) }
  // politicians disclose slowly (Australian MPs can take months), so their trades are kept for a year
  const keep = s => now - s.disclosed_at < (s.category.startsWith('politician') ? 365 : 90) * DAY
  state.signals = score(list.filter(keep), now, ctx).slice(0, 1500)
  // order details for politicians' trades: prices on trade dates, implied shares, sale results
  state.ledger ||= {}
  for (const s of state.signals) if (s.category === 'politician_us' && !s.trade_size_range) {    // rows saved before ranges were kept
    const amt = (s.text.match(/\((\$[\d,]+\s*-\s*\$[\d,]+|Over \$[\d,]+)\)\s*$/) || [])[1]
    if (amt) { s.trade_size_range = rangeLoHi(amt); s.amount_text = amt }
    if (/ partly sold /.test(s.text)) s.partial = true
  }
  try {
    await enrichOrders(state.signals, state.ledger)                    // prices + matches from what's known
    const got = await backfillLedger(state.ledger, state.signals, { pdfText })   // read more past filings for unmatched sales
    if (got.house || got.senate) await enrichOrders(state.signals, state.ledger)
    status.orders = { ok: true, n: state.ledger.trades.length, note: `ledger ${state.ledger.trades.length} trades (+${got.house} House, +${got.senate} Senate filings read)` }
  } catch (e) { status.orders = { ok: false, note: String(e.message || e).slice(0, 120) } }
  state.status = { ...state.status, ...status }
  state.lastRun = now
  let saved = null
  if (!dry) saved = await rpc('lab_put', { sid: 'signals', payload: state })
  res.setHeader('cache-control', dry ? 'public, s-maxage=600' : 'no-store')
  res.status(200).json({ dry, saved, ms: Date.now() - t0, added, total: state.signals.length, status: state.status, signals: state.signals.slice(0, q.get('full') ? 1500 : 60) })
}
