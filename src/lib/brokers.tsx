/* The exchange ("broker") the person trades on. It sets the default fee, which coins
 * Markets shows, and, where the exchange publishes live prices, the prices shown.
 *
 * Fees are each exchange's published rate at the lowest volume tier, checked Oct–Nov 2026
 * (Finder AU reviews and exchange fee pages). Exchanges change fees, so the app always
 * lets people override them.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export interface FeeOption { label: string; fee: number; note?: string }
export interface Broker {
  id: string
  name: string
  fees: FeeOption[]
  livePrices?: boolean   // we can show this exchange's own live AUD prices
  site: string
}

export const BROKERS: Broker[] = [
  { id: 'coinspot', name: 'CoinSpot', site: 'https://www.coinspot.com.au', livePrices: true,
    fees: [{ label: 'Market / limit order', fee: 0.1 }, { label: 'Instant buy / sell', fee: 1.0, note: 'The quick "Buy" button' }] },
  { id: 'swyftx', name: 'Swyftx', site: 'https://swyftx.com',
    fees: [{ label: 'Standard trade', fee: 0.6 }] },
  { id: 'independentreserve', name: 'Independent Reserve', site: 'https://www.independentreserve.com',
    fees: [{ label: 'Standard trade', fee: 0.5 }] },
  { id: 'btcmarkets', name: 'BTC Markets', site: 'https://www.btcmarkets.net',
    fees: [{ label: 'AUD markets', fee: 0.85, note: 'Lowest volume tier' }] },
  { id: 'kraken', name: 'Kraken Pro', site: 'https://pro.kraken.com',
    fees: [{ label: 'Market order (taker)', fee: 0.4 }, { label: 'Limit order (maker)', fee: 0.25 }] },
  { id: 'binance', name: 'Binance', site: 'https://www.binance.com',
    fees: [{ label: 'Spot order', fee: 0.1 }] },
  { id: 'other', name: 'Other / custom', site: '',
    fees: [{ label: 'Exchange order', fee: 0.1 }, { label: 'App instant buy', fee: 1.0 }] },
]
export const brokerById = (id: string) => BROKERS.find(b => b.id === id) ?? BROKERS[0]

interface Ctx { broker: Broker; setBroker: (id: string) => void }
const BrokerCtx = createContext<Ctx>({ broker: BROKERS[0], setBroker: () => {} })

export function BrokerProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<string>(() => { try { return localStorage.getItem('cb.broker') || 'coinspot' } catch { return 'coinspot' } })
  const setBroker = (v: string) => { setId(v); try { localStorage.setItem('cb.broker', v) } catch { /* */ } }
  return <BrokerCtx.Provider value={{ broker: brokerById(id), setBroker }}>{children}</BrokerCtx.Provider>
}
export const useBroker = () => useContext(BrokerCtx)

// ---------- CoinSpot live prices (via our /api/coinspot proxy; CoinSpot's API has no CORS) ----------
export interface BrokerQuote { bid: number; ask: number; last: number }
export function useBrokerPrices(broker: Broker) {
  const [quotes, setQuotes] = useState<Map<string, BrokerQuote> | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setQuotes(null); setError(null)
    if (broker.id !== 'coinspot') return
    let alive = true
    const load = async () => {
      try {
        const r = await fetch('/api/coinspot')
        if (!r.ok) throw new Error(`CoinSpot prices unavailable (${r.status}).`)
        const j = await r.json()
        if (j.status !== 'ok' || !j.prices) throw new Error('CoinSpot returned no prices.')
        const m = new Map<string, BrokerQuote>()
        for (const [k, v] of Object.entries(j.prices as Record<string, { bid: string; ask: string; last: string }>)) {
          const q = { bid: +v.bid, ask: +v.ask, last: +v.last }
          if (q.last > 0) m.set(k.toUpperCase(), q)
        }
        if (alive) { setQuotes(m); setAt(Date.now()); setError(null) }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)) }
    }
    load()
    const t = window.setInterval(load, 60_000)
    return () => { alive = false; window.clearInterval(t) }
  }, [broker.id])
  return { quotes, at, error }
}
