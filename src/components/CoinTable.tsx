import { Link } from 'react-router-dom'
import { Info } from './Info'
import WhereToBuy from './WhereToBuy'
import { BROKERS } from '../lib/brokers'
import { fmtPrice, fmtVol, PERIODS, type Period } from '../lib/markets'
import type { CoinMarket, SortKey } from '../lib/useCoinMarket'

const SORTS: { id: SortKey; label: string }[] = [
  { id: 'return', label: 'Return' }, { id: 'riskAdj', label: 'Return ÷ risk' },
  { id: 'volume', label: 'Volume' }, { id: 'volatility', label: 'Volatility' },
]
const MIN_VOL = [{ v: 0, label: 'All' }, { v: 1e6, label: '1M+' }, { v: 1e7, label: '10M+' }, { v: 1e8, label: '100M+' }]
export const pctTxt = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
export const cls = (x: number | null | undefined) => (x == null ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : '')

export function TrendTag({ t }: { t: 'up' | 'down' | 'mixed' }) {
  return t === 'up' ? <span className="tag green">Up</span> : t === 'down' ? <span className="tag red">Down</span> : <span className="tag">Mixed</span>
}

/** Exchange picker and the live-price / AUD notes shown above the coin list. */
export function MarketNotes({ M }: { M: CoinMarket }) {
  const { broker, setBroker } = M.brokerCtx
  const { quotes, at: quotesAt, error: quotesErr } = M.brokerPrices
  const { cur, live, error: fxError } = M.currency
  return (
    <>
      <div className="broker-row">
        <label className="mini"><span>Your exchange</span>
          <select value={broker.id} onChange={e => setBroker(e.target.value)}>{BROKERS.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        {M.canFilterBroker && (
          <label className="toggle"><input type="checkbox" checked={M.onlyBroker} onChange={e => M.setOnlyBroker(e.target.checked)} /> Only coins on {broker.name}</label>
        )}
      </div>
      {broker.livePrices && (
        <div className="fx-note">
          {quotesErr ? <span className="neg">{quotesErr} Showing Binance prices instead.</span>
            : quotes ? <>Live prices from <b>{broker.name}</b> where available{quotesAt && <span className="muted">· updated {new Date(quotesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
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
    </>
  )
}

/**
 * The ranked, filterable list of every coin.
 * mode "compare": tick several (Markets). mode "pick": choose one (Predictions).
 */
export default function CoinTable({ M, mode, selected, onRow, colorOf, onPeriod }: {
  M: CoinMarket; mode: 'compare' | 'pick'; selected: string[]; onRow: (base: string) => void
  colorOf?: (base: string) => string; onPeriod?: (p: Period) => void
}) {
  const { broker } = M.brokerCtx
  const { quotes } = M.brokerPrices
  const { listings, where } = M.listingsCtx
  const period = M.period
  const periodLabel = PERIODS.find(p => p.id === period)!.label
  const needsHistory = period !== '24h' || M.sortBy === 'volatility' || M.sortBy === 'riskAdj'
  const choosePeriod = (p: Period) => { M.setPeriod(p); onPeriod?.(p) }
  const shown = M.showN

  return (
    <>
      <div className="toolbar">
        <div className="seg period-seg">{PERIODS.map(p => <button key={p.id} className={period === p.id ? 'on' : ''} onClick={() => choosePeriod(p.id)}>{p.id}</button>)}</div>
        <input className="search" placeholder="Search coin, e.g. SOL" value={M.q} onChange={e => M.setQ(e.target.value)} />
      </div>
      <div className="toolbar">
        <label className="mini"><span>Rank by</span>
          <select value={M.sortBy} onChange={e => { M.setSortBy(e.target.value as SortKey); M.setAsc(false) }}>
            {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select></label>
        <button className="btn btn-ghost btn-sm" onClick={() => M.setAsc(a => !a)} title="Flip order">{M.asc ? '↑ Lowest first' : '↓ Highest first'}</button>
        <label className="mini"><span>Min 24h volume</span>
          <select value={M.minVol} onChange={e => M.setMinVol(+e.target.value)}>{MIN_VOL.map(m => <option key={m.v} value={m.v}>{m.v ? M.sym + m.label : m.label}</option>)}</select></label>
        <label className="mini"><span>Trend</span>
          <select value={M.trendFilter} onChange={e => M.setTrendFilter(e.target.value as 'all' | 'up' | 'down')}>
            <option value="all">Any</option><option value="up">Uptrend only</option><option value="down">Downtrend only</option></select></label>
      </div>

      <div className="price-range">
        <label className="mini pr-field"><span>Min price ({M.cur})</span>
          <input type="number" inputMode="decimal" min={0} step="any" placeholder="e.g. 0.50" value={M.minP} onChange={e => M.setMinP(e.target.value)} /></label>
        <label className="mini pr-field"><span>Max price ({M.cur})</span>
          <input type="number" inputMode="decimal" min={0} step="any" placeholder="e.g. 20" value={M.maxP} onChange={e => M.setMaxP(e.target.value)} /></label>
        {(M.minP !== '' || M.maxP !== '') && <button className="btn btn-ghost btn-sm" onClick={() => { M.setMinP(''); M.setMaxP('') }}>Clear price range</button>}
        {M.minP !== '' && M.maxP !== '' && +M.minP > +M.maxP && <span className="hint neg" style={{ flexBasis: '100%' }}>Min price is above max price, so no coins can match.</span>}
      </div>

      {M.progress && !M.historyReady && needsHistory && (
        <div className="notice info small">
          Loading {periodLabel.toLowerCase()} history… {M.progress.done}/{M.progress.total} coins. Rankings fill in as it loads (biggest coins first).
          <div className="progress"><div style={{ width: `${(M.progress.done / M.progress.total) * 100}%`, animation: 'none' }} /></div>
        </div>
      )}
      {M.sortBy === 'riskAdj' && <p className="hint">Return ÷ risk = return over the period divided by how bumpy the coin has been. Higher means more reward per unit of risk.</p>}

      {!M.all.length && !M.error ? <div className="empty">Loading coins…</div> : (
        <div className="mkt">
          <div className="mkt-row mkt-head">
            <span /><span>#</span><span>Coin</span><span className="r">{quotes && broker.livePrices ? `${broker.name} (${M.sym})` : `Price (${M.sym})`}</span>
            <span className="r">{periodLabel}</span><span className="r hide-sm">Trend</span>
            <span className="r hide-sm">Volatility</span><span className="r hide-sm">24h vol</span><span className="hide-sm" />
          </div>
          {M.rows.slice(0, shown).map(({ c }, i) => {
            const on = selected.includes(c.base)
            const r = M.retIn(c, period)
            const pr = M.priceIn(c)
            const col = colorOf?.(c.base) ?? 'var(--accent)'
            return (
              <div key={c.symbol} className={`mkt-row ${on ? 'sel' : ''}`} onClick={() => onRow(c.base)}>
                <span>{mode === 'compare'
                  ? <span className="check" style={on ? { background: col, borderColor: col } : undefined}>{on ? '✓' : ''}</span>
                  : <span className={`radio-dot ${on ? 'on' : ''}`} />}</span>
                <span className="muted small">{i + 1}</span>
                <span className="coin"><span className="coin-top"><b>{c.base}</b><span className="hide-sm"><WhereToBuy base={c.base} where={where(c.base)} known={listings?.ok ?? null} partial={listings?.partial} /></span></span><span className="small muted show-sm">{fmtVol(c.quoteVolume * (M.rate ?? 1), M.sym)}{c.trend && <TrendTag t={c.trend} />}<WhereToBuy base={c.base} where={where(c.base)} known={listings?.ok ?? null} partial={listings?.partial} compact /></span></span>
                <span className="r mono">{pr == null ? '…' : fmtPrice(pr)}</span>
                <span className={`r ret ${cls(r)}`}>{r === undefined ? <span className="muted">…</span> : r === null ? <span className="muted small">new</span> : pctTxt(r)}</span>
                <span className="r hide-sm">{c.trend ? <TrendTag t={c.trend} /> : <span className="muted">{c.historyDays ? '—' : '…'}</span>}</span>
                <span className="r hide-sm">{c.vol30 != null ? `${(c.vol30 * 100).toFixed(0)}%` : '—'}</span>
                <span className="r hide-sm">{fmtVol(c.quoteVolume * (M.rate ?? 1), M.sym)}</span>
                <span className="hide-sm r row-links">
                  {mode === 'compare' && <Link to={`/predict?coin=${c.symbol}`} onClick={e => e.stopPropagation()} className="small">Predict</Link>}
                  <Link to={`/?coin=${c.symbol}`} onClick={e => e.stopPropagation()} className="small">Test</Link>
                </span>
              </div>
            )
          })}
          {M.rows.length > shown && <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={() => M.setShowN(n => n + 100)}>Show more ({M.rows.length - shown} left)</button>}
          {M.rows.length === 0 && <div className="empty">No coins match these filters.</div>}
        </div>
      )}
    </>
  )
}
