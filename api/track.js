// Called when someone opens a coin on the Predict page: adds it to the 5-hourly log and
// saves a forecast for it right away (once per hour at most). Public, but only accepts
// real Binance USDT pairs with enough history, and the list is capped in the database.
import { collect } from './_lib/chatter.js'
import { DEFAULT_COINS, HOUR, rowsFor, rpc } from './_lib/forecaster.js'

let chatterCache = null
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x')
  const symbol = (url.searchParams.get('coin') || '').toUpperCase()
  const name = (url.searchParams.get('name') || '').slice(0, 40)
  if (!/^[A-Z0-9]{2,15}USDT$/.test(symbol)) return res.status(400).json({ error: 'bad coin' })
  const base = symbol.replace(/USDT$/, '')
  try {
    if (!chatterCache || Date.now() - chatterCache.at > 15 * 60_000) chatterCache = { at: Date.now(), data: await collect() }
    const madeAt = Math.floor(Date.now() / HOUR) * HOUR
    const rows = await rowsFor(base, name || base, chatterCache.data, madeAt)   // throws if not a real, old-enough coin
    const isDefault = DEFAULT_COINS.some(([b]) => b === base)
    const tracked = isDefault ? 'default' : await rpc('track_coin', { symbol, name: name || base })
    const saved = await rpc('log_forecasts', { rows })
    res.status(200).json({ symbol, tracked, saved })
  } catch (e) {
    res.status(200).json({ symbol, tracked: false, error: String(e.message || e) })
  }
}
