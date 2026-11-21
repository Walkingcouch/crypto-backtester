// Vercel serverless function: relays CoinSpot's public price feeds (AUD) to the browser.
// CoinSpot's API doesn't allow browser (CORS) requests, so the site calls this instead.
// Public data only, no keys. Cached briefly at Vercel's edge.
//   /api/coinspot            -> all latest prices (v2 feed)
//   /api/coinspot?feed=v1    -> legacy all-prices feed
//   /api/coinspot?coin=xlm   -> one coin's latest price
const BASE = 'https://www.coinspot.com.au/pubapi'

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x')
  const coin = (url.searchParams.get('coin') || '').toLowerCase()
  const feed = url.searchParams.get('feed')
  let target = `${BASE}/v2/latest`
  if (coin) {
    if (!/^[a-z0-9]{1,15}$/.test(coin)) return res.status(400).json({ status: 'error', message: 'bad coin' })
    target = `${BASE}/v2/latest/${coin}`
  } else if (feed === 'v1') target = `${BASE}/latest`

  const check = (url.searchParams.get('check') || '').toLowerCase()
  if (/^[a-z0-9]{1,15}$/.test(check)) {             // which public CoinSpot sources know this coin
    const out = {}
    for (const [k, u] of Object.entries({ latest: `${BASE}/v2/latest/${check}`, buyprice: `${BASE}/v2/buyprice/${check}`, sellprice: `${BASE}/v2/sellprice/${check}`, page: `https://www.coinspot.com.au/buy/${check}` })) {
      try { const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': 'crypto-backtester' } }); out[k] = { status: r.status, loc: r.headers.get('location'), body: (await r.text()).slice(0, 160) } } catch (e) { out[k] = String(e) }
    }
    return res.status(200).json(out)
  }
  try {
    const r = await fetch(target, { headers: { accept: 'application/json', 'user-agent': 'crypto-backtester' } })
    const text = await r.text()
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=60')
    res.status(r.ok ? 200 : 502).send(r.ok ? text : JSON.stringify({ status: 'error', message: `CoinSpot responded ${r.status}` }))
  } catch (e) {
    res.status(502).json({ status: 'error', message: String(e) })
  }
}
