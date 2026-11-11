// Daily history for coins Binance has DELISTED (crashed, shut down or renamed), from
// Binance's public data archive (data.binance.vision). Used by Picks' "include delisted coins"
// toggle to reduce survivorship bias. Heavy (hundreds of small zip files), so cached 30 days.
import { inflateRawSync } from 'node:zlib'

const S3 = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision'
const FILES = 'https://data.binance.vision'
const API = 'https://data-api.binance.vision/api/v3'

// Coins that were large or heavily traded on Binance at some point since 2019 and are no longer
// listed there (crashes, exchange collapses, scandals, migrations / ticker changes). Any that
// still trade today are dropped automatically.
const CANDIDATES = [
  'LUNA', 'BTT', 'NPXS', 'BCHSV', 'BCHABC', 'SRM', 'FTT', 'WAVES', 'OMG', 'XEM', 'MULTI', 'ANC', 'MITH', 'HNT',
  'BTS', 'COCOS', 'AGIX', 'OCEAN', 'MATIC', 'FTM', 'RNDR', 'EOS', 'MKR', 'XMR', 'KLAY', 'LOOM', 'TORN', 'DREP',
  'ERD', 'LEND', 'STRAT', 'XZC', 'MCO', 'BZRX', 'TOMO', 'GTO', 'REN', 'VGX', 'BNX', 'ANT', 'MDX', 'BOND', 'KEEP',
  'NU', 'RAY', 'AKRO', 'UNFI', 'WNXM', 'CVP', 'BTCST', 'EPS', 'AUTO', 'GAL', 'MOB', 'STMX', 'ELF', 'DOCK', 'WTC',
  'NEBL', 'LINA', 'KEY', 'TROY', 'POLS', 'OOKI', 'CTXC', 'REEF', 'BLZ', 'AMB', 'FOR', 'FRONT', 'IRIS', 'PERL',
  'BEAM', 'VIDT', 'YFII', 'SNM', 'PNT', 'GLMR', 'WRX', 'ALPACA', 'XVG', 'VITE', 'DGB', 'SC', 'BAL', 'PDA',
]
const MAX_MONTHS = 100

async function text(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'crypto-backtester' } })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.text()
}

/** Months available for a symbol's daily klines in the archive (newest data last). */
async function months(sym) {
  const xml = await text(`${S3}?delimiter=/&prefix=data/spot/monthly/klines/${sym}/1d/`)
  return [...xml.matchAll(/<Key>([^<]+\.zip)<\/Key>/g)].map(m => m[1]).sort()
}

/** Extract the single CSV from a Binance archive zip (uses the central directory). */
function unzipOne(buf) {
  let e = buf.length - 22
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--
  if (e < 0) throw new Error('not a zip')
  const cd = buf.readUInt32LE(e + 16)
  const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42)
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
  const data = buf.subarray(start, start + size)
  return (method === 0 ? data : inflateRawSync(data)).toString('utf8')
}

async function rows(key) {
  const r = await fetch(`${FILES}/${key}`, { headers: { 'user-agent': 'crypto-backtester' } })
  if (!r.ok) throw new Error(`${r.status} ${key}`)
  const csv = unzipOne(Buffer.from(await r.arrayBuffer()))
  const out = []
  for (const line of csv.split('\n')) {
    const f = line.split(',')
    let t = +f[0]
    if (!Number.isFinite(t) || f.length < 8) continue          // header row
    if (t > 1e14) t = Math.floor(t / 1000)                       // newer files use microseconds
    out.push([t, +f[4], +f[7]])                                  // time, close, quote volume
  }
  return out
}

const errors = []
async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const k = next++; try { out[k] = await fn(items[k]) } catch (e) { out[k] = null; if (errors.length < 5) errors.push(String(e && e.message || e).slice(0, 200)) } }
  }))
  return out
}

export default async function handler(req, res) {
  const t0 = Date.now()
  try {
    const live = new Set((await (await fetch(`${API}/ticker/price`)).json()).map(t => t.symbol))
    const syms = CANDIDATES.map(b => b + 'USDT').filter(s => !live.has(s))
    const lists = await pool(syms, 16, months)
    const jobs = []
    syms.forEach((s, i) => (lists[i] || []).filter(k => k >= `data/spot/monthly/klines/${s}/1d/${s}-1d-2019-01`).slice(-MAX_MONTHS).forEach(k => jobs.push([s, k])))
    const got = await pool(jobs, 24, ([, k]) => rows(k))
    const bySym = new Map()
    jobs.forEach(([s], i) => { if (got[i]) bySym.set(s, (bySym.get(s) || []).concat(got[i])) })
    const coins = [...bySym].map(([s, r]) => ({ base: s.slice(0, -4), rows: r.sort((a, b) => a[0] - b[0]) }))
      .filter(c => c.rows.length >= 30)
      .map(c => ({ ...c, from: new Date(c.rows[0][0]).toISOString().slice(0, 10), to: new Date(c.rows[c.rows.length - 1][0]).toISOString().slice(0, 10) }))
    res.setHeader('content-type', 'application/json')
    // only cache a good result for long; an empty one (archive unreachable) is retried soon
    res.setHeader('cache-control', coins.length ? 'public, s-maxage=2592000, stale-while-revalidate=2592000' : 'no-store')
    const q = new URL(req.url, 'http://x').searchParams
    if (q.get('summary') === '1') return res.status(200).send(JSON.stringify({ ms: Date.now() - t0, files: jobs.length, checked: syms.length, errors, coins: coins.map(c => `${c.base} ${c.from}→${c.to} (${c.rows.length}d)`) }))
    res.status(200).send(JSON.stringify({ updated: new Date().toISOString(), ms: Date.now() - t0, coins }))
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
