/* Display currency (USD or AUD) and exchange rates.
 *
 * Prices come from Binance in USDT. To show them in AUD accurately:
 *  - "now" values (prices, volumes) use the live USDT→AUD rate from CoinGecko,
 *    falling back to the latest ECB USD→AUD reference rate (Frankfurter).
 *  - anything over time (backtests, returns, comparison charts) uses the ECB daily
 *    USD→AUD rate for each day, so AUD returns include exchange-rate moves.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Cur = 'USD' | 'AUD'
const DAY = 86_400_000

let displayCur: Cur = 'USD'
export const currentCur = () => displayCur

export interface LiveRate { rate: number; source: string; at: number }
interface Ctx { cur: Cur; setCur: (c: Cur) => void; live: LiveRate | null; error: string | null }
const CurrencyCtx = createContext<Ctx>({ cur: 'USD', setCur: () => {}, live: null, error: null })

function defaultCur(): Cur {
  try {
    const saved = localStorage.getItem('cb.cur')
    if (saved === 'USD' || saved === 'AUD') return saved
  } catch { /* storage off */ }
  try { if (Intl.DateTimeFormat().resolvedOptions().timeZone.startsWith('Australia/')) return 'AUD' } catch { /* */ }
  return 'USD'
}

async function fetchLiveRate(): Promise<LiveRate> {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=aud')
    if (r.ok) {
      const j = await r.json()
      const rate = Number(j?.tether?.aud)
      if (rate > 0.5 && rate < 5) return { rate, source: 'CoinGecko (USDT→AUD, live)', at: Date.now() }
    }
  } catch { /* fall through */ }
  const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD')
  if (!r.ok) throw new Error('Could not load the AUD exchange rate.')
  const j = await r.json()
  const rate = Number(j?.rates?.AUD)
  if (!(rate > 0)) throw new Error('Exchange-rate service returned no AUD rate.')
  return { rate, source: `ECB reference rate (${j.date})`, at: Date.now() }
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [cur, setCurState] = useState<Cur>(defaultCur)
  const [live, setLive] = useState<LiveRate | null>(null)
  const [error, setError] = useState<string | null>(null)
  displayCur = cur

  const setCur = (c: Cur) => {
    displayCur = c
    setCurState(c)
    try { localStorage.setItem('cb.cur', c) } catch { /* */ }
  }

  useEffect(() => {
    if (cur !== 'AUD') return
    let alive = true
    const load = () => fetchLiveRate().then(r => { if (alive) { setLive(r); setError(null) } }).catch(e => alive && setError(e.message))
    load()
    const id = window.setInterval(load, 5 * 60_000)
    return () => { alive = false; window.clearInterval(id) }
  }, [cur])

  return <CurrencyCtx.Provider value={{ cur, setCur, live, error }}>{children}</CurrencyCtx.Provider>
}

export const useCurrency = () => useContext(CurrencyCtx)

/** Multiplier from USDT to the display currency right now (1 for USD). */
export function nowRate(cur: Cur, live: LiveRate | null): number | null {
  if (cur === 'USD') return 1
  return live?.rate ?? null
}

// ---------- historical daily USD→AUD (ECB via Frankfurter) ----------

export interface FxSeries { days: number[]; rates: number[] } // sorted UTC-midnight timestamps
const seriesCache = new Map<string, Promise<FxSeries>>()

export function fxSeries(fromMs: number, toMs: number = Date.now()): Promise<FxSeries> {
  const from = new Date(fromMs - 7 * DAY).toISOString().slice(0, 10) // a week of slack for weekends/holidays
  const to = new Date(toMs).toISOString().slice(0, 10)
  const key = `${from}|${to}`
  if (!seriesCache.has(key)) {
    seriesCache.set(key, (async () => {
      const r = await fetch(`https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=AUD`)
      if (!r.ok) throw new Error(`Could not load historical AUD rates (${r.status}).`)
      const j = await r.json()
      const entries = Object.entries(j.rates as Record<string, { AUD: number }>)
        .map(([d, v]) => [Date.parse(d + 'T00:00:00Z'), v.AUD] as [number, number])
        .filter(([, v]) => v > 0)
        .sort((a, b) => a[0] - b[0])
      if (!entries.length) throw new Error('No historical AUD rates returned.')
      return { days: entries.map(e => e[0]), rates: entries.map(e => e[1]) }
    })())
    seriesCache.get(key)!.catch(() => seriesCache.delete(key))
  }
  return seriesCache.get(key)!
}

/** Rate in force at time t: the latest published rate on or before t (ECB publishes on business days). */
export function rateAt(s: FxSeries, t: number): number {
  let lo = 0, hi = s.days.length - 1
  if (t <= s.days[0]) return s.rates[0]
  if (t >= s.days[hi]) return s.rates[hi]
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (s.days[mid] <= t) lo = mid; else hi = mid - 1
  }
  return s.rates[lo]
}

/** Smooth rate for intraday charts: linear between published daily rates. */
export function rateAtSmooth(s: FxSeries, t: number): number {
  const n = s.days.length
  if (t <= s.days[0]) return s.rates[0]
  if (t >= s.days[n - 1]) return s.rates[n - 1]
  let i = 0
  while (i < n - 1 && s.days[i + 1] <= t) i++
  const f = (t - s.days[i]) / (s.days[i + 1] - s.days[i])
  return s.rates[i] * (1 - f) + s.rates[i + 1] * f
}

// ---------- formatting ----------
export function fmtMoney(x: number, cur: Cur = displayCur, digits = 2) {
  if (!Number.isFinite(x)) return '–'
  return x.toLocaleString('en-US', { style: 'currency', currency: cur, maximumFractionDigits: digits, minimumFractionDigits: digits === 0 ? 0 : undefined })
}
export const curSymbol = (cur: Cur = displayCur) => (cur === 'AUD' ? 'A$' : '$')
