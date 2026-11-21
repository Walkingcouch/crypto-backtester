// Temporary: does Binance still serve history for delisted coins? (removed after checking)
export default async function handler(req, res) {
  const out = {}
  try {
    const info = await (await fetch('https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT')).json()
    const usdt = (info.symbols || []).filter(s => s.quoteAsset === 'USDT')
    out.status = usdt.reduce((m, s) => ((m[s.status] = (m[s.status] || 0) + 1), m), {})
    out.breakSample = usdt.filter(s => s.status !== 'TRADING').slice(0, 40).map(s => s.baseAsset)
  } catch (e) { out.infoError = String(e) }
  for (const sym of ['LUNAUSDT', 'FTTUSDT', 'SRMUSDT', 'XMRUSDT', 'MATICUSDT']) {
    try {
      const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1d&limit=3&endTime=${Date.UTC(2022, 3, 1)}`)
      out[sym] = { status: r.status, body: (await r.text()).slice(0, 160) }
    } catch (e) { out[sym] = String(e) }
  }
  try {
    const r = await fetch('https://data.binance.vision/data/spot/monthly/klines/LUNAUSDT/1d/LUNAUSDT-1d-2022-03.zip')
    out.archive = { status: r.status, bytes: (await r.arrayBuffer()).byteLength }
  } catch (e) { out.archive = String(e) }
  res.setHeader('cache-control', 'no-store')
  res.status(200).json(out)
}
