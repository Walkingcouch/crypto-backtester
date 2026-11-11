import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Disclosure, Info } from '../components/Info'
import { fmtMoney, useCurrency } from '../lib/currency'
import { estimate, LAB, type LabRule, type LabState } from '../lib/lab'
import { supabase } from '../lib/supabase'

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '–')
const pct0 = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–')
const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const cls = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '')
const KIND: Record<string, string> = { promote: 'Promoted', rollback: 'Rolled back', challenger: 'New challenger', retire: 'Retired', trade: 'Trade', note: 'Note' }
const COLORS: Record<string, string> = { john: 'var(--accent)', mark: '#3b6fd8' }

function liveRecord(r: LabRule) {
  const g = (r.live?.trades ?? []).map(t => t.g)
  return { n: g.length, mean: g.length ? g.reduce((a, b) => a + b, 0) / g.length : NaN, win: g.length ? g.filter(x => x > 0).length / g.length : NaN }
}

function BalanceChart({ state }: { state: LabState }) {
  const accts = Object.values(state.accounts)
  const h = state.history
  if (h.length < 2) return <p className="muted small">The balance chart starts after a couple of runs (every 5 hours).</p>
  const W = 640, H = 180, P = 28
  const series = accts.map(a => ({ a, ys: h.map(p => (p[a.id] ?? a.startAud) / a.startAud - 1) }))
  const all = series.flatMap(s => s.ys)
  const lo = Math.min(-0.01, ...all), hi = Math.max(0.01, ...all)
  const x = (i: number) => P + (i / (h.length - 1)) * (W - P - 8)
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (H - 24)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Paper balances over time">
      <line x1={P} x2={W - 8} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeDasharray="4 4" />
      <text x={2} y={y(0) + 4} fontSize="11" fill="var(--faint)">0%</text>
      <text x={2} y={y(hi) + 4} fontSize="11" fill="var(--faint)">{pct(hi, 0)}</text>
      <text x={2} y={y(lo)} fontSize="11" fill="var(--faint)">{pct(lo, 0)}</text>
      {series.map(s => (
        <polyline key={s.a.id} fill="none" stroke={COLORS[s.a.id] ?? 'var(--muted)'} strokeWidth="2.5" strokeLinejoin="round"
          points={s.ys.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
      ))}
    </svg>
  )
}

