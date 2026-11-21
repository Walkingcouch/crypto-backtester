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
  // CoinSpot's price feeds only cover its older coins. Its public buyprice endpoint answers
  // "Coin not found" for coins it doesn't sell and something else ("Not available at present", or a
  // price) for coins it does, so every Binance coin missing from the feeds is checked there.
  async coinspot() {
    const out = new Set()
    for (const u of ['https://www.coinspot.com.au/pubapi/latest', 'https://www.coinspot.com.au/pubapi/v2/latest']) {
      try {
        const j = await getJSON(u)
        for (const k of Object.keys(j.prices || {})) if (!k.includes('_')) out.add(norm(k))
      } catch { /* try the other feed */ }
    }
    if (!out.size) throw new Error('no data')
    let todo = []
    try {
      const t = await getJSON('https://data-api.binance.vision/api/v3/ticker/price')
      todo = [...new Set(t.map(x => x.symbol).filter(s => s.endsWith('USDT')).map(s => s.slice(0, -4)))].filter(b => /^[A-Z0-9]{2,12}$/.test(b) && !out.has(b))
    } catch { return { set: out, partial: true } }
    const listed = async b => {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5000)
      try {
        const r = await fetch(`https://www.coinspot.com.au/pubapi/v2/buyprice/${b.toLowerCase()}`, { headers: { 'user-agent': 'crypto-backtester' }, signal: ctl.signal })
        const j = await r.json().catch(() => ({}))
        if (r.ok && j.status === 'ok') return true
        if (/coin not found/i.test(j.message || '')) return false
        if (/not available/i.test(j.message || '')) return true
        return null                                   // rate-limited or unclear
      } catch { return null } finally { clearTimeout(timer) }
    }
    let unsure = 0
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      const again = []
      for (let i = 0; i < todo.length; i += 25) {
        const batch = todo.slice(i, i + 25)
        const res = await Promise.all(batch.map(listed))
        batch.forEach((b, j) => { if (res[j] === true) out.add(b); else if (res[j] === null) again.push(b) })
      }
      todo = again
    }
    unsure = todo.length
    return { set: out, partial: unsure > 0, unsure: todo }
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
  async coinbase() {
    const j = await getJSON('https://api.exchange.coinbase.com/products')
    return new Set((Array.isArray(j) ? j : []).filter(p => p && p.status === 'online' && !p.trading_disabled).map(p => norm(p.base_currency)))
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
      const got = await fn()
      const set = got instanceof Set ? got : got.set
      const coins = [...set].filter(c => c && !FIAT.has(c)).sort()
      return [id, { ok: coins.length > 0, coins, partial: !(got instanceof Set) && !!got.partial, ...(got.unsure?.length ? { unsure: got.unsure } : {}) }]
    } catch (e) {
      return [id, { ok: false, coins: [], error: String(e && e.message || e) }]
    }
  }))
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400')
  res.status(200).send(JSON.stringify({ updated: new Date().toISOString(), exchanges: Object.fromEntries(entries) }))
}
