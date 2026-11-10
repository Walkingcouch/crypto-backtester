import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import CompareChart, { type CompareLine } from '../components/CompareChart'
import CoinTable, { cls, MarketNotes, pctTxt } from '../components/CoinTable'
import { Info } from '../components/Info'
import WhereToBuy from '../components/WhereToBuy'
import { PERIODS, pricePath, type Period } from '../lib/markets'
import { rateAtSmooth } from '../lib/currency'
import { useCoinMarket } from '../lib/useCoinMarket'

const PALETTE = ['#0b7a5c', '#3b6fd8', '#d9822b', '#b5459b', '#2a9db5', '#c2412d', '#7b5ce0', '#8a8f2d']
const MAX_SELECT = 8

export default function Markets() {
  const [params, setParams] = useSearchParams()
  const selected = useMemo(() => (params.get('compare') || '').split(',').filter(Boolean), [params])
  const M = useCoinMarket({ keep: selected, initialPeriod: (params.get('period') as Period) || '30d' })
  const { cur, fx, period, coins, all, retIn, historyReady } = M
  const { listings, where } = M.listingsCtx
  const [lines, setLines] = useState<CompareLine[] | null>(null)
  const [chartErr, setChartErr] = useState<string | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  const colorOf = (base: string) => PALETTE[selected.indexOf(base) % PALETTE.length]
  function toggle(base: string) {
    const next = selected.includes(base) ? selected.filter(s => s !== base) : selected.length >= MAX_SELECT ? selected : [...selected, base]
    const p = new URLSearchParams(params)
    if (next.length) p.set('compare', next.join(',')); else p.delete('compare')
    setParams(p, { replace: true })
  }
  function choosePeriod(p: Period) {
    M.setPeriod(p)
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
  const up = all.filter(c => c.trend === 'up').length, down = all.filter(c => c.trend === 'down').length

  return (
    <main className="page">
      <div className="page-head">
        <h1>Markets</h1>
        <p>Every actively traded coin on Binance (USDT pairs), ranked by performance. Tick coins to compare them on one chart.</p>
        <MarketNotes M={M} />
      </div>

      {M.error && <div className="notice err">{M.error}</div>}

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
                  <WhereToBuy base={b} where={where(b)} known={listings?.ok ?? null} partial={listings?.partial} compact />
                  <Link to={`/predict?coin=${b}USDT`} className="small">Predict</Link>
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
        <CoinTable M={M} mode="compare" selected={selected} onRow={toggle} colorOf={colorOf} onPeriod={choosePeriod} />
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
