import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import EquityChart from '../components/EquityChart'
import { Kpis, MetricTable } from '../components/Metrics'
import type { Bar, Costs, Result } from '../lib/engine'
import { fetchCandles, parseCsv } from '../lib/data'
import { day, num, paramStr, pct } from '../lib/format'
import { evaluateTest, optimiseOnTrain, periodKey, splitBars, type Score, type TrainOutcome } from '../lib/research'
import { byId, STRATEGIES } from '../lib/strategies'
import { addReveal, listReveals, saveRun, type Reveal } from '../lib/store'
import { useAuth } from '../lib/auth'
import { cloudEnabled } from '../lib/supabase'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT']
const color = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

interface Loaded { bars: Bar[]; symbol: string; interval: string; testStartIndex: number }

export default function Backtest() {
  const { session } = useAuth()
  const [source, setSource] = useState<'binance' | 'csv'>('binance')
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [interval, setInterval] = useState('1d')
  const [since, setSince] = useState('2018-01-01')
  const [csv, setCsv] = useState<{ name: string; bars: Bar[] } | null>(null)
  const [strategyId, setStrategyId] = useState('sma_cross')
  const [cash, setCash] = useState(200)
  const [feePct, setFeePct] = useState(0.1)
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

  const strategy = byId(strategyId)
  const costs: Costs = { fee: feePct / 100, slippage: slipPct / 100 }
  const combos = Object.values(strategy.grid).reduce((n, v) => n * v.length, 1)

  async function run() {
    setError(null); setTest(null); setTrain(null); setConfirming(null); setSaved(false)
    try {
      let bars: Bar[], sym: string, iv: string
      if (source === 'csv') {
        if (!csv) throw new Error('Choose a CSV file first.')
        bars = csv.bars; sym = csv.name.replace(/\.csv$/i, ''); iv = 'csv'
      } else {
        setBusy('Downloading prices…')
        bars = await fetchCandles(symbol, interval, since, n => setBusy(`Downloading prices… ${n.toLocaleString()} candles`))
        sym = symbol; iv = interval
      }
      if (bars.length < 400) throw new Error(`Only ${bars.length} candles — need at least 400. Pick an earlier start date.`)
      setBusy(`Testing ${combos} setting${combos > 1 ? 's' : ''} on the training period…`)
      await new Promise(r => setTimeout(r, 30))
      const sp = splitBars(bars, testPct / 100)
      const out = optimiseOnTrain(sp.train, strategy, cash, costs, score)
      setLoaded({ bars, symbol: sym, interval: iv, testStartIndex: sp.testStartIndex })
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
      setConfirming({ prior })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function reveal() {
    if (!loaded || !train || !confirming) return
    const { bars, testStartIndex } = loaded
    const params = train.best.params
    try {
      const r = evaluateTest(bars, testStartIndex, strategy, params, cash, costs)
      const bench = evaluateTest(bars, testStartIndex, byId('buy_and_hold'), {}, cash, costs)
      const prior = confirming.prior
      const warnings: string[] = []
      if (prior.length) {
        const changed = prior.some(p => p.strategy_version !== strategy.version || JSON.stringify(p.params) !== JSON.stringify(params) || p.fee !== costs.fee)
        warnings.push(
          `This strategy has already been tested on this exact period ${prior.length} time${prior.length > 1 ? 's' : ''}` +
          (changed ? ' with different settings. Because those results were seen, this period is no longer unseen — treat this result as in-sample.' : '.'))
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
        title: `${strategy.name} · ${loaded.symbol} ${loaded.interval}`,
        strategy_id: strategy.id, symbol: loaded.symbol, interval: loaded.interval,
        settings: { cash, fee: costs.fee, slippage: costs.slippage, testPct, score, since, train_from: day(loaded.bars[0].t), test_from: day(loaded.bars[loaded.testStartIndex].t), test_to: day(loaded.bars[loaded.bars.length - 1].t) },
        params: train.best.params,
        train_metrics: train.best.metrics as unknown as Record<string, number>,
        test_metrics: test ? (test.r.metrics as unknown as Record<string, number>) : null,
      })
      setSaved(true)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const trainLines = useMemo(() => train && [
    { name: strategy.name, t: train.best.t, values: train.best.equity, color: color('--accent') },
    { name: 'Buy & hold', t: train.benchmark.t, values: train.benchmark.equity, color: color('--bench') },
  ], [train]) // eslint-disable-line react-hooks/exhaustive-deps
  const testLines = useMemo(() => test && [
    { name: strategy.name, t: test.r.t, values: test.r.equity, color: color('--accent') },
    { name: 'Buy & hold', t: test.bench.t, values: test.bench.equity, color: color('--bench') },
  ], [test]) // eslint-disable-line react-hooks/exhaustive-deps

  const gridKeys = Object.keys(strategy.grid)

  return (
    <main className="page">
      <div className="page-head">
        <h1>Backtest a strategy</h1>
        <p>Pick a coin and a rule-based strategy. Settings are tuned on older prices only; the most recent prices stay
          locked as an unseen test until you choose to reveal it. New here? Read the <Link to="/guide">guide</Link>.</p>
      </div>

      <div className="grid-main">
        <aside className="card sticky">
          <div className="field">
            <span>Price data</span>
            <div className="seg">
              <button className={source === 'binance' ? 'on' : ''} onClick={() => setSource('binance')}>Download</button>
              <button className={source === 'csv' ? 'on' : ''} onClick={() => setSource('csv')}>Upload CSV</button>
            </div>
          </div>
          {source === 'binance' ? (
            <>
              <div className="row2">
                <label className="field"><span>Market</span>
                  <input list="syms" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
                  <datalist id="syms">{SYMBOLS.map(s => <option key={s} value={s} />)}</datalist>
                </label>
                <label className="field"><span>Candle</span>
                  <select value={interval} onChange={e => setInterval(e.target.value)}>
                    <option value="1d">1 day</option><option value="4h">4 hours</option><option value="1h">1 hour</option>
                  </select>
                </label>
              </div>
              <label className="field"><span>History from</span>
                <input type="date" value={since} onChange={e => setSince(e.target.value)} />
              </label>
            </>
          ) : (
            <label className="field"><span>CSV file</span>
              <input type="file" accept=".csv,text/csv" onChange={async e => {
                const f = e.target.files?.[0]; if (!f) return
                try { setCsv({ name: f.name, bars: parseCsv(await f.text()) }); setError(null) }
                catch (err) { setCsv(null); setError(err instanceof Error ? err.message : String(err)) }
              }} />
              <span className="hint">{csv ? `${csv.bars.length.toLocaleString()} candles, ${day(csv.bars[0].t)} → ${day(csv.bars[csv.bars.length - 1].t)}` : 'Columns: timestamp, open, high, low, close, volume'}</span>
            </label>
          )}

          <label className="field"><span>Strategy</span>
            <select value={strategyId} onChange={e => { setStrategyId(e.target.value); setTrain(null); setTest(null) }}>
              {STRATEGIES.filter(s => s.id !== 'buy_and_hold').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <div className="rules">
            <div className="muted">{strategy.summary}</div>
            <div><b>Entry</b>{strategy.rules.entry}</div>
            <div><b>Exit</b>{strategy.rules.exit}</div>
            <div><b>Size</b>{strategy.rules.sizing}</div>
          </div>

          <div className="row2">
            <label className="field"><span>Start cash ($)</span>
              <input type="number" min={10} value={cash} onChange={e => setCash(Math.max(1, +e.target.value))} /></label>
            <label className="field"><span>Unseen test (%)</span>
              <input type="number" min={10} max={50} value={testPct} onChange={e => setTestPct(Math.min(50, Math.max(10, +e.target.value)))} /></label>
          </div>
          <div className="row2">
            <label className="field"><span>Fee per trade (%)</span>
              <input type="number" step={0.05} min={0} value={feePct} onChange={e => setFeePct(Math.max(0, +e.target.value))} /></label>
            <label className="field"><span>Slippage (%)</span>
              <input type="number" step={0.01} min={0} value={slipPct} onChange={e => setSlipPct(Math.max(0, +e.target.value))} /></label>
          </div>
          <p className="hint" style={{ marginTop: -6 }}>Use your exchange's real fee. "Instant buy" fees in retail apps are often far higher than order-book fees.</p>
          <label className="field"><span>Pick best settings by</span>
            <select value={score} onChange={e => setScore(e.target.value as Score)}>
              <option value="sharpe">Sharpe (return per unit of risk)</option>
              <option value="calmar">Calmar (return vs worst drawdown)</option>
              <option value="totalReturn">Total return</option>
            </select>
          </label>

          <button className="btn btn-primary btn-block" onClick={run} disabled={!!busy}>{busy ? 'Running…' : 'Run backtest'}</button>
          {busy && <><div className="progress"><div /></div><p className="hint" style={{ marginTop: 8 }}>{busy}</p></>}
        </aside>

        <section className="stack">
          {error && <div className="notice err">{error}</div>}

          {!train && !busy && !error && (
            <div className="card empty">
              <h2>No results yet</h2>
              <p>Set things up on the left and press <b>Run backtest</b>. Start with the trend baseline on BTCUSDT daily.</p>
            </div>
          )}

          {train && loaded && trainLines && (
            <div className="card">
              <div className="card-title">
                <div>
                  <h2>Training period</h2>
                  <div className="small muted">{day(train.best.t[0])} → {day(train.best.t[train.best.t.length - 1])} · best settings: <span className="mono">{paramStr(train.best.params)}</span></div>
                </div>
                <span className="tag">in-sample</span>
              </div>
              <Kpis m={train.best.metrics} bench={train.benchmark.metrics} />
              <EquityChart lines={trainLines} />
            </div>
          )}

          {train && loaded && (
            <div className="card">
              <div className="card-title">
                <div>
                  <h2>Unseen test period</h2>
                  <div className="small muted">{day(loaded.bars[loaded.testStartIndex].t)} → {day(loaded.bars[loaded.bars.length - 1].t)} · {(loaded.bars.length - loaded.testStartIndex).toLocaleString()} candles</div>
                </div>
                <span className={`tag ${test ? 'green' : 'amber'}`}>{test ? 'revealed' : 'locked'}</span>
              </div>

              {!test && !confirming && (
                <div className="locked">
                  <div className="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg></div>
                  <p>This is the result that counts. Only reveal it when you've finished tweaking. Every reveal is recorded in the
                    {' '}<Link to="/ledger">test ledger</Link>{session ? ' shared with your partner' : ''}, and changing the strategy afterwards means this period is no longer unseen.</p>
                  <button className="btn btn-primary" onClick={askReveal}>Reveal test result</button>
                </div>
              )}

              {confirming && (
                <div className="locked">
                  {confirming.prior.length > 0
                    ? <div className="notice warn" style={{ textAlign: 'left' }}>Already revealed {confirming.prior.length} time{confirming.prior.length > 1 ? 's' : ''} for this strategy and period
                      (last: {paramStr(confirming.prior[0].params)}, Sharpe {num(confirming.prior[0].sharpe)}). Looking again after changes turns it into training data.</div>
                    : <p>First look at this period for <b>{strategy.name}</b> with <span className="mono">{paramStr(train.best.params)}</span>. Ready?</p>}
                  <div className="flex" style={{ justifyContent: 'center' }}>
                    <button className="btn btn-ghost" onClick={() => setConfirming(null)}>Not yet</button>
                    <button className="btn btn-primary" onClick={reveal}>Reveal and record</button>
                  </div>
                </div>
              )}

              {test && testLines && (
                <>
                  {test.warnings.map(w => <div className="notice warn" key={w}>{w}</div>)}
                  <div className={`notice ${test.r.metrics.sharpe > test.bench.metrics.sharpe ? 'ok' : 'info'}`}>
                    {test.r.metrics.sharpe > test.bench.metrics.sharpe
                      ? `Beat buy & hold on risk-adjusted return (Sharpe ${num(test.r.metrics.sharpe)} vs ${num(test.bench.metrics.sharpe)}).`
                      : `Did not beat buy & hold on risk-adjusted return (Sharpe ${num(test.r.metrics.sharpe)} vs ${num(test.bench.metrics.sharpe)}).`}
                    {' '}{test.r.metrics.sharpe < train.best.metrics.sharpe - 0.3
                      ? `Sharpe fell ${num(train.best.metrics.sharpe - test.r.metrics.sharpe)} from training, a sign the settings may be fitted to luck.`
                      : 'Sharpe held up versus training, which is what you want to see.'}
                  </div>
                  <Kpis m={test.r.metrics} bench={test.bench.metrics} />
                  <EquityChart lines={testLines} />
                </>
              )}
            </div>
          )}

          {train && (
            <div className="card">
              <div className="card-title"><h2>Full numbers</h2>
                <div className="flex">
                  {saved ? <span className="tag green">Saved</span>
                    : <button className="btn btn-ghost btn-sm" onClick={save}>Save run</button>}
                </div>
              </div>
              {cloudEnabled && !session && <p className="hint">Not signed in — saved runs stay in this browser. <Link to="/account">Sign in</Link> to share them.</p>}
              <MetricTable cols={[
                { name: 'Train · strategy', m: train.best.metrics }, { name: 'Train · buy & hold', m: train.benchmark.metrics },
                ...(test ? [{ name: 'Test · strategy', m: test.r.metrics }, { name: 'Test · buy & hold', m: test.bench.metrics }] : []),
              ]} />
            </div>
          )}

          {train && gridKeys.length > 0 && (
            <div className="card">
              <div className="card-title"><h2>Settings tried (training only)</h2><span className="tag">{train.grid.length} combos</span></div>
              <p className="small muted">Good sign: the neighbours of the winner also do well. Bad sign: one setting wins and everything around it loses.</p>
              <div className="table-wrap">
                <table>
                  <thead><tr>{gridKeys.map(k => <th key={k}>{k}</th>)}<th>Sharpe</th><th>Return</th><th>Max DD</th><th>Trades</th></tr></thead>
                  <tbody>
                    {train.grid.map((g, i) => (
                      <tr key={i} className={i === 0 ? 'hl' : ''}>
                        {gridKeys.map(k => <td key={k}>{g.params[k]}</td>)}
                        <td>{num(g.metrics.sharpe)}</td><td>{pct(g.metrics.totalReturn)}</td>
                        <td>{pct(g.metrics.maxDrawdown)}</td><td>{g.metrics.trades}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(test?.r ?? train?.best) && (
            <div className="card">
              <div className="card-title"><h2>Trades ({test ? 'test' : 'training'})</h2><span className="tag">{(test?.r ?? train!.best).trades.length}</span></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Date</th><th>Side</th><th>Price</th><th>Qty</th><th>Fee</th><th>Cash after</th></tr></thead>
                  <tbody>
                    {(test?.r ?? train!.best).trades.slice(-60).reverse().map((t, i) => (
                      <tr key={i}><td>{day(t.t)}</td><td className={t.side === 'BUY' ? 'pos' : 'neg'}>{t.side}</td>
                        <td>{t.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td><td>{t.qty.toPrecision(4)}</td>
                        <td>{t.fee.toFixed(2)}</td><td>{t.cashAfter.toFixed(2)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