export default function Lab() {
  const [state, setState] = useState<LabState | null>(null)
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { cur } = useCurrency()

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (supabase) {
          const { data } = await supabase.from('lab_state').select('data').eq('id', 'main').maybeSingle()
          if (data?.data) { if (alive) setState(data.data as LabState); return }
        }
        const r = await fetch('/api/lab-cron?dry=1')
        const j = await r.json()
        if (j.error) throw new Error(j.error)
        if (alive) { setState(j.state); setPreview(true) }
      } catch (e) { if (alive) setError(`Couldn't load the Lab: ${e instanceof Error ? e.message : e}`) }
    })()
    return () => { alive = false }
  }, [])

  const rate = state?.audPerUsd ?? 1.5
  const money = (aud: number) => fmtMoney(cur === 'AUD' ? aud : aud / rate, cur, Math.abs(aud) >= 100 ? 0 : 2)
  const moneyUsd = (usd: number) => money(usd * rate)
  const champ = state?.rules.find(r => r.status === 'champion')
  const challengers = state?.rules.filter(r => r.status === 'challenger') ?? []
  const retired = state?.rules.filter(r => r.status === 'retired') ?? []
  const changes = useMemo(() => (state?.events ?? []).filter(e => e.kind !== 'trade').slice(-3).reverse(), [state])
  const trades = useMemo(() => (state?.events ?? []).filter(e => e.kind === 'trade').slice(-12).reverse(), [state])
  const accts = state ? Object.values(state.accounts) : []

  return (
    <main className="page narrow">
      <div className="page-head">
        <h1>Lab</h1>
        <p>A paper-trading bot that finds its own buying rules, tests them on results, promotes the better ones and rolls back the
          worse ones. It runs by itself every 5 hours with pretend money: one account on CoinSpot fees (John) and one on Coinbase
          fees (Mark), so you can see what costs do to the same rule.</p>
        <div className="notice info small">Paper money only. Nothing here places real orders. It's a way to see whether a rule earns its keep after costs before any real money goes near it.</div>
      </div>

      {error && <div className="notice err">{error}</div>}
      {!state && !error && <div className="card empty">Loading the Lab… (a fresh check of 20 coins can take up to a minute)<div className="progress"><div /></div></div>}
      {preview && <div className="notice warn small">Preview: the Lab isn't saving yet, so this is a single trial run. It starts keeping its own record once its database table is set up.</div>}

      {state && (
        <>
          <section className="card">
            <div className="step-head">
              <span className="step-badge">Morning summary{state.lastRun ? ` · last run ${when(state.lastRun)}` : ''}</span>
              <h2>{champ ? 'Trading on paper' : 'No rule has earned a place yet: both accounts are in cash'}</h2>
            </div>
            <div className="kpis" style={{ gridTemplateColumns: `repeat(${accts.length}, minmax(0, 1fr))` }}>
              {accts.map(a => {
                const v = a.valueAud ?? a.startAud
                return (
                  <div className="kpi" key={a.id}>
                    <div className="label"><span className="dot" style={{ background: COLORS[a.id] }} /> {a.owner} · {a.exchange}</div>
                    <div className="value">{money(v)}</div>
                    <div className={`sub ${cls(v / a.startAud - 1)}`}>{pct(v / a.startAud - 1)} since start ({money(a.startAud)})</div>
                    <div className="sub">{a.stats.n} closed trade{a.stats.n === 1 ? '' : 's'}{a.stats.n ? ` · won ${pct0(a.stats.wins / a.stats.n)}` : ''} · {a.positions.length} open</div>
                  </div>
                )
              })}
            </div>
            <BalanceChart state={state} />
            {changes.length > 0 && (<>
              <h3>Latest rule changes</h3>
              <ul className="lab-events">{changes.map((e, i) => <li key={i}><span className="tag">{KIND[e.kind] ?? e.kind}</span> {e.text} <span className="muted small">{when(e.t)}</span></li>)}</ul>
            </>)}
          </section>

          <section className="card">
            <h2>The rule book</h2>
            {champ ? (
              <RuleCard r={champ} title={`Trading now · v${champ.v}`} />
            ) : <p className="muted">Each week the bot tests {state.found?.length ?? 39} candidate rules. None passed both checks this time, so it waits rather than trading a rule that only looked good by luck.</p>}
            {challengers.length > 0 && <>
              <h3>Challengers on paper <Info>These rules trade "in the shadow" alongside the current one. One takes over only when its own live record beats the current rule by at least {pct(LAB.promoteBy)} a trade over {LAB.promoteAfter}+ trades. A rule that used to trade stays here, so if its replacement does worse it's rolled back automatically.</Info></h3>
              {challengers.map(r => <RuleCard key={r.v} r={r} title={`v${r.v}${r.wasChampion ? ' · previous rule' : ''}`} small />)}
            </>}
            {retired.length > 0 && <Disclosure title={`Retired rules (${retired.length})`}>
              <ul className="lab-events">{retired.map(r => <li key={r.v}><b>v{r.v}</b> {r.text} <span className="muted small">— {r.reason}</span></li>)}</ul>
            </Disclosure>}
          </section>

          <section className="card">
            <h2>The cost gate <Info>Mark's rule: only open a position when the conservative estimate of its gain beats the full cost of buying and selling plus a safety margin. The estimate is the average result of every past signal of this rule, losers included, minus a margin for luck (one standard error). Stop-losses always execute, even at a loss.</Info></h2>
            <div className="table-wrap"><table className="record">
              <thead><tr><th></th>{accts.map(a => <th key={a.id}>{a.owner} · {a.exchange}</th>)}</tr></thead>
              <tbody>
                <tr><td>Fee each way</td>{accts.map(a => <td key={a.id}>{a.feeLabel}</td>)}</tr>
                <tr><td>Round trip <Info>Fee in and out, plus the gap between buy and sell prices (spread, from the exchange's live quote), plus {pct(LAB.slippage)} slippage each way.</Info></td>
                  {accts.map(a => <td key={a.id}>≈ {pct(2 * a.fee + 2 * LAB.slippage)} + spread</td>)}</tr>
                {champ && <tr><td>Rule's estimated gain</td>{accts.map(a => <td key={a.id}>{pct(estimate(champ.all))} a trade</td>)}</tr>}
                {champ && <tr><td>Clears costs + {pct(LAB.margin)} margin?</td>{accts.map(a => {
                  const ok = estimate(champ.all) > 2 * a.fee + 2 * LAB.slippage + LAB.margin
                  return <td key={a.id}><span className={`tag ${ok ? 'green' : 'red'}`}>{ok ? 'Yes, before spread' : 'No: trades blocked'}</span></td>
                })}</tr>}
                <tr><td>Signals blocked</td>{accts.map(a => <td key={a.id}>{a.blocked.cost} by cost · {a.blocked.quote} no quote · {a.blocked.limits} by risk limits</td>)}</tr>
              </tbody>
            </table></div>
            {accts.some(a => a.lastBlocked.length) && <Disclosure title="Recently skipped signals">
              <ul className="lab-events">{accts.flatMap(a => a.lastBlocked.slice(-5).reverse().map((b, i) => <li key={a.id + i}><b>{a.owner}</b> skipped {b.base}: {b.why} <span className="muted small">{when(b.t)}</span></li>))}</ul>
            </Disclosure>}
          </section>

          <section className="card">
            <h2>Positions</h2>
            {accts.map(a => (
              <div key={a.id} style={{ marginBottom: 14 }}>
                <h3>{a.owner} · cash {money(a.cashAud)}</h3>
                {a.positions.length ? <div className="table-wrap"><table className="record">
                  <thead><tr><th>Coin</th><th>Size</th><th>Bought</th><th>Stop</th><th>Sell by</th><th>Rule</th></tr></thead>
                  <tbody>{a.positions.map(p => (
                    <tr key={p.base}><td><Link to={`/predict?coin=${p.base}USDT`}><b>{p.base}</b></Link></td><td>{moneyUsd(p.costUsd)}</td>
                      <td>{when(p.t)}</td><td className="neg">{pct(p.stop / p.entryPx - 1)}</td><td>{when(p.exitT)}</td><td>v{p.v}</td></tr>
                  ))}</tbody></table></div> : <p className="muted small">No open positions.</p>}
                {a.closed.length > 0 && <Disclosure title={`Closed trades (${a.stats.n})`}>
                  <div className="table-wrap"><table className="record">
                    <thead><tr><th>Coin</th><th>Result after costs</th><th>Before costs</th><th>Why sold</th><th>Sold</th></tr></thead>
                    <tbody>{a.closed.slice().reverse().map((c, i) => (
                      <tr key={i}><td><b>{c.base}</b></td><td className={cls(c.net)}>{pct(c.net)}</td><td>{pct(c.gross)}</td><td>{c.why === 'stop' ? 'Stop-loss' : 'Time up'}</td><td>{when(c.exitT)}</td></tr>
                    ))}</tbody></table></div>
                </Disclosure>}
              </div>
            ))}
            {trades.length > 0 && <Disclosure title="Recent trade log">
              <ul className="lab-events">{trades.map((e, i) => <li key={i}>{e.text} <span className="muted small">{when(e.t)}</span></li>)}</ul>
            </Disclosure>}
          </section>

          {state.found && (
            <section className="card">
              <h2>Rules tested this week <Info>Every candidate is tried on all past signals across the 20 most-traded coins. It must be clearly profitable after {pct(LAB.refCost)} round-trip costs on the older data (at least {LAB.minTrain} trades, a t-score of {LAB.minTrainT}+), and still profitable on the last {LAB.validDays} days, which it was never chosen on.</Info></h2>
              <div className="table-wrap"><table className="record">
                <thead><tr><th>Rule</th><th>Older data</th><th>Last {LAB.validDays} days</th><th>Passed</th></tr></thead>
                <tbody>{state.found.slice(0, 12).map(f => (
                  <tr key={f.id}><td style={{ minWidth: 200, whiteSpace: 'normal' }}>{f.text}</td>
                    <td className={cls(f.train.mean)}>{pct(f.train.mean)} · {f.train.n} trades</td>
                    <td className={cls(f.valid.mean)}>{pct(f.valid.mean)} · {f.valid.n} trades</td>
                    <td>{f.pass ? <span className="tag green">Yes</span> : <span className="tag">No</span>}</td></tr>
                ))}</tbody></table></div>
              <p className="hint">Results per trade after {pct(LAB.refCost)} costs. Coins scanned: {state.coinsScanned?.join(', ')}.</p>
            </section>
          )}

          <section className="card">
            <h2>How the Lab works</h2>
            <ol className="how-list">
              <li><b>Find rules:</b> once a week it tests {state.found?.length ?? 39} candidate rules (breakouts after quiet or wild fortnights, dips in uptrends, surges, crashes) on about 2½ years of daily prices for the 20 most-traded coins.</li>
              <li><b>Check them honestly:</b> a rule must make money after costs on the older data <i>and</i> on the last {LAB.validDays} days it was never chosen on.</li>
              <li><b>Trade the best one</b> on paper. Every 5 hours it checks stop-losses and time limits; after each daily close it looks for new signals.</li>
              <li><b>Cost gate</b> (Mark's rule): skip any entry whose conservative gain estimate doesn't beat fees, spread, slippage and a {pct(LAB.margin)} margin. If there's no live quote from the exchange, it skips too.</li>
              <li><b>Challengers in the shadow:</b> up to {LAB.maxChallengers} other rules trade on paper alongside. They're judged on batches of {LAB.promoteAfter}+ trades, never one loss, and the previous rule is kept so a worse replacement gets rolled back.</li>
              <li><b>Fixed risk limits</b> the bot can't change: at most {pct0(LAB.maxPosition)} of an account per coin, a stop-loss costs at most about {pct0(LAB.riskPerTrade)} of the account, at most {LAB.maxOpen} positions, and at least {pct0(1 - LAB.maxInvested)} in cash.</li>
            </ol>
            <p className="hint">Fills are simulated at Binance's price plus the exchange's live spread, fee and slippage, so real fills will differ a little. A few weeks of paper results is still mostly luck; judge it on months.</p>
          </section>
        </>
      )}
    </main>
  )
}

function RuleCard({ r, title, small }: { r: LabRule; title: string; small?: boolean }) {
  const live = liveRecord(r)
  return (
    <div className={`lab-rule ${small ? 'small' : ''}`}>
      <div className="lab-rule-head"><span className={`tag ${r.status === 'champion' ? 'green' : ''}`}>{title}</span>{r.reason && <span className="muted small">{r.reason}</span>}</div>
      <p className="lab-rule-text">{r.text}</p>
      <div className="lab-rule-stats">
        <span>Past signals: <b className={cls(r.all.mean)}>{pct(r.all.mean)}</b> a trade before costs, won {pct0(r.all.win)} of {r.all.n}</span>
        <span>Conservative estimate: <b>{pct(estimate(r.all))}</b></span>
        <span>Live on paper: {live.n ? <><b className={cls(live.mean)}>{pct(live.mean)}</b> a trade over {live.n}, won {pct0(live.win)}</> : 'no closed trades yet'}</span>
      </div>
    </div>
  )
}
