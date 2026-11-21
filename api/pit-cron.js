// Point-in-time coin lists (fixes survivorship bias). The labs used to test the past with TODAY's
// most-traded coins, which leaves out every coin that later collapsed or faded (LUNA, FTT, SRM…).
// This job reads the full daily history of EVERY Binance USDT pair, including the 200+ that have
// since been delisted (Binance still serves their history), and records for each month which coins
// were actually the most traded at the time, ranked on the PREVIOUS month's volume so nothing is
// known before it happened. The labs then only test a coin on days it really was in the top list.
//
// Runs hourly; a full build takes a few runs (about 700 pairs), then it refreshes once a month.
// Saved as lab_state 'pit-universe' ({ months: { '2024-05': ['BTC', 'ETH', …top 40] } }).
import { rpc, sb } from './_lib/forecaster.js'
import { getJSON, isStockToken, NOT_COINS, STABLES } from './_lib/labrun.js'

const API = 'https://data-api.binance.vision/api/v3'
const DAY = 86_400_000, FROM = Date.UTC(2019, 0, 1), TOP = 40, BUDGET = 230_000
const FIAT = new Set(['AUD', 'EUR', 'GBP', 'TRY', 'BRL', 'RUB', 'UAH', 'NGN', 'ZAR', 'BIDR', 'IDRT', 'BKRW', 'PLN', 'RON', 'ARS', 'JPY', 'MXN', 'COP', 'CZK'])
const ym = t => new Date(t).toISOString().slice(0, 7)
const prevYm = k => { const [y, m] = k.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}` }
const okBase = b => /^[A-Z0-9]{2,12}$/.test(b) && !STABLES.has(b) && !NOT_COINS.has(b) && !FIAT.has(b) && !isStockToken(b) && !/(UP|DOWN|BULL|BEAR)$/.test(b) && !/USD/.test(b)

async function load(id) { try { const r = await sb(`/rest/v1/lab_state?id=eq.${id}&select=data`); return r.ok ? (await r.json())[0]?.data ?? null : null } catch { return null } }

/** Average daily US$ volume per month for one pair, from its whole daily history. */
async function monthlyVolume(symbol) {
  const sums = {}
  let start = FROM
  for (let page = 0; page < 4; page++) {
    const k = await getJSON(`${API}/klines?symbol=${symbol}&interval=1d&limit=1000&startTime=${start}`, 12000)
    if (!Array.isArray(k) || !k.length) break
    for (const row of k) { const m = ym(+row[0]); const o = (sums[m] ||= [0, 0]); o[0] += +row[7]; o[1]++ }
    start = +k[k.length - 1][0] + DAY
    if (k.length < 1000) break
  }
  return Object.fromEntries(Object.entries(sums).map(([m, [s, n]]) => [m, Math.round(s / n)]))
}

export default async function handler(req, res) {
  const key = (req.headers.authorization || '').replace(/^Bearer /, '')
  const authed = !!process.env.CRON_SECRET && key === process.env.CRON_SECRET
  if (!authed) return res.status(401).json({ error: 'not allowed' })
  const t0 = Date.now()
  let b = await load('pit-build')
  const fresh = b?.complete && Date.now() - b.builtAt < 28 * DAY
  if (fresh && new URL(req.url, 'http://x').searchParams.get('force') !== '1') return res.status(200).json({ fresh: true, builtAt: b.builtAt, coins: b.coins })
  if (!b || b.complete) {
    const info = await getJSON(`${API}/exchangeInfo?permissions=SPOT`, 20000)
    const symbols = (info.symbols || []).filter(s => s.quoteAsset === 'USDT' && (s.status === 'TRADING' || s.status === 'BREAK') && okBase(s.baseAsset)).map(s => s.symbol)
    b = { symbols, done: 0, vols: {}, startedAt: Date.now(), complete: false }
  }
  let failed = 0
  while (b.done < b.symbols.length && Date.now() - t0 < BUDGET) {
    const batch = b.symbols.slice(b.done, b.done + 12)
    const got = await Promise.all(batch.map(s => monthlyVolume(s).catch(() => null)))
    batch.forEach((s, i) => { if (got[i]) b.vols[s.slice(0, -4)] = got[i]; else failed++ })
    b.done += batch.length
  }
  if (b.done >= b.symbols.length) {
    // month M's list = most traded in month M-1 (known before M began)
    const months = {}
    const all = [...new Set(Object.values(b.vols).flatMap(v => Object.keys(v)))].sort()
    for (const m of [...all, ym(Date.now())]) {
      const p = prevYm(m)
      const ranked = Object.entries(b.vols).map(([base, v]) => [base, v[p] || 0]).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, TOP).map(([base]) => base)
      if (ranked.length >= 10) months[m] = ranked
    }
    const saved = await rpc('lab_put', { sid: 'pit-universe', payload: { months, top: TOP, builtAt: Date.now(), pairs: b.symbols.length, delistedIncluded: true } })
    b = { complete: true, builtAt: Date.now(), coins: Object.keys(b.vols).length, months: Object.keys(months).length }
    await rpc('lab_put', { sid: 'pit-build', payload: b })
    return res.status(200).json({ complete: true, saved, ...b, ms: Date.now() - t0 })
  }
  await rpc('lab_put', { sid: 'pit-build', payload: b })
  res.status(200).json({ complete: false, done: b.done, of: b.symbols.length, failed, ms: Date.now() - t0 })
}
