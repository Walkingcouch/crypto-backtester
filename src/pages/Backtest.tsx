import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import EquityChart from '../components/EquityChart'
import { Headline, MetricTable, verdict } from '../components/Metrics'
import { Disclosure, Info } from '../components/Info'
import type { Bar, Costs, Result } from '../lib/engine'
import { fetchCandles, parseCsv } from '../lib/data'
import { day, num, paramStr, pct } from '../lib/format'
import { evaluateTest, optimiseOnTrain, periodKey, splitBars, type Score, type TrainOutcome } from '../lib/research'
import { byId, STRATEGIES } from '../lib/strategies'
import { addReveal, listReveals, saveRun, type Reveal } from '../lib/store'
import { useAuth } from '../lib/auth'
import { cloudEnabled } from '../lib/supabase'

const COINS = [
  { sym: 'BTCUSDT', name: 'Bitcoin', tick: 'BTC' },
  { sym: 'ETHUSDT', name: 'Ethereum', tick: 'ETH' },
  { sym: 'SOLUSDT', name: 'Solana', tick: 'SOL' },
  { sym: 'XRPUSDT', name: 'XRP', tick: 'XRP' },
  { sym: 'ADAUSDT', name: 'Cardano', tick: 'ADA' },
  { sym: 'DOGEUSDT', name: 'Dogecoin', tick: 'DOGE' },
]
const AMOUNTS = [100, 200, 500, 1000]
const FEES = [
  { label: 'Exchange order', sub: '0.1%', v: 0.1 },
  { label: 'App instant buy', sub: '~1%', v: 1 },
]
const color = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()
const year = (t: number) => new Date(t).getUTCFullYear()

interface Loaded { bars: Bar[]; symbol: string; label: string; interval: string; testStartIndex: number }

