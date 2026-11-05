// Vercel serverless function: relays CoinSpot's public latest-prices feed (AUD) to the
// browser. CoinSpot's API doesn't allow browser (CORS) requests, so the site calls this.
// Public data only, no keys. Cached for 30 seconds at Vercel's edge.
export default async function handler(req, res) {
  try {
    const r = await fetch('https://www.coinspot.com.au/pubapi/v2/latest', {
      headers: { accept: 'application/json', 'user-agent': 'crypto-backtester' },
    })
    const text = await r.text()
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=60')
    res.status(r.ok ? 200 : 502).send(r.ok ? text : JSON.stringify({ status: 'error', message: `CoinSpot responded ${r.status}` }))
  } catch (e) {
    res.status(502).json({ status: 'error', message: String(e) })
  }
}
