// Vercel serverless function: which coins each exchange lists, from their public APIs.
// Returns { updated, exchanges: { id: { ok, coins: ["BTC", ...], error? } } }.
// Cached for an hour at Vercel's edge; each exchange fails independently.

// Exchange-specific tickers -> the common ticker
const ALIAS = { XBT: 'BTC', XXBT: 'BTC', XDG: 'DOGE', XXDG: 'DOGE', STR: 'XLM', XETH: 'ETH', XXRP: 'XRP', XLTC: 'LTC', XXLM: 'XLM', XETC: 'ETC', XZEC: 'ZEC', XXMR: 'XMR', XREP: 'REP', XMLN: 'MLN' }
const norm = c => { const u = String(c || '').toUpperCase().trim(); return ALIAS[u] || u }
const FIAT = new Set(['AUD', 'USD', 'EUR', 'GBP', 'CAD', 'JPY', 'CHF', 'NZD', 'SGD'])

async function getJSON(url, ms = 8000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'crypto-backtester' }, signal: ctl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally { clearTimeout(t) }
}

const SOURCES = {
  async coinspot() {
    const out = new Set()
    for (const u of ['https://www.coinspot.com.au/pubapi/latest', 'https://www.coinspot.com.au/pubapi/v2/latest']) {
      try {
        const j = await getJSON(u)
        for (const k of Object.keys(j.prices || {})) if (!k.includes('_')) out.add(norm(k))
      } catch { /* try the other feed */ }
    }
    if (!out.size) throw new Error('no data')
    return out
  },
  async swyftx() {
    const j = await getJSON('https://api.swyftx.com.au/markets/assets/')
    return new Set((Array.isArray(j) ? j : []).filter(a => a && a.code && a.tradable !== 0 && a.tradable !== false).map(a => norm(a.code)))
  },
  async independentreserve() {
    const j = await getJSON('https://api.independentreserve.com/Public/GetValidPrimaryCurrencyCodes')
    return new Set((Array.isArray(j) ? j : []).map(norm))
  },
  async btcmarkets() {
    const j = await getJSON('https://api.btcmarkets.net/v3/markets')
    return new Set((Array.isArray(j) ? j : []).filter(m => m.status !== 'Offline').map(m => norm(m.baseAssetName)))
  },
  async kraken() {
    const j = await getJSON('https://api.kraken.com/0/public/AssetPairs')
    const out = new Set()
    for (const p of Object.values(j.result || {})) {
      if (p.status && p.status !== 'online') continue
      const base = (p.wsname || '').split('/')[0] || p.base
      if (base) out.add(norm(base))
    }
    return out
  },
}

export default async function handler(req, res) {
  const entries = await Promise.all(Object.entries(SOURCES).map(async ([id, fn]) => {
    try {
      const set = await fn()
      const coins = [...set].filter(c => c && !FIAT.has(c)).sort()
      // CoinSpot's public feed only covers its older coins, so a missing coin may still be listed
      return [id, { ok: coins.length > 0, coins, partial: id === 'coinspot' }]
    } catch (e) {
      return [id, { ok: false, coins: [], error: String(e && e.message || e) }]
    }
  }))
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400')
  res.status(200).send(JSON.stringify({ updated: new Date().toISOString(), exchanges: Object.fromEntries(entries) }))
}