export default function Backtest() {
  const { session } = useAuth()
  const [coin, setCoin] = useState('BTCUSDT')
  const [otherCoin, setOtherCoin] = useState('')
  const [strategyId, setStrategyId] = useState('sma_cross')
  const [cash, setCash] = useState(200)
  const [feePct, setFeePct] = useState(0.1)
  // advanced
  const [source, setSource] = useState<'binance' | 'csv'>('binance')
  const [interval, setInterval] = useState('1d')
  const [since, setSince] = useState('2018-01-01')
  const [csv, setCsv] = useState<{ name: string; bars: Bar[] } | null>(null)
  const [slipPct, setSlipPct] = useState(0.05)
  const [testPct, setTestPct] = useState(30)
  const [score, setScore] = useState<Score>('sharpe')

  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [train, setTrain] = useState<TrainOutcome | null>(null)
  const [test, setTest] = useState<{ r: Result; bench: Result; warnings: string[] } | null>(null)
  const [confirming, setConfirming] = useState<{ prior: Reveal[] } | null>(null)
  const [saved, setSaved] = useState(false)
  const resultsRef = useRef<HTMLDivElement>(null)
  const testRef = useRef<HTMLDivElement>(null)

  const strategy = byId(strategyId)
  const costs: Costs = { fee: feePct / 100, slippage: slipPct / 100 }
  const combos = Object.values(strategy.grid).reduce((n, v) => n * v.length, 1)
  const symbol = coin === 'OTHER' ? otherCoin : coin
  const coinLabel = COINS.find(c => c.sym === symbol)?.name ?? symbol

  useEffect(() => { if (train) resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [train])
  useEffect(() => { if (test) testRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [test])

  function resetResults() { setTrain(null); setTest(null); setConfirming(null); setSaved(false) }

  async function run() {
    setError(null); resetResults()
    try {
      let bars: Bar[], sym: string, label: string, iv: string
      if (source === 'csv') {
        if (!csv) throw new Error('Choose a CSV file under More options first.')
        bars = csv.bars; sym = csv.name.replace(/\.csv$/i, ''); label = sym; iv = 'csv'
      } else {
        if (!symbol) throw new Error('Type a coin symbol, e.g. LINKUSDT.')
        setBusy(`Getting ${coinLabel} prices…`)
        bars = await fetchCandles(symbol, interval, since, n => setBusy(`Getting ${coinLabel} prices… ${n.toLocaleString()} days`))
        sym = symbol; label = coinLabel; iv = interval
      }
      if (bars.length < 400) throw new Error(`Only ${bars.length} candles of history — need at least 400. Try an earlier start date under More options.`)
      setBusy('Testing the strategy on past prices…')
      await new Promise(r => setTimeout(r, 30))
      const sp = splitBars(bars, testPct / 100)
      const out = optimiseOnTrain(sp.train, strategy, cash, costs, score)
      setLoaded({ bars, symbol: sym, label, interval: iv, testStartIndex: sp.testStartIndex })
      setTrain(out)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  async function askReveal() {
    if (!loaded || !train) return
    setError(null)
    try {
      const key = periodKey(loaded.symbol, loaded.interval, loaded.bars, loaded.testStartIndex)
      const prior = (await listReveals()).filter(r => r.period_key === key && r.strategy_id === strategy.id)
      if (prior.length === 0) await reveal(prior)
      else setConfirming({ prior })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function reveal(prior: Reveal[]) {
    if (!loaded || !train) return
    const { bars, testStartIndex } = loaded
    const params = train.best.params
    try {
      const r = evaluateTest(bars, testStartIndex, strategy, params, cash, costs)
      const bench = evaluateTest(bars, testStartIndex, byId('buy_and_hold'), {}, cash, costs)
      const warnings: string[] = []
      if (prior.length) {
        const changed = prior.some(p => p.strategy_version !== strategy.version || JSON.stringify(p.params) !== JSON.stringify(params) || p.fee !== costs.fee)
        warnings.push(
          `This strategy has been checked on these recent prices ${prior.length} time${prior.length > 1 ? 's' : ''} before` +
          (changed ? ' with different settings, so this result is no longer a fair test. Wait for new prices or try another coin for an honest check.' : '.'))
      }
      await addReveal({
        strategy_id: strategy.id, strategy_version: strategy.version, params,
        period_key: periodKey(loaded.symbol, loaded.interval, bars, testStartIndex),
        symbol: loaded.symbol, interval: loaded.interval, test_from: day(bars[testStartIndex].t), test_to: day(bars[bars.length - 1].t),
        fee: costs.fee, sharpe: r.metrics.sharpe, total_return: r.metrics.totalReturn,
        max_drawdown: r.metrics.maxDrawdown, bh_return: bench.metrics.totalReturn,
      })
      setTest({ r, bench, warnings }); setConfirming(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function save() {
    if (!loaded || !train) return
    try {
      await saveRun({
        title: `${strategy.friendly ?? strategy.name} · ${loaded.label}`,
        strategy_id: strategy.id, symbol: loaded.symbol, interval: loaded.interval,
        settings: { cash, fee: costs.fee, slippage: costs.slippage, testPct, score, since, train_from: day(loaded.bars[0].t), test_from: day(loaded.bars[loaded.testStartIndex].t), test_to: day(loaded.bars[loaded.bars.length - 1].t) },
        params: train.best.params,
        train_metrics: train.best.metrics as unknown as Record<string, number>,
        test_metrics: test ? (test.r.metrics as unknown as Record<string, number>) : null,
      })
      setSaved(true)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const sName = strategy.friendly ?? strategy.name
  const trainLines = useMemo(() => train && [
    { name: sName, t: train.best.t, values: train.best.equity, color: color('--accent') },
    { name: 'Buy & hold', t: train.benchmark.t, values: train.benchmark.equity, color: color('--bench') },
  ], [train]) // eslint-disable-line react-hooks/exhaustive-deps
  const testLines = useMemo(() => test && [
    { name: sName, t: test.r.t, values: test.r.equity, color: color('--accent') },
    { name: 'Buy & hold', t: test.bench.t, values: test.bench.equity, color: color('--bench') },
  ], [test]) // eslint-disable-line react-hooks/exhaustive-deps

  const gridKeys = Object.keys(strategy.grid)
  const trainV = train && verdict(train.best.metrics, train.benchmark.metrics)
  const testV = test && verdict(test.r.metrics, test.bench.metrics)
  const heldUp = test && train && test.r.metrics.sharpe >= train.best.metrics.sharpe - 0.3

  return (
    <main className="page narrow">
      <div className="hero">
        <h1>Would this strategy have made money?</h1>
        <p>Pick a coin and a strategy. We'll replay it on years of real prices, including fees, and compare it with simply buying and holding.</p>
        <ol className="how">
          <li><b>Pick</b> a coin, strategy and amount</li>
          <li><b>Test</b> it on older prices</li>
          <li><b>Final check</b> on recent prices it's never seen</li>
        </ol>
      </div>

      <section className="card setup">
        <div className="q">
          <div className="q-title"><span className="q-num">1</span>Which coin?</div>
          <div className="chips">
            {COINS.map(c => (
              <button key={c.sym} className={`chip ${coin === c.sym ? 'on' : ''}`} onClick={() => { setCoin(c.sym); setSource('binance'); resetResults() }}>
                <b>{c.name}</b><span>{c.tick}</span>
              </button>
            ))}
            <button className={`chip ${coin === 'OTHER' ? 'on' : ''}`} onClick={() => { setCoin('OTHER'); setSource('binance'); resetResults() }}><b>Other…</b><span>any</span></button>
          </div>
          {coin === 'OTHER' && (
            <label className="field" style={{ marginTop: 10 }}>
              <span>Binance symbol (coin + USDT)</span>
              <input autoFocus placeholder="e.g. LINKUSDT" value={otherCoin} onChange={e => setOtherCoin(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
            </label>
          )}
        </div>

        <div className="q">
          <div className="q-title"><span className="q-num">2</span>Which strategy?</div>
          <div className="options">
            {STRATEGIES.filter(s => s.id !== 'buy_and_hold').map(s => (
              <button key={s.id} className={`option ${strategyId === s.id ? 'on' : ''}`} onClick={() => { setStrategyId(s.id); resetResults() }}>
                <span className="radio" />
                <span>
                  <b>{s.friendly}</b>{s.id === 'sma_cross' && <span className="tag green" style={{ marginLeft: 8 }}>Start here</span>}
                  <span className="option-sub">{s.tagline}</span>
                </span>
              </button>
            ))}
          </div>
          <Disclosure title="Exact rules">
            <div className="rules">
              <div><b>Buy</b>{strategy.rules.entry}</div>
              <div><b>Sell</b>{strategy.rules.exit}</div>
              <div><b>Size</b>{strategy.rules.sizing}</div>
              <div className="muted small">We try {combos} setting{combos > 1 ? 's' : ''} for the averages/lookbacks on older prices and keep the best one.</div>
            </div>
          </Disclosure>
        </div>

        <div className="q">
          <div className="q-title"><span className="q-num">3</span>Starting amount</div>
          <div className="chips">
            {AMOUNTS.map(a => <button key={a} className={`chip chip-sm ${cash === a ? 'on' : ''}`} onClick={() => setCash(a)}><b>${a.toLocaleString()}</b></button>)}
            <label className="chip chip-sm chip-input"><span>$</span><input type="number" min={10} value={AMOUNTS.includes(cash) ? '' : cash} placeholder="Other" onChange={e => e.target.value && setCash(Math.max(10, +e.target.value))} /></label>
          </div>
        </div>

        <div className="q">
          <div className="q-title"><span className="q-num">4</span>Your trading fee <Info>Every buy and sell costs a fee. Order-book trades on an exchange are usually around 0.1%. "Instant buy" buttons in retail apps often charge around 1% or more. Check your exchange's fee page.</Info></div>
          <div className="chips">
            {FEES.map(f => <button key={f.v} className={`chip chip-sm ${feePct === f.v ? 'on' : ''}`} onClick={() => setFeePct(f.v)}><b>{f.label}</b><span>{f.sub}</span></button>)}
            <label className="chip chip-sm chip-input"><input type="number" step={0.05} min={0} value={FEES.some(f => f.v === feePct) ? '' : feePct} placeholder="Other" onChange={e => e.target.value !== '' && setFeePct(Math.max(0, +e.target.value))} /><span>%</span></label>
          </div>
        </div>

        <Disclosure title="More options">
          <div className="row2">
            <label className="field"><span>History from</span><input type="date" value={since} onChange={e => setSince(e.target.value)} /></label>
            <label className="field"><span>Candle size</span>
              <select value={interval} onChange={e => setInterval(e.target.value)}>
                <option value="1d">1 day (recommended)</option><option value="4h">4 hours</option><option value="1h">1 hour</option>
              </select></label>
          </div>
          <div className="row2">
            <label className="field"><span>Recent prices kept for final check</span>
              <select value={testPct} onChange={e => setTestPct(+e.target.value)}>
                {[20, 25, 30, 40].map(v => <option key={v} value={v}>Last {v}%</option>)}
              </select></label>
            <label className="field"><span>Slippage <Info>How much worse than the quoted price your order fills. 0.05% is typical for big coins; use more for small coins.</Info></span>
              <input type="number" step={0.01} min={0} value={slipPct} onChange={e => setSlipPct(Math.max(0, +e.target.value))} /></label>
          </div>
          <label className="field"><span>Choose the best settings by</span>
            <select value={score} onChange={e => setScore(e.target.value as Score)}>
              <option value="sharpe">Risk-adjusted return (recommended)</option>
              <option value="calmar">Return vs worst drop</option>
              <option value="totalReturn">Total return only</option>
            </select></label>
          <label className="field"><span>Or use your own price file (CSV)</span>
            <input type="file" accept=".csv,text/csv" onChange={async e => {
              const f = e.target.files?.[0]; if (!f) { setSource('binance'); return }
              try { setCsv({ name: f.name, bars: parseCsv(await f.text()) }); setSource('csv'); setError(null); resetResults() }
              catch (err) { setCsv(null); setSource('binance'); setError(err instanceof Error ? err.message : String(err)) }
            }} />
            <span className="hint">{source === 'csv' && csv ? `Using ${csv.name}: ${csv.bars.length.toLocaleString()} candles, ${day(csv.bars[0].t)} → ${day(csv.bars[csv.bars.length - 1].t)}` : 'Columns: timestamp, open, high, low, close, volume. Useful for AUD prices or other exchanges.'}</span>
          </label>
        </Disclosure>

        <button className="btn btn-primary btn-block btn-lg" onClick={run} disabled={!!busy}>
          {busy ? 'Running…' : `Test ${sName.toLowerCase()} on ${source === 'csv' && csv ? csv.name : coinLabel || 'coin'}`}
        </button>
        {busy && <><div className="progress"><div /></div><p className="hint center" style={{ marginTop: 8 }}>{busy}</p></>}
        {error && <div className="notice err" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
      </section>

      {train && loaded && trainLines && trainV && (
        <section className="card" ref={resultsRef}>
          <div className="step-head">
            <span className="step-badge">Result 1 of 2</span>
            <h2>Older prices · {year(train.best.t[0])}–{year(train.best.t[train.best.t.length - 1])}</h2>
            <p className="muted small">{sName} on {loaded.label}, starting with ${cash.toLocaleString()}, {pct(costs.fee, 2)} fee per trade.</p>
          </div>
          <div className={`verdict ${trainV.cls}`}><b>{trainV.title}</b><span>{trainV.body}</span></div>
          <Headline m={train.best.metrics} bench={train.benchmark.metrics} cash={cash} />
          <EquityChart lines={trainLines} />
          <p className="hint">Tuned on these prices, so this result flatters the strategy. The final check below is the honest one.</p>

          <Disclosure title={`Settings tried (${train.grid.length}) and trades`}>
            {gridKeys.length > 0 && <>
              <p className="small muted">Best: <span className="mono">{paramStr(train.best.params)}</span>. Good sign: settings next to the winner also do well. Bad sign: only one exact setting works.</p>
              <div className="table-wrap" style={{ marginBottom: 16 }}>
                <table>
                  <thead><tr>{gridKeys.map(k => <th key={k}>{k}</th>)}<th>Score</th><th>Return</th><th>Worst drop</th><th>Trades</th></tr></thead>
                  <tbody>{train.grid.map((g, i) => (
                    <tr key={i} className={i === 0 ? 'hl' : ''}>{gridKeys.map(k => <td key={k}>{g.params[k]}</td>)}
                      <td>{num(g.metrics.sharpe)}</td><td>{pct(g.metrics.totalReturn)}</td><td>{pct(g.metrics.maxDrawdown)}</td><td>{g.metrics.trades}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </>}
            <TradeTable r={train.best} />
          </Disclosure>
        </section>
      )}

      {train && loaded && (
        <section className="card" ref={testRef}>
          <div className="step-head">
            <span className="step-badge">Result 2 of 2</span>
            <h2>Final check · recent prices {year(loaded.bars[loaded.testStartIndex].t)}–{year(loaded.bars[loaded.bars.length - 1].t)}</h2>
            <p className="muted small">{day(loaded.bars[loaded.testStartIndex].t)} to {day(loaded.bars[loaded.bars.length - 1].t)}. The strategy never saw these prices while being tuned.</p>
          </div>

          {!test && !confirming && (
            <div className="locked">
              <div className="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg></div>
              <p><b>This is the result that counts.</b> It's like an exam: you only get one honest attempt. Try other strategies or settings first if you want, then run the final check when you're happy.
                {' '}It's recorded in <Link to="/history">History</Link>{session ? ' for you and your partner' : ''}.</p>
              <button className="btn btn-primary" onClick={askReveal}>Run final check</button>
            </div>
          )}

          {confirming && (
            <div className="locked">
              <div className="notice warn" style={{ textAlign: 'left' }}>
                {sName} has already had its final check on these prices {confirming.prior.length} time{confirming.prior.length > 1 ? 's' : ''}
                {' '}(last score {num(confirming.prior[0].sharpe)}). Checking again after changing things isn't a fair test any more. It'll be marked in History.
              </div>
              <div className="flex" style={{ justifyContent: 'center' }}>
                <button className="btn btn-ghost" onClick={() => setConfirming(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={() => reveal(confirming.prior)}>Check anyway</button>
              </div>
            </div>
          )}

          {test && testLines && testV && train && (
            <>
              {test.warnings.map(w => <div className="notice warn" key={w}>{w}</div>)}
              <div className={`verdict ${testV.cls}`}><b>{testV.title}</b><span>{testV.body}</span></div>
              <div className={`notice ${heldUp ? 'ok' : 'warn'}`}>
                {heldUp
                  ? 'Consistent: it did about as well or better on new prices as on the older ones, so the settings weren\'t just fitted to past luck.'
                  : `Faded: its score dropped from ${num(train.best.metrics.sharpe)} to ${num(test.r.metrics.sharpe)} on new prices. The tuned settings may have just fitted past luck.`}
              </div>
              <Headline m={test.r.metrics} bench={test.bench.metrics} cash={cash} />
              <EquityChart lines={testLines} />
              <Disclosure title="Trades during the final check"><TradeTable r={test.r} /></Disclosure>
            </>
          )}
        </section>
      )}

      {train && (
        <section className="card">
          <div className="flex">
            <div>
              <h2 style={{ margin: 0 }}>Keep this result</h2>
              <p className="small muted" style={{ margin: 0 }}>
                {cloudEnabled && !session ? <>Saved in this browser. <Link to="/account">Sign in</Link> to share with your partner.</> : 'Saved to your History with every setting recorded.'}
              </p>
            </div>
            <span className="spacer" />
            {saved ? <span className="tag green">Saved ✓</span> : <button className="btn btn-ghost" onClick={save}>Save result</button>}
          </div>
          <Disclosure title="All the numbers">
            <MetricTable cols={[
              { name: 'Older · strategy', m: train.best.metrics }, { name: 'Older · holding', m: train.benchmark.metrics },
              ...(test ? [{ name: 'Recent · strategy', m: test.r.metrics }, { name: 'Recent · holding', m: test.bench.metrics }] : []),
            ]} />
          </Disclosure>
        </section>
      )}
    </main>
  )
}

function TradeTable({ r }: { r: Result }) {
  if (!r.trades.length) return <p className="muted small">No trades.</p>
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Action</th><th>Price</th><th>Fee</th><th>Cash after</th></tr></thead>
        <tbody>
          {r.trades.slice(-60).reverse().map((t, i) => (
            <tr key={i}><td>{day(t.t)}</td><td className={t.side === 'BUY' ? 'pos' : 'neg'}>{t.side === 'BUY' ? 'Buy' : 'Sell'}</td>
              <td>{t.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
              <td>${t.fee.toFixed(2)}</td><td>${t.cashAfter.toFixed(2)}</td></tr>
          ))}
        </tbody>
      </table>
      {r.trades.length > 60 && <p className="hint">Showing the latest 60 of {r.trades.length}.</p>}
    </div>
  )
}
