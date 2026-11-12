import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Disclosure, Info } from '../components/Info'
import { fmtMoney, useCurrency } from '../lib/currency'
import { estimate, LAB, type LabRule, type LabState } from '../lib/lab'
import { supabase } from '../lib/supabase'
import { fmtPrice } from '../lib/markets'

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '–')
const pct0 = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–')
const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const day = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const cls = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '')
const KIND: Record<string, string> = { promote: 'Promoted', rollback: 'Rolled back', challenger: 'New challenger', retire: 'Retired', trade: 'Trade', note: 'Note' }
const COLORS: Record<string, string> = { john: 'var(--accent)', mark: '#3b6fd8', binance: '#d99a1e' }

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
  const px = (usd: number) => `${cur === 'AUD' ? 'A$' : '$'}${fmtPrice(cur === 'AUD' ? usd * rate : usd)}`
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
        <p>A paper-trading bot. It picks a buying rule that has worked in the past, trades it with pretend money, and swaps in a better rule
          only when one proves itself. It runs on its own every 5 hours. Nothing here places real orders.</p>
        <div className="howto">
          <div><span className="n">1</span><b>Three accounts, one rule</b>A$1,000 each on CoinSpot, Coinbase Advanced and Binance. They trade the same signals, so differences come from each exchange's fees and coins.</div>
          <div><span className="n">2</span><b>Only trades worth the cost</b>Mark's cost gate: it buys only when the expected gain beats the fees and price gap with room to spare.</div>
          <div><span className="n">3</span><b>Every trade has an exit</b>A stop-loss below the buy price and a time limit. Whichever comes first sells the coin.</div>
        </div>
      </div>

      {error && <div className="notice err">{error}</div>}
      {!state && !error && <div className="card empty">Loading the Lab… (a fresh check of 20 coins can take up to a minute)<div className="progress"><div /></div></div>}
      {preview && <div className="notice warn small">Preview: the Lab isn't saving yet, so this is a single trial run. It starts keeping its own record once its database table is set up.</div>}

      {state && (
        <>
          <section className="card">
            <div className="step-head">
              <span className="step-badge">Summary{state.lastRun ? ` · updated ${when(state.lastRun)}` : ''}</span>
              <h2>{champ ? 'How the paper accounts are doing' : 'No rule has earned a place yet: all accounts are in cash'}</h2>
            </div>
            <div className="kpis" style={{ gridTemplateColumns: `repeat(${accts.length}, minmax(0, 1fr))` }}>
              {accts.map(a => {
                const v = a.valueAud ?? a.startAud
                return (
                  <div className="kpi" key={a.id}>
                    <div className="label"><span className="dot" style={{ background: COLORS[a.id] }} /> {a.exchange}</div>
                    <div className="value">{money(v)}</div>
                    <div className={`sub ${cls(v / a.startAud - 1)}`}>{pct(v / a.startAud - 1)} since start ({money(a.startAud)})</div>
                    <div className="sub">{a.positions.length ? `${a.positions.length} coin${a.positions.length === 1 ? '' : 's'} held` : 'All in cash'} · {a.stats.n} finished trade{a.stats.n === 1 ? '' : 's'}{a.stats.n ? `, ${pct0(a.stats.wins / a.stats.n)} won` : ''}</div>
                  </div>
                )
              })}
            </div>
            <BalanceChart state={state} />
            <p className="hint">The chart shows each account's change since it started. A flat line means it's sitting in cash, waiting for a signal worth the cost.</p>
          </section>

          <section className="card">
            <h2>What it holds now</h2>
            {accts.map(a => (
              <div key={a.id} style={{ marginBottom: 14 }}>
                <h3>{a.exchange} <span className="muted small">· cash {money(a.cashAud)}</span></h3>
                {a.positions.length ? <div className="table-wrap"><table className="record">
                  <thead><tr><th>Coin</th><th>Price: bought → now</th><th>Value: put in → now <Info>Now = what you'd get selling right now, after the exchange fee and price gap.</Info></th><th>Stop-loss <Info>If the price falls to this level, the bot sells. Set when bought and never moved.</Info></th><th>Sells by <Info>If the stop-loss hasn't been hit, the coin is sold at this time whatever the price.</Info></th></tr></thead>
                  <tbody>{a.positions.map(p => {
                    const now = state.prices?.[p.base]
                    const worth = now ? p.units * now * (1 - p.spread / 2 - LAB.slippage) * (1 - a.fee) : NaN
                    const room = now ? p.stop / now - 1 : NaN
                    return (
                    <tr key={p.base}><td><Link to={`/predict?coin=${p.base}USDT`}><b>{p.base}</b></Link><div className="muted small">{day(p.t)}</div></td>
                      <td>{px(p.entryPx)} → {now ? px(now) : '–'}<div className={`small ${now ? cls(now / p.entryPx - 1) : ''}`}>{now ? pct(now / p.entryPx - 1) : ''}</div></td>
                      <td>{moneyUsd(p.costUsd)} → {now ? moneyUsd(worth) : '–'}<div className={`small ${now ? cls(worth / p.costUsd - 1) : ''}`}>{now ? pct(worth / p.costUsd - 1) : ''}</div></td>
                      <td><span className="neg">{px(p.stop)}</span><div className="muted small">{pct(p.stop / p.entryPx - 1, 0)}{Number.isFinite(room) ? ` · ${Math.round(Math.abs(room) * 100)}% away` : ''}</div></td>
                      <td>{day(p.exitT)}</td></tr>
                  )})}</tbody></table></div>
                  : <p className="muted small">Nothing held: waiting for the next signal that clears the cost gate.</p>}
                {a.closed.length > 0 && <Disclosure title={`Finished trades (${a.stats.n})`}>
                  <div className="table-wrap"><table className="record">
                    <thead><tr><th>Coin</th><th>Result after costs</th><th>Buy price</th><th>Sell price</th><th>Why sold</th><th>Sold</th></tr></thead>
                    <tbody>{a.closed.slice().reverse().map((c, i) => (
                      <tr key={i}><td><b>{c.base}</b></td><td className={cls(c.net)}>{pct(c.net)}</td><td>{px(c.entryPx)}</td><td>{px(c.exitPx)}</td><td>{c.why === 'stop' ? 'Stop-loss hit' : 'Time limit'}</td><td>{when(c.exitT)}</td></tr>
                    ))}</tbody></table></div>
                </Disclosure>}
              </div>
            ))}
            {trades.length > 0 && <Disclosure title="Trade log">
              <ul className="lab-events">{trades.map((e, i) => <li key={i}>{e.text} <span className="muted small">{when(e.t)}</span></li>)}</ul>
            </Disclosure>}
          </section>

          <section className="card">
            <h2>Stop-loss and safety rules</h2>
            <p className="muted small" style={{ marginTop: 0 }}>Fixed in the code. The bot can change which buying rule it uses, but never these.</p>
            <div className="explain-box">
              <h3>How the stop-loss is set</h3>
              <ul>
                <li><b>Distance:</b> about 2.5 times the coin's typical move over the holding period (using the last 20 days' daily swings, counting up to 10 days of holding). Calm coins get a tighter stop, wild coins a wider one, so ordinary wobbles don't trigger it.</li>
                <li><b>Limits:</b> never closer than 5% or further than 25% below the buy price.</li>
                <li><b>Fixed once set:</b> it isn't moved up or down while the coin is held (no trailing stop).</li>
                <li><b>Checked every 5 hours.</b> In a sudden crash the price can fall past the stop between checks, so the sale can land below it (one test trade on INIT sold 26% down against a 25% stop).</li>
                <li><b>Time limit:</b> if the stop isn't hit, the coin is sold when the rule's holding period ends ({champ ? `${champ.spec.H} days for the current rule` : 'set by the rule'}), win or lose.</li>
              </ul>
            </div>
            <div className="explain-box">
              <h3>Account limits</h3>
              <ul>
                <li><b>Size by the stop:</b> each position is sized so that hitting its stop-loses at most about {pct0(LAB.riskPerTrade)} of the account. A wide 25% stop means a small position (about 4%).</li>
                <li>No more than <b>{pct0(LAB.maxPosition)}</b> of an account in one coin, at most <b>{LAB.maxOpen}</b> coins at once, and at least <b>{pct0(1 - LAB.maxInvested)}</b> always in cash.</li>
              </ul>
            </div>
          </section>

          <section className="card">
            <h2>The rule it's using</h2>
            {champ ? (
              <RuleCard r={champ} title={`Current rule · v${champ.v}`} />
            ) : <p className="muted">Each week the bot tests {state.found?.length ?? 39} candidate rules. None passed both checks this time, so it waits rather than trading a rule that only looked good by luck.</p>}
            {changes.length > 0 && (<>
              <h3>Latest rule changes</h3>
              <ul className="lab-events">{changes.map((e, i) => <li key={i}><span className="tag">{KIND[e.kind] ?? e.kind}</span> {e.text} <span className="muted small">{when(e.t)}</span></li>)}</ul>
            </>)}
            {challengers.length > 0 && <Disclosure title={`Backup rules being tested on paper (${challengers.length})`}>
              <p className="muted small">These trade "in the shadow" with no money. One replaces the current rule only if its own live results beat it by at least {pct(LAB.promoteBy)} a trade over {LAB.promoteAfter}+ trades. The previous rule stays here, so a worse replacement gets rolled back automatically.</p>
              {challengers.map(r => <RuleCard key={r.v} r={r} title={`v${r.v}${r.wasChampion ? ' · previous rule' : ''}`} small />)}
            </Disclosure>}
            {retired.length > 0 && <Disclosure title={`Retired rules (${retired.length})`}>
              <ul className="lab-events">{retired.map(r => <li key={r.v}><b>v{r.v}</b> {r.text} <span className="muted small">— {r.reason}</span></li>)}</ul>
            </Disclosure>}
          </section>

          <section className="card">
            <h2>The cost gate</h2>
            <p className="muted small" style={{ marginTop: 0 }}>Mark's rule: only buy when the expected gain beats the full cost of buying and selling, plus a {pct(LAB.margin)} safety margin.</p>
            <div className="gate-grid">
              {accts.map(a => {
                const base = 2 * a.fee + 2 * LAB.slippage
                const est = champ ? estimate(champ.all) : NaN
                const ok = champ && est > base + LAB.margin
                return (
                  <div key={a.id} className="gate">
                    <div className="gate-name">{a.exchange}</div>
                    <div className="gate-line"><span>Buy + sell cost</span><b>≈ {pct(base)} + price gap</b></div>
                    <div className="gate-line"><span>Expected gain</span><b>{champ ? pct(est) : '–'}</b></div>
                    <div className="gate-verdict">{champ ? <span className={`tag ${ok ? 'green' : 'red'}`}>{ok ? 'Allowed to trade' : 'Blocked: costs too high'}</span> : <span className="tag">No rule yet</span>}</div>
                    <div className="muted small">Skipped so far: {a.blocked.cost} too costly · {a.blocked.quote} no price · {a.blocked.limits} limits</div>
                  </div>
                )
              })}
            </div>
            <p className="hint">Expected gain = the average of every past signal of this rule, losers included, minus a margin for luck. Price gap = the difference between the exchange's buy and sell prices, read live (CoinSpot coins missing from its public feed are assumed to have a 1% gap).</p>
            {accts.some(a => a.lastBlocked.length) && <Disclosure title="Recently skipped signals">
              <ul className="lab-events">{accts.flatMap(a => a.lastBlocked.slice(-5).reverse().map((b, i) => <li key={a.id + i}><b>{a.exchange}</b> skipped {b.base}: {b.why} <span className="muted small">{when(b.t)}</span></li>))}</ul>
            </Disclosure>}
          </section>

          {state.found && (
            <section className="card">
              <Disclosure title={<b>All {state.found.length} rules tested this week</b>}>
                <p className="muted small">Each rule was tried on every past signal across the 20 most-traded coins. To pass, it must make money after {pct(LAB.refCost)} costs a trade on the older data (at least {LAB.minTrain} trades, and clearly more than luck) <i>and</i> on the last {LAB.validDays} days, which it wasn't chosen on.</p>
                <div className="table-wrap"><table className="record">
                  <thead><tr><th>Rule</th><th>Older data</th><th>Last {LAB.validDays} days</th><th>Passed</th></tr></thead>
                  <tbody>{state.found.slice(0, 15).map(f => (
                    <tr key={f.id}><td style={{ minWidth: 200, whiteSpace: 'normal' }}>{f.text}</td>
                      <td className={cls(f.train.mean)}>{pct(f.train.mean)} · {f.train.n} trades</td>
                      <td className={cls(f.valid.mean)}>{pct(f.valid.mean)} · {f.valid.n} trades</td>
                      <td>{f.pass ? <span className="tag green">Yes</span> : <span className="tag">No</span>}</td></tr>
                  ))}</tbody></table></div>
                <p className="hint">Average result a trade after costs. Coins scanned: {state.coinsScanned?.join(', ')}.</p>
              </Disclosure>
            </section>
          )}

          <p className="hint">Fills are simulated at Binance's price plus each exchange's live price gap, fee and 0.1% slippage, so real fills will differ a little. A few weeks of paper results is still mostly luck: judge it over months.</p>
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
