import { useEffect, useMemo, useState } from 'react'
import { loadHistory, loadTickers, PERIODS, type Coin, type Period } from './markets'
import { useBroker, useBrokerPrices, useListings } from './brokers'
import { curSymbol, fxSeries, nowRate, rateAt, useCurrency, type FxSeries } from './currency'

export type SortKey = 'return' | 'riskAdj' | 'volume' | 'volatility'
const DAY = 86_400_000

/** Everything the coin list needs: every active coin, ranking, filters, currency and exchange. */
export function useCoinMarket(opts: { keep?: string[]; initialPeriod?: Period; pageSize?: number } = {}) {
  const keep = opts.keep ?? []
  const [coins, setCoins] = useState<Map<string, Coin>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [period, setPeriod] = useState<Period>(opts.initialPeriod ?? '30d')
  const [sortBy, setSortBy] = useState<SortKey>('return')
  const [asc, setAsc] = useState(false)
  const [minVol, setMinVol] = useState(1e6)
  const [trendFilter, setTrendFilter] = useState<'all' | 'up' | 'down'>('all')
  const [q, setQ] = useState('')
  const [minP, setMinP] = useState('')
  const [maxP, setMaxP] = useState('')
  const [showN, setShowN] = useState(opts.pageSize ?? 100)

  const currency = useCurrency()
  const { cur, live } = currency
  const rate = nowRate(cur, live)            // USDT -> display currency, right now
  const [fx, setFx] = useState<FxSeries | null>(null)
  useEffect(() => {
    if (cur !== 'AUD' || fx) return
    fxSeries(Date.now() - 400 * DAY).then(setFx).catch(() => setFx(null))
  }, [cur, fx])
  const sym = curSymbol(cur)

  /** Return over a period in the display currency: coin move × exchange-rate move. */
  const retIn = (c: Coin, p: Period): number | null | undefined => {
    const r = c.ret[p]
    if (r == null || cur === 'USD') return r
    if (!fx) return undefined
    const days = PERIODS.find(x => x.id === p)!.days
    const now = Date.now()
    return (1 + r) * (rateAt(fx, now) / rateAt(fx, now - days * DAY)) - 1
  }

  const brokerCtx = useBroker()
  const { broker } = brokerCtx
  const brokerPrices = useBrokerPrices(broker)
  const { quotes } = brokerPrices
  const [onlyBroker, setOnlyBroker] = useState(false)
  const listingsCtx = useListings()
  const { listings, where } = listingsCtx
  const canFilterBroker = !!listings && listings.ok.has(broker.id)
  /** Price now in the display currency. On CoinSpot (AUD), use CoinSpot's own last price. */
  const priceIn = (c: Coin) => {
    const qt = quotes?.get(c.base) ?? null
    if (qt && cur === 'AUD') return qt.last
    if (qt && cur === 'USD' && live?.rate) return qt.last / live.rate
    return rate == null ? null : c.price * rate
  }

  // 1) all tickers (fast) 2) daily history for each coin in the background, biggest first
  useEffect(() => {
    const signal = { cancelled: false }
    loadTickers().then(list => {
      if (signal.cancelled) return
      setCoins(new Map(list.map(c => [c.symbol, c])))
      const order = [...list].sort((a, b) => b.quoteVolume - a.quoteVolume)
      setProgress({ done: 0, total: order.length })
      let pending: Coin[] = []
      const flush = () => { if (!pending.length) return; const batch = pending; pending = []; setCoins(m => { const n = new Map(m); batch.forEach(c => n.set(c.symbol, c)); return n }) }
      const timer = window.setInterval(flush, 400)
      loadHistory(order, (c, done) => { pending.push(c); setProgress({ done, total: order.length }) }, signal)
        .finally(() => { window.clearInterval(timer); flush() })
    }).catch(e => setError(e instanceof Error ? e.message : String(e)))
    return () => { signal.cancelled = true }
  }, [])

  const all = useMemo(() => [...coins.values()], [coins])
  const historyReady = !!progress && progress.done >= progress.total
  const keepKey = keep.join(',')

  const rows = useMemo(() => {
    const term = q.trim().toUpperCase()
    const val = (c: Coin): number | null => {
      const r = retIn(c, period)
      switch (sortBy) {
        case 'return': return r ?? null
        case 'volume': return c.quoteVolume
        case 'volatility': return c.vol30 ?? null
        case 'riskAdj': return r != null && c.vol30 ? r / (c.vol30 * Math.sqrt((PERIODS.find(p => p.id === period)!.days) / 365)) : null
      }
    }
    return all
      .filter(c => c.quoteVolume * (rate ?? 1) >= minVol || keep.includes(c.base))
      .filter(c => !term || c.base.includes(term))
      .filter(c => !(onlyBroker && canFilterBroker) || where(c.base).includes(broker.id) || keep.includes(c.base))
      .filter(c => { const pr = priceIn(c); if (pr == null) return true; return (minP === '' || pr >= +minP) && (maxP === '' || pr <= +maxP) })
      .filter(c => trendFilter === 'all' || c.trend === trendFilter)
      .map(c => ({ c, v: val(c) }))
      .sort((a, b) => (a.v == null ? 1 : b.v == null ? -1 : asc ? a.v - b.v : b.v - a.v))
  }, [all, period, sortBy, asc, minVol, q, trendFilter, keepKey, minP, maxP, cur, rate, fx, quotes, onlyBroker, broker.id, listings]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    coins, all, rows, error, progress, historyReady,
    period, setPeriod, sortBy, setSortBy, asc, setAsc, minVol, setMinVol, trendFilter, setTrendFilter,
    q, setQ, minP, setMinP, maxP, setMaxP, showN, setShowN, onlyBroker, setOnlyBroker, canFilterBroker,
    cur, rate, sym, fx, retIn, priceIn, currency, brokerCtx, brokerPrices, listingsCtx,
  }
}
export type CoinMarket = ReturnType<typeof useCoinMarket>
