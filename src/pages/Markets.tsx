import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import CompareChart, { type CompareLine } from '../components/CompareChart'
import { Info } from '../components/Info'
import { fmtPrice, fmtVol, loadHistory, loadTickers, PERIODS, pricePath, type Coin, type Period } from '../lib/markets'
import { BROKERS, useBroker, useBrokerPrices } from '../lib/brokers'
import { curSymbol, fxSeries, nowRate, rateAt, rateAtSmooth, useCurrency, type FxSeries } from '../lib/currency'

type SortKey = 'return' | 'riskAdj' | 'volume' | 'volatility'
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'return', label: 'Return' }, { id: 'riskAdj', label: 'Return ÷ risk' },
  { id: 'volume', label: 'Volume' }, { id: 'volatility', label: 'Volatility' },
]
const MIN_VOL = [{ v: 0, label: 'All' }, { v: 1e6, label: '1M+' }, { v: 1e7, label: '10M+' }, { v: 1e8, label: '100M+' }]
const DAY = 86_400_000
const PALETTE = ['#0b7a5c', '#3b6fd8', '#d9822b', '#b5459b', '#2a9db5', '#c2412d', '#7b5ce0', '#8a8f2d']
const MAX_SELECT = 8
const pctTxt = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
const cls = (x: number | null | undefined) => (x == null ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : '')

