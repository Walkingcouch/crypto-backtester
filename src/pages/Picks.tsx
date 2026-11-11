import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import EquityChart from '../components/EquityChart'
import { Info } from '../components/Info'
import WhereToBuy from '../components/WhereToBuy'
import { BROKERS, useBroker, useListings } from '../lib/brokers'
import { curSymbol, fmtMoney, nowRate, useCurrency } from '../lib/currency'
import type { CoinView, Metrics, PickSettings } from '../lib/picks'

interface Thin { days: number[]; eq: number[]; metrics: Metrics | null; trades: number; feesPaid: number; avgExposure?: number; delistings?: number }
interface PicksResponse {
  updated: string; asOf: number; settings: PickSettings; coinsChecked: number
  delisted?: { base: string; from: string; to: string }[]
  now: { day: number; cash: number; universe: (CoinView & { verdict: 'buy' | 'hold' | 'avoid'; weight: number })[] }
  prev: { day: number; weights: Record<string, number> }
  tests: { fee: number; start: number; strategy: Thin; btc: Thin; basket: Thin }[]
}

const pct = (x: number, d = 0) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '–')
const pct0 = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–')
const color = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

const SOURCES = [
  { t: 'Liu & Tsyvinski, “Risks and Returns of Cryptocurrency”, Review of Financial Studies (2021)', u: 'https://www.nber.org/papers/w24877', why: 'Strong time-series momentum: coins that have been rising tend to keep rising for a while.' },
  { t: 'Zarattini, Pagani & Barbon, “Catching Crypto Trends” (2025)', u: 'https://concretumgroup.com/catching-crypto-trends-a-tactical-approach-for-bitcoin-and-altcoins/', why: 'Combining several trend rules across the ~20 most liquid coins, sized by volatility, earned a Sharpe ratio above 1.5 after fees.' },
  { t: 'Fieberg, Liedtke & Zaremba, “Cryptocurrency anomalies and economic constraints”, IRFA (2024)', u: 'https://open.icm.edu.pl/items/2350d455-72e4-4845-a442-9c4024be7fb6/full', why: 'Small-coin “bargains” are mostly untradeable; momentum survives in larger coins once costs are counted.' },
  { t: 'Kaya & Mostowfi, “Low-volatility strategies for highly liquid cryptocurrencies”, Finance Research Letters (2022)', u: 'https://digitalcollection.zhaw.ch/bitstream/11475/23853/3/2022_Kaya-Mostowfi_Low-volatility-strategies-cryptocurrencies_frl.pdf', why: 'Calmer coins delivered better risk-adjusted returns, so wilder coins get smaller positions here.' },
  { t: 'Zaremba et al., “Up or down? Short-term reversal, momentum, and liquidity effects in cryptocurrency markets”, IRFA (2021)', u: 'https://earsiv.medeniyet.edu.tr/items/23a96c9f-3952-4bdf-aec5-abafb3aaab70/full', why: 'One-day jumps in illiquid coins tend to reverse, so no 1-day signals and only the most-traded coins.' },
]

