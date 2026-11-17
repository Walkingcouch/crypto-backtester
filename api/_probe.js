export default async function handler(req, res) {
  const out = {}
  for (const s of ['SPY', 'BHP.AX']) {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=730d&interval=1h`, { headers: { 'user-agent': 'Mozilla/5.0' } })
    const j = await r.json(); const x = j.chart.result[0]
    const ts = x.timestamp, off = x.meta.gmtoffset
    const last = ts.slice(-16).map(t => new Date((t + off) * 1000).toISOString().slice(0, 16))
    out[s] = { n: ts.length, first: new Date(ts[0] * 1000).toISOString(), lastLocal: last, period: x.meta.currentTradingPeriod.regular, price: x.meta.regularMarketPrice, gran: x.meta.dataGranularity }
  }
  res.json(out)
}