export default function Markets() {
  const [params, setParams] = useSearchParams()
  const [coins, setCoins] = useState<Map<string, Coin>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [period, setPeriod] = useState<Period>((params.get('period') as Period) || '30d')
  const [sortBy, setSortBy] = useState<SortKey>('return')
  const [asc, setAsc] = useState(false)
  const [minVol, setMinVol] = useState(1e6)
  const [trendFilter, setTrendFilter] = useState<'all' | 'up' | 'down'>('all')
  const [q, setQ] = useState('')
  const [minP, setMinP] = useState('')
  const [maxP, setMaxP] = useState('')
  const [showN, setShowN] = useState(100)
  const selected = useMemo(() => (params.get('compare') || '').split(',').filter(Boolean), [params])
  const [lines, setLines] = useState<CompareLine[] | null>(null)
  const [chartErr, setChartErr] = useState<string | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const { cur, live, error: fxError } = useCurrency()
  const rate = nowRate(cur, live)            // USDT -> display currency, right now
  const [fx, setFx] = useState<FxSeries | null>(null)   // daily USD->AUD history (for returns over time)
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
  const { broker, setBroker } = useBroker()
  const { quotes, at: quotesAt, error: quotesErr } = useBrokerPrices(broker)
  const [onlyBroker, setOnlyBroker] = useState(true)
  const quoteOf = (c: Coin) => quotes?.get(c.base) ?? null
  /** Price now in the display currency. On CoinSpot (AUD), use CoinSpot's own last price. */
  const priceIn = (c: Coin) => {
    const q = quoteOf(c)
    if (q && cur === 'AUD') return q.last
    if (q && cur === 'USD' && live?.rate) return q.last / live.rate
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
  const historyReady = progress && progress.done >= progress.total

  const rows = useMemo(() => {
    const term = q.trim().toUpperCase()
    const val = (c: Coin): number | null => {
      const r = retIn(c, period)
      switch (sortBy) {
        case 'return': return r ?? null
        // (volume and volatility don't depend on currency for ranking)
        case 'volume': return c.quoteVolume
        case 'volatility': return c.vol30 ?? null
        case 'riskAdj': return r != null && c.vol30 ? r / (c.vol30 * Math.sqrt((PERIODS.find(p => p.id === period)!.days) / 365)) : null
      }
    }
    return all
      .filter(c => c.quoteVolume * (rate ?? 1) >= minVol || selected.includes(c.base))
      .filter(c => !term || c.base.includes(term))
      .filter(c => !(broker.livePrices && onlyBroker && quotes) || quotes.has(c.base) || selected.includes(c.base))
      .filter(c => { const pr = priceIn(c); if (pr == null) return true; return (minP === '' || pr >= +minP) && (maxP === '' || pr <= +maxP) })
      .filter(c => trendFilter === 'all' || c.trend === trendFilter)
      .map(c => ({ c, v: val(c) }))
      .sort((a, b) => (a.v == null ? 1 : b.v == null ? -1 : asc ? a.v - b.v : b.v - a.v))
  }, [all, period, sortBy, asc, minVol, q, trendFilter, selected, minP, maxP, cur, rate, fx, quotes, onlyBroker, broker.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const colorOf = (base: string) => PALETTE[selected.indexOf(base) % PALETTE.length]

  function toggle(base: string) {
    const next = selected.includes(base) ? selected.filter(s => s !== base) : selected.length >= MAX_SELECT ? selected : [...selected, base]
    const p = new URLSearchParams(params)
    if (next.length) p.set('compare', next.join(',')); else p.delete('compare')
    setParams(p, { replace: true })
  }
  function choosePeriod(p: Period) {
    setPeriod(p)
    const sp = new URLSearchParams(params); sp.set('period', p); setParams(sp, { replace: true })
  }

  // comparison chart data
  useEffect(() => {
    if (!selected.length) { setLines(null); return }
    if (cur === 'AUD' && !fx) { setLines(null); return }
    let live = true
    setChartErr(null)
    Promise.all(selected.map(async (base, i) => {
      const path = await pricePath(base + 'USDT', period)
      const start = path.c[0]
      const conv = path.c.map((x, j) => (cur === 'AUD' && fx ? x * rateAtSmooth(fx, path.t[j]) : x))
      const s0 = conv[0] || start
      return { name: base, color: PALETTE[i % PALETTE.length], t: path.t, pct: conv.map(x => (x / s0 - 1) * 100) }
    })).then(l => { if (live) setLines(l) }).catch(e => { if (live) setChartErr(e.message) })
    return () => { live = false }
  }, [selected, period, cur, fx])

  const periodLabel = PERIODS.find(p => p.id === period)!.label
  const needsHistory = period !== '24h' || sortBy === 'volatility' || sortBy === 'riskAdj'
  const up = all.filter(c => c.trend === 'up').length, down = all.filter(c => c.trend === 'down').length

  return (
    <main className="page">
      <div className="page-head">
        <h1>Markets</h1>
        <p>Every actively traded coin on Binance (USDT pairs), ranked by performance. Tick coins to compare them on one chart.</p>
        <div className="broker-row">
          <label className="mini"><span>Your exchange</span>
            <select value={broker.id} onChange={e => setBroker(e.target.value)}>{BROKERS.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          {broker.livePrices && (
            <label className="toggle"><input type="checkbox" checked={onlyBroker} onChange={e => setOnlyBroker(e.target.checked)} /> Only coins on {broker.name}</label>
          )}
        </div>
        {broker.livePrices && (
          <div className="fx-note">
            {quotesErr ? <span className="neg">{quotesErr} Showing Binance prices instead.</span>
              : quotes ? <>Live prices from <b>{broker.name}</b> ({quotes.size} coins listed){quotesAt && <span className="muted">· updated {new Date(quotesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                <Info>Prices shown are {broker.name}'s last traded AUD price. Rankings over time use Binance's price history (converted to {cur}), since {broker.name} doesn't publish history. Coins on {broker.name} that Binance doesn't list can't be ranked.</Info></>
              : `Loading ${broker.name} prices…`}
          </div>
        )}
        {cur === 'AUD' && (
          <div className="fx-note">
            {fxError ? <span className="neg">{fxError} Showing USD values until it loads.</span>
              : live ? <>Prices in <b>AUD</b>: 1 USDT = A${live.rate.toFixed(4)} <span className="muted">· {live.source} · {new Date(live.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <Info>Current prices use the live USDT→AUD rate. Returns over time and the comparison chart use each day's ECB USD→AUD reference rate, so they include exchange-rate moves.</Info></>
              : 'Loading AUD exchange rate…'}
          </div>
        )}
      </div>

      {error && <div className="notice err">{error}</div>}

      {all.length > 0 && (
        <div className="market-summary">
          <div className="ms"><span>Coins</span><b>{all.length}</b></div>
          <div className="ms"><span>Up today</span><b className="pos">{all.filter(c => (c.ret['24h'] ?? 0) > 0).length}</b></div>
          <div className="ms"><span>Uptrend <Info>Price above its 50-day average, and the 50-day above the 200-day. The same idea as the "Follow the trend" strategy.</Info></span><b className="pos">{historyReady ? up : '…'}</b></div>
          <div className="ms"><span>Downtrend</span><b className="neg">{historyReady ? down : '…'}</b></div>
        </div>
      )}

      {selected.length > 0 && (
        <section className="card compare" ref={chartRef}>
          <div className="card-title">
            <div><h2>Compare · {periodLabel}</h2><div className="small muted">Each line starts at 0%, so coins of any price compare fairly.</div></div>
            <button className="btn btn-ghost btn-sm" onClick={() => { const p = new URLSearchParams(params); p.delete('compare'); setParams(p, { replace: true }) }}>Clear</button>
          </div>
          <div className="seg period-seg">{PERIODS.map(p => <button key={p.id} className={period === p.id ? 'on' : ''} onClick={() => choosePeriod(p.id)}>{p.id}</button>)}</div>
          <div className="compare-legend">
            {selected.map(b => {
              const c = coins.get(b + 'USDT')
              return (
                <span key={b} className="cl-item">
                  <i style={{ background: colorOf(b) }} /><b>{b}</b>
                  <span className={cls(c ? retIn(c, period) : null)}>{pctTxt(c ? retIn(c, period) : null)}</span>
                  <Link to={`/?coin=${b}USDT`} className="small">Test</Link>
                  <button aria-label={`Remove ${b}`} onClick={() => toggle(b)}>×</button>
                </span>
              )
            })}
          </div>
          {chartErr ? <div className="notice err">{chartErr}</div> : lines ? <CompareChart lines={lines} intraday={period === '24h' || period === '7d'} /> : <div className="chart empty">Loading chart…</div>}
        </section>
      )}

      <section className="card">
        <div className="toolbar">
          <div className="seg period-seg">{PERIODS.map(p => <button key={p.id} className={period === p.id ? 'on' : ''} onClick={() => choosePeriod(p.id)}>{p.id}</button>)}</div>
          <input className="search" placeholder="Search coin, e.g. SOL" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="toolbar">
          <label className="mini"><span>Rank by</span>
            <select value={sortBy} onChange={e => { setSortBy(e.target.value as SortKey); setAsc(false) }}>
              {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select></label>
          <button className="btn btn-ghost btn-sm" onClick={() => setAsc(a => !a)} title="Flip order">{asc ? '↑ Lowest first' : '↓ Highest first'}</button>
          <label className="mini"><span>Min 24h volume</span>
            <select value={minVol} onChange={e => setMinVol(+e.target.value)}>{MIN_VOL.map(m => <option key={m.v} value={m.v}>{m.v ? sym + m.label : m.label}</option>)}</select></label>
          <label className="mini"><span>Trend</span>
            <select value={trendFilter} onChange={e => setTrendFilter(e.target.value as 'all' | 'up' | 'down')}>
              <option value="all">Any</option><option value="up">Uptrend only</option><option value="down">Downtrend only</option></select></label>
        </div>

        <div className="price-range">
          <label className="mini pr-field"><span>Min price ({cur})</span>
            <input type="number" inputMode="decimal" min={0} step="any" placeholder="e.g. 0.50" value={minP} onChange={e => setMinP(e.target.value)} /></label>
          <label className="mini pr-field"><span>Max price ({cur})</span>
            <input type="number" inputMode="decimal" min={0} step="any" placeholder="e.g. 20" value={maxP} onChange={e => setMaxP(e.target.value)} /></label>
          {(minP !== '' || maxP !== '') && <button className="btn btn-ghost btn-sm" onClick={() => { setMinP(''); setMaxP('') }}>Clear price range</button>}
          {minP !== '' && maxP !== '' && +minP > +maxP && <span className="hint neg" style={{ flexBasis: '100%' }}>Min price is above max price, so no coins can match.</span>}
        </div>

        {progress && !historyReady && needsHistory && (
          <div className="notice info small">
            Loading {periodLabel.toLowerCase()} history… {progress.done}/{progress.total} coins. Rankings fill in as it loads (biggest coins first).
            <div className="progress"><div style={{ width: `${(progress.done / progress.total) * 100}%`, animation: 'none' }} /></div>
          </div>
        )}
        {sortBy === 'riskAdj' && <p className="hint">Return ÷ risk = return over the period divided by how bumpy the coin has been. Higher means more reward per unit of risk.</p>}

        {!all.length && !error ? <div className="empty">Loading coins…</div> : (
          <div className="mkt">
            <div className="mkt-row mkt-head">
              <span /><span>#</span><span>Coin</span><span className="r">{quotes && broker.livePrices ? `${broker.name} (${sym})` : `Price (${sym})`}</span>
              <span className="r">{periodLabel}</span><span className="r hide-sm">Trend</span>
              <span className="r hide-sm">Volatility</span><span className="r hide-sm">24h vol</span><span className="hide-sm" />
            </div>
            {rows.slice(0, showN).map(({ c }, i) => {
              const on = selected.includes(c.base)
              const r = retIn(c, period)
              const pr = priceIn(c)
              return (
                <div key={c.symbol} className={`mkt-row ${on ? 'sel' : ''}`} onClick={() => toggle(c.base)}>
                  <span><span className="check" style={on ? { background: colorOf(c.base), borderColor: colorOf(c.base) } : undefined}>{on ? '✓' : ''}</span></span>
                  <span className="muted small">{i + 1}</span>
                  <span className="coin"><b>{c.base}</b><span className="small muted show-sm">{fmtVol(c.quoteVolume * (rate ?? 1), sym)}{c.trend && <TrendTag t={c.trend} />}</span></span>
                  <span className="r mono">{pr == null ? '…' : fmtPrice(pr)}</span>
                  <span className={`r ret ${cls(r)}`}>{r === undefined ? <span className="muted">…</span> : r === null ? <span className="muted small">new</span> : pctTxt(r)}</span>
                  <span className="r hide-sm">{c.trend ? <TrendTag t={c.trend} /> : <span className="muted">{c.historyDays ? '—' : '…'}</span>}</span>
                  <span className="r hide-sm">{c.vol30 != null ? `${(c.vol30 * 100).toFixed(0)}%` : '—'}</span>
                  <span className="r hide-sm">{fmtVol(c.quoteVolume * (rate ?? 1), sym)}</span>
                  <span className="hide-sm r"><Link to={`/?coin=${c.symbol}`} onClick={e => e.stopPropagation()} className="small">Backtest →</Link></span>
                </div>
              )
            })}
            {rows.length > showN && <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={() => setShowN(n => n + 100)}>Show more ({rows.length - showN} left)</button>}
            {rows.length === 0 && <div className="empty">No coins match these filters.</div>}
          </div>
        )}
        <p className="hint" style={{ marginTop: 12 }}>
          Prices from Binance, refreshed when you open the page. Tap a row to add it to the chart (up to {MAX_SELECT}). Past performance doesn't predict future returns.
        </p>
      </section>

      {selected.length > 0 && (
        <div className="compare-bar">
          <span className="small"><b>{selected.length}</b> selected</span>
          <span className="cb-dots">{selected.map(b => <i key={b} style={{ background: colorOf(b) }} title={b} />)}</span>
          <span className="spacer" />
          <button className="btn btn-primary btn-sm" onClick={() => chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>View chart</button>
        </div>
      )}
    </main>
  )
}

function TrendTag({ t }: { t: 'up' | 'down' | 'mixed' }) {
  return t === 'up' ? <span className="tag green">Up</span> : t === 'down' ? <span className="tag red">Down</span> : <span className="tag">Mixed</span>
}