export default function Picks() {
  const [data, setData] = useState<PicksResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [budget, setBudget] = useState(() => { try { return +(localStorage.getItem('cb.budget') || 1000) } catch { return 1000 } })
  const { broker } = useBroker()
  const [feePct, setFeePct] = useState(broker.fees[0].fee)
  useEffect(() => setFeePct(broker.fees[0].fee), [broker.id])
  const { cur, live } = useCurrency()
  const rate = nowRate(cur, live) ?? 1
  const { listings, where } = useListings()
  const [withDelisted, setWithDelisted] = useState(() => { try { return localStorage.getItem('cb.delisted') === '1' } catch { return false } })

  useEffect(() => {
    setData(null); setError(null)
    try { localStorage.setItem('cb.delisted', withDelisted ? '1' : '0') } catch { /* */ }
    fetch(withDelisted ? '/api/picks?delisted=1' : '/api/picks').then(r => r.json()).then(j => { if (j.error) throw new Error(j.error); setData(j) })
      .catch(e => setError(`Couldn't load recommendations: ${e.message || e}`))
  }, [withDelisted])
  useEffect(() => { try { localStorage.setItem('cb.budget', String(budget)) } catch { /* */ } }, [budget])

  const test = useMemo(() => data?.tests.reduce((best, t) => (Math.abs(t.fee * 100 - feePct) < Math.abs(best.fee * 100 - feePct) ? t : best), data.tests[0]), [data, feePct])
  const buys = data?.now.universe.filter(a => a.verdict === 'buy') ?? []
  const holds = data?.now.universe.filter(a => a.verdict === 'hold') ?? []
  const avoids = data?.now.universe.filter(a => a.verdict === 'avoid') ?? []
  const changes = useMemo(() => {
    if (!data) return null
    const nowW = Object.fromEntries(buys.map(a => [a.base, a.weight]))
    const added = buys.filter(a => !data.prev.weights[a.base]).map(a => a.base)
    const dropped = Object.keys(data.prev.weights).filter(b => !nowW[b])
    return { added, dropped }
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps
  const money = (x: number) => fmtMoney(x, cur, x >= 100 ? 0 : 2)

  const lines = useMemo(() => test && [
    { name: 'Following the picks', t: test.strategy.days, values: test.strategy.eq.map(x => x * budget), color: color('--accent') },
    { name: 'Just Bitcoin', t: test.btc.days, values: test.btc.eq.map(x => x * budget), color: color('--bench') },
    { name: 'Top-10 basket', t: test.basket.days, values: test.basket.eq.map(x => x * budget), color: '#3b6fd8' },
  ], [test, budget])

  const s = test?.strategy.metrics, b = test?.btc.metrics, k = test?.basket.metrics
  const verdictText = s && b ? (
    s.sharpe > b.sharpe && s.maxDrawdown > b.maxDrawdown
      ? `Following the picks gave a better return for the risk than just holding Bitcoin, with a much smaller worst drop (${pct0(s.maxDrawdown)} vs ${pct0(b.maxDrawdown)}).`
      : s.maxDrawdown > b.maxDrawdown
        ? `The picks fell much less in bad times (${pct0(s.maxDrawdown)} vs ${pct0(b.maxDrawdown)} for Bitcoin), but earned less overall. A smoother ride, not a better one.`
        : `The picks did not beat simply holding Bitcoin over this period. Treat them with caution.`) : ''

  return (
    <main className="page narrow">
      <div className="page-head">
        <h1>Picks</h1>
        <p>What the research-based rules suggest right now: which coins to hold, how much of each for your budget, and how
          following these suggestions would have gone in the past.</p>
        <div className="notice info small">Rules-based suggestions for your own research, not personal financial advice. The rules are fixed from published studies (sources at the bottom) and weren't tuned to make the history look good.</div>
      </div>

      <section className="card">
        <div className="predict-controls" style={{ marginTop: 0 }}>
          <label className="mini"><span>Your budget ({cur})</span>
            <span className="pr-box"><span>{curSymbol(cur)}</span><input type="number" min={10} step={50} value={budget} onChange={e => setBudget(Math.max(0, +e.target.value))} /></span></label>
          <label className="mini"><span>Trading fee ({broker.name})</span>
            <select value={feePct} onChange={e => setFeePct(+e.target.value)}>
              {broker.fees.map(f => <option key={f.label} value={f.fee}>{f.label} · {f.fee}%</option>)}
            </select></label>
          <span className="small muted">Change your exchange on the Markets or Test page.</span>
        </div>
      </section>

      {error && <div className="notice err">{error}</div>}
      {!data && !error && <div className="card empty">Checking the 50 most-traded coins… (this takes up to a minute the first time each few hours)<div className="progress"><div /></div></div>}

      {data && (
        <>
          <section className="card">
            <div className="step-head">
              <span className="step-badge">Suggested mix · as of {new Date(data.asOf).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
              <h2>{buys.length ? `${buys.length} coin${buys.length > 1 ? 's' : ''} in an uptrend, ${pct0(data.now.cash)} in cash` : 'No coins pass the trend checks: stay in cash'}</h2>
              <p className="muted small">Out of the 20 most-traded coins. Wilder coins get smaller amounts, and no coin gets more than 20%. Review once a week.</p>
            </div>
            {changes && (changes.added.length > 0 || changes.dropped.length > 0) && (
              <div className="notice info small">Since last week: {changes.added.length ? <>new <b>{changes.added.join(', ')}</b></> : ''}{changes.added.length && changes.dropped.length ? ' · ' : ''}{changes.dropped.length ? <>dropped <b>{changes.dropped.join(', ')}</b></> : ''}</div>
            )}
            <div className="pick-list">
              {buys.map(a => (
                <div key={a.base} className="pick">
                  <div className="pick-main">
                    <div className="pick-name"><b>{a.base}</b> <WhereToBuy base={a.base} where={where(a.base)} known={listings?.ok ?? null} partial={listings?.partial} compact /></div>
                    <div className="pick-reasons">
                      <span className="tag green">Uptrend on {a.checks} of {a.of} checks</span>
                      <span className="tag">{pct(a.r30)} in 30 days</span>
                      <span className="tag">Volatility {pct0(a.vol)}{a.vol > 1 ? ' (wild)' : a.vol < 0.6 ? ' (calmer)' : ''}</span>
                    </div>
                  </div>
                  <div className="pick-amt">
                    <div className="pick-w">{pct0(a.weight)}</div>
                    <div className="pick-money">{money(a.weight * budget)}</div>
                    <div className="pick-links"><Link to={`/predict?coin=${a.base}USDT`}>Predict</Link><Link to={`/?coin=${a.base}USDT`}>Test</Link></div>
                  </div>
                </div>
              ))}
              <div className="pick pick-cash">
                <div className="pick-main"><div className="pick-name"><b>Cash</b> <span className="muted small">(AUD or a stablecoin)</span></div>
                  <div className="pick-reasons"><span className="muted small">{buys.length ? 'Kept back because the other coins are not trending, or to limit risk from wild coins.' : 'Nothing is trending up, so the rules sit out.'}</span></div></div>
                <div className="pick-amt"><div className="pick-w">{pct0(data.now.cash)}</div><div className="pick-money">{money(data.now.cash * budget)}</div></div>
              </div>
            </div>
            {cur === 'AUD' && <p className="hint">Amounts in AUD. Prices move, so check live prices on your exchange before buying. At today's rate 1 USDT ≈ A${rate.toFixed(3)}.</p>}
          </section>

          <section className="card">
            <h2>Watch and avoid</h2>
            <div className="watch-grid">
              <div><h3>Watch <Info>Trending up on at least half the checks, but not enough to buy. If you already hold these, the rules would usually keep a small position or wait.</Info></h3>
                {holds.length ? holds.map(a => <div key={a.base} className="watch-row"><b>{a.base}</b><span className="muted small">{a.checks}/{a.of} checks · {pct(a.r30)} 30d</span></div>) : <p className="muted small">None.</p>}</div>
              <div><h3>Avoid for now <Info>In a downtrend on most checks. Trend-following waits for these to turn before buying.</Info></h3>
                {avoids.length ? avoids.map(a => <div key={a.base} className="watch-row"><b>{a.base}</b><span className="muted small">{a.checks}/{a.of} checks · {pct(a.r30)} 30d</span></div>) : <p className="muted small">None.</p>}</div>
            </div>
          </section>

          {test && s && b && k && lines && (
            <section className="card">
              <div className="step-head">
                <span className="step-badge">Track record</span>
                <h2>If you'd followed these picks since {new Date(test.start).getFullYear()}</h2>
                <p className="muted small">Re-run week by week using only prices known at the time, trading the day after each decision, paying {(test.fee * 100).toFixed(2)}% fees plus 0.05% slippage on every trade. Starting with {money(budget)}.</p>
              </div>
              <div className={`verdict ${s.sharpe > b.sharpe ? 'good' : 'mixed'}`}><b>{verdictText}</b></div>
              <EquityChart lines={lines} />
              <div className="table-wrap"><table>
                <thead><tr><th></th><th>Picks</th><th>Just Bitcoin</th><th>Top-10 basket</th></tr></thead>
                <tbody>
                  <tr><td>{money(budget)} became</td><td><b>{money(budget * s.multiple)}</b></td><td>{money(budget * b.multiple)}</td><td>{money(budget * k.multiple)}</td></tr>
                  <tr><td>Yearly return</td><td>{pct(s.cagr)}</td><td>{pct(b.cagr)}</td><td>{pct(k.cagr)}</td></tr>
                  <tr><td>Worst drop <Info>The biggest fall from a high point along the way.</Info></td><td className="neg">{pct0(s.maxDrawdown)}</td><td className="neg">{pct0(b.maxDrawdown)}</td><td className="neg">{pct0(k.maxDrawdown)}</td></tr>
                  <tr><td>Risk-adjusted score</td><td>{s.sharpe.toFixed(2)}</td><td>{b.sharpe.toFixed(2)}</td><td>{k.sharpe.toFixed(2)}</td></tr>
                  <tr><td>Time invested</td><td>{pct0(test.strategy.avgExposure ?? NaN)}</td><td>100%</td><td>100%</td></tr>
                  <tr><td>Trades</td><td>{test.strategy.trades.toLocaleString()}</td><td>{test.btc.trades}</td><td>{test.basket.trades}</td></tr>
                </tbody>
              </table></div>
              <label className="toggle-row">
                <input type="checkbox" checked={withDelisted} onChange={e => setWithDelisted(e.target.checked)} />
                <span><b>Include coins that were later delisted</b> <span className="muted small">(crashed, shut down or renamed: LUNA, FTT, MATIC and others, from Binance's archive). If the rules held one when it stopped trading, it's sold at its last price.</span></span>
              </label>
              {withDelisted && data.delisted && (
                <div className="notice info small" style={{ marginTop: 8 }}>
                  Added {data.delisted.length} delisted coin{data.delisted.length === 1 ? '' : 's'}: {data.delisted.map(d => d.base).join(', ')}.
                  {' '}{test.strategy.delistings ? `The picks were holding a coin when it was delisted ${test.strategy.delistings} time${test.strategy.delistings === 1 ? '' : 's'}.` : 'The picks never held a coin at the moment it was delisted.'}
                  {' '}Compare with the toggle off to see how much survivorship bias flattered the result.
                </div>
              )}
              {!withDelisted && <div className="notice warn small" style={{ marginTop: 12 }}>
                <b>Why the real result would likely be worse:</b> this test only includes coins that still trade today. Coins that collapsed and were delisted
                (which the rules might have bought) are missing, so the history looks rosier than reality ("survivorship bias"). Treat it as a rough guide, and
                watch how the picks do from here on.
              </div>}
            </section>
          )}

          <section className="card">
            <h2>How the picks are made</h2>
            <ol className="how-list">
              <li><b>Only the 20 most-traded coins</b> (by 30-day average volume), each with at least {data.settings.minHistory} days of history. Stablecoins, wrapped coins and gold tokens are left out.</li>
              <li><b>Eight trend checks per coin:</b> is the price higher than {data.settings.lookbacks.join(', ')} days ago, and above its average over each of those periods? A coin needs {Math.round(data.settings.buyScore * 8)} or more of 8 to be a buy.</li>
              <li><b>Size by wildness:</b> each coin's share is set so it adds about the same risk. Calmer coins get more, wild coins less, never more than {pct0(data.settings.maxWeight)}. Whatever isn't needed stays in cash.</li>
              <li><b>Weekly review:</b> changes smaller than {pct0(data.settings.minTrade)} of your budget are skipped to save fees.</li>
            </ol>
            <h3>The research behind it</h3>
            <ul className="sources">
              {SOURCES.map(x => <li key={x.u}><a href={x.u} target="_blank" rel="noreferrer noopener">{x.t}</a><span className="muted small"> — {x.why}</span></li>)}
            </ul>
            <p className="hint">Checked {data.coinsChecked} coins · updated {new Date(data.updated).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · refreshes every few hours. {BROKERS.length ? '' : ''}</p>
          </section>
        </>
      )}
    </main>
  )
}
