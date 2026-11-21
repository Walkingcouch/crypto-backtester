import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Disclosure, Info } from '../components/Info'
import { fmtMoney, useCurrency } from '../lib/currency'
import { estimate, feeFrac, LAB, type LabRule, type LabState, type Rigor, type Account } from '../lib/lab'
import { EXPLORE, hurdle } from '../lib/explorer'
import { DT } from '../lib/daytrade'
import { STOCK, STOCK_EXPLORE, US, ASX } from '../lib/stocks'
import { SDT, US_DAY, ASX_DAY } from '../lib/stockday'
import { supabase } from '../lib/supabase'
import { cardFor } from '../lib/cards'
import { fmtPrice } from '../lib/markets'

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '–')
const pct0 = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–')
const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const day = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const cls = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '')
const KIND: Record<string, string> = { promote: 'Promoted', rollback: 'Rolled back', challenger: 'New challenger', retire: 'Retired', trade: 'Trade', note: 'Note' }
const COLORS: Record<string, string> = { john: 'var(--accent)', mark: '#3b6fd8', binance: '#d99a1e', ibus: '#3b6fd8', ibasx: '#d99a1e' }
type Family = 'crypto' | 'shares'

function liveRecord(r: LabRule) {
  const g = (r.live?.trades ?? []).map(t => t.g)
  return { n: g.length, mean: g.length ? g.reduce((a, b) => a + b, 0) / g.length : NaN, win: g.length ? g.filter(x => x > 0).length / g.length : NaN }
}

function BalanceChart({ state }: { state: LabState }) {
  const accts = Object.values(state.accounts)
  const h = state.history
  if (h.length < 2) return <p className="muted small">The balance chart starts after a couple of runs.</p>
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

type Settings = typeof LAB
interface Variant {
  key: 'swing' | 'explore' | 'day' | 'sswing' | 'sexplore' | 'sday'; kind: 'swing' | 'explore' | 'day'; family: Family
  sid: string; api: string; S: Settings
  title: string; intro: ReactNode; howto: [string, string][]
  unit: string; every: string; noRule: string; tested: ReactNode; stops: ReactNode
}

const STOPS_SWING = (S: Settings, H?: number) => (<ul>
  <li><b>Distance:</b> about 2.5 times the coin's typical move over the holding period (using the last 20 days' daily swings, counting up to 10 days of holding). Calm coins get a tighter stop, wild coins a wider one, so ordinary wobbles don't trigger it.</li>
  <li><b>Limits:</b> never closer than 5% or further than 25% below the buy price.</li>
  <li><b>Fixed once set:</b> it isn't moved up or down while the coin is held (no trailing stop).</li>
  <li><b>Checked every 2 hours.</b> In a sudden crash the price can fall past the stop between checks, so the sale can land below it (two test trades sold about 26% down against a 25% stop).</li>
  <li><b>Time limit:</b> if the stop isn't hit, the coin is sold when the rule's holding period ends ({H ? `${H} days for the current rule` : 'set by the rule'}), win or lose.</li>
  <li><b>Size by the stop:</b> each position loses at most about {pct0(S.riskPerTrade)} of the account if its stop is hit. No more than {pct0(S.maxPosition)} in one coin, at most {S.maxOpen} coins at once, at least {pct0(1 - S.maxInvested)} in cash.</li>
</ul>)

const VARIANTS: Record<Variant['key'], Omit<Variant, 'stops'> & { stops: (S: Settings, H?: number) => ReactNode }> = {
  sswing: {
    key: 'sswing', kind: 'swing', family: 'shares', sid: 'stocks', api: '/api/stocks-cron?dry=1', S: STOCK as unknown as Settings, title: 'Swing rules', unit: 'trading days', every: 'on weekdays after each market closes (4:00pm Darwin for the ASX, 7:00am Darwin for the US)',
    intro: <>Tests share strategies the way professional equity quants do, on the S&amp;P 100 and ASX 50 ({US.length + ASX.length} shares and index funds, about 5 years of daily prices). The 19 rules are built for shares: factor portfolios that rank every share against the others (12-month momentum, 1-month reversal, low volatility), trend following, the turn-of-the-month effect, 52-week highs, short-term pullbacks and classic breakouts. A rule only counts if it <b>beats the market index</b> (S&amp;P 500 or ASX 200) over the same days, after Interactive Brokers' real fees.</>,
    howto: [['Two A$10,000 accounts', "One trades US shares, one trades ASX shares, both at Interactive Brokers. Bigger than the crypto accounts because each order has a minimum fee (A$5.50 on the ASX), which eats small trades."],
      ['Only trades worth the cost', 'The same cost gate: it buys only when the expected gain beats the brokerage, price gap and slippage on that order size, with room to spare.'],
      ['Once a day, after the close', "Signals use each market's finished daily bar. Every position has a stop-loss and a time limit."]],
    noRule: "Each week the bot re-tests its 19 rules. None beat the index clearly enough on both older and recent data, so it waits in cash. That's common: beating the index after costs is hard, which is why most professionals' benchmark is the index fund itself.",
    tested: <>Each rule was tried on every past signal over about 5 years and judged on its return <b>above the market index</b> over the same days, after realistic costs (about 0.2% a round trip for US shares, 0.5% for ASX shares). To pass: at least {STOCK.minTrain} trades and a t-score of {STOCK.minTrainT}+ on the older data (the higher bar professionals use when testing many ideas), <i>and</i> still ahead of the index on the last {STOCK.validDays} days. The share lists are today's index members, which flatters past results a little (survivorship bias).</>,
    stops: (S: Settings, H?: number) => (<ul>
      <li><b>Distance:</b> about 2.5 times the share's typical move over the holding period, never closer than 5% or further than 25% below the buy price.</li>
      <li><b>Checked once a day</b> at the close. A share that gaps down overnight can sell below its stop.</li>
      <li><b>Time limit:</b> sold when the rule's holding period ends ({H ? `${H} trading days for the current rule` : 'set by the rule'}), win or lose.</li>
      <li><b>Size by the stop:</b> each position loses at most about {pct0(S.riskPerTrade)} of the account at its stop. No more than {pct0(S.maxPosition)} in one share, {S.maxOpen} at once, at least {pct0(1 - S.maxInvested)} in cash.</li>
    </ul>),
  },
  sexplore: {
    key: 'sexplore', kind: 'explore', family: 'shares', sid: 'stocks-explore', api: '/api/stocks-explorer-cron?dry=1', S: STOCK_EXPLORE as unknown as Settings, title: 'New ideas', unit: 'trading days', every: 'on weekdays after each market closes (4:10pm Darwin for the ASX, 7:10am Darwin for the US)',
    intro: <>The idea factory from the crypto lab, on the same {US.length} US and {ASX.length} ASX shares: it combines building blocks (new highs, moving averages, momentum, dips, volume spikes, calm or wild markets, and the market's own trend: the S&amp;P 500 for US shares, the ASX 200 for ASX shares) into new rules, keeps the fittest and breeds variations. Only ideas that pass an honest check trade on paper.</>,
    howto: [['Invent and breed', 'Each run adds about 100 new ideas: random new ones, small changes to the best so far, and mixes of two good ones.'],
      ['A bar that rises', 'The more ideas tried, the higher the bar, and each idea gets just one look at the held-back last 180 days.'],
      ['Graduates trade on paper', "Ideas that pass go to two A$10,000 Interactive Brokers accounts (US and ASX), with the same cost gate, stop-losses and rollback rules."]],
    noRule: 'No invented idea has passed the checks yet. Most ideas fail, and the ones that pass need to clear a high bar.',
    tested: <>Graduates only: invented ideas that cleared the rising bar on older data and then made money after costs on the held-back last {STOCK_EXPLORE.validDays} days.</>,
    stops: (S: Settings, H?: number) => (<ul>
      <li><b>Distance:</b> set by each idea: 1.5, 2.5 or 3.5 times the share's typical move over the hold, between 5% and 25% below the buy price.</li>
      <li><b>Checked once a day</b> at the close. A share that gaps down overnight can sell below its stop.</li>
      <li><b>Time limit:</b> sold when the idea's holding period ends ({H ? `${H} trading days for the current rule` : 'set by the idea'}), win or lose.</li>
      <li><b>Size by the stop:</b> each position loses at most about {pct0(S.riskPerTrade)} of the account at its stop. No more than {pct0(S.maxPosition)} in one share, {S.maxOpen} at once.</li>
    </ul>),
  },
  sday: {
    key: 'sday', kind: 'day', family: 'shares', sid: 'stocks-day', api: '/api/stocks-day-cron?dry=1', S: SDT as unknown as Settings, title: 'Day trading', unit: 'hours', every: 'every half hour while the ASX or US market is open, weekdays only',
    intro: <>Day-trading rules from published research on 1-hour bars of {US_DAY.length} liquid US shares and funds and {ASX_DAY.length} big ASX shares. Every position is sold by that market's close (US 4:00pm New York, ASX 4:00pm Sydney). Same honest loop as the crypto day-trading lab, at Interactive Brokers' fees.</>,
    howto: [['Five research-backed families', 'Intraday momentum (the first hour predicts the last), gap-down fill, opening-range breakout, volatility breakout and overreaction reversal, each with and without a daily-trend filter (34 rules).'],
      ['US needs US$25,000', "US brokers, Interactive Brokers included, limit margin accounts under US$25,000 to 3 day trades in 5 days. So the US account starts at A$40,000; the ASX account at A$10,000."],
      ['Tight limits', `Stops on every trade, at most ${(SDT.riskPerTrade * 100).toFixed(1)}% of the account at risk per trade, and no new trades for the rest of the day after a ${pct0(SDT.dailyLossLimit)} drop.`]],
    noRule: 'No day-trading rule passed both checks after costs. That is the most common honest result: most published intraday edges are smaller than the cost of trading them.',
    tested: <>Each rule was tried on about 2¾ years of hourly bars. To pass: at least {SDT.minTrain} trades and a t-score of {SDT.minTrainT}+ after {pct(SDT.refCost)} costs a trade on the older data, and still profitable on the last {SDT.validDays} days.</>,
    stops: (S: Settings) => (<ul>
      <li><b>Distance:</b> 2 times the share's typical hourly move over the planned hold, between 0.5% and 4% below the buy price.</li>
      <li><b>Checked on every hourly bar</b> since the buy, including gaps: if a bar opens below the stop, the sale happens at that open.</li>
      <li><b>Market close:</b> everything is sold at that market's close, win or lose. Some rules sell earlier, after a set number of hours.</li>
      <li><b>Risk per trade:</b> each position loses at most about {(S.riskPerTrade * 100).toFixed(1)}% of the account at its stop; at most {pct0(S.maxPosition)} in one share and {S.maxOpen} positions at once.</li>
      <li><b>Daily loss limit:</b> after a {pct0(SDT.dailyLossLimit)} fall in a day ({pct0(SDT.practiceLossLimit)} in learning mode), no new trades until the next day.</li>
      <li><b>Big releases:</b> no new trades within an hour of a high-impact release for that market (CPI, jobs, Fed, RBA), then half size for the rest of that session.</li>
      <li><b>Losing streak:</b> after a {pct0(SDT.ddCut)} fall from an account's best value, every new trade is half size until it recovers.</li>
    </ul>),
  },
  swing: {
    key: 'swing', kind: 'swing', family: 'crypto', sid: 'main', api: '/api/lab-cron?dry=1', S: LAB, title: 'Swing rules', unit: 'days', every: 'every 2 hours',
    intro: <>A paper-trading bot that picks from a fixed menu of 39 swing-trading rules (held 3–20 days), trades the best one with pretend money, and swaps in a better rule only when one proves itself.</>,
    howto: [['Three accounts, one rule', "A$1,000 each on CoinSpot, Coinbase Advanced and Binance. Differences come from each exchange's fees and coins."],
      ['Only trades worth the cost', "Mark's cost gate: it buys only when the expected gain beats the fees and price gap with room to spare."],
      ['Every trade has an exit', 'A stop-loss below the buy price and a time limit. Whichever comes first sells the coin.']],
    noRule: 'Each week the bot re-tests its 39 rules. None passed both checks this time, so it waits rather than trading a rule that only looked good by luck.',
    tested: <>Each rule was tried on every past signal across the 20 most-traded coins. To pass, it must make money after {pct(LAB.refCost)} costs a trade on the older data (at least {LAB.minTrain} trades, and clearly more than luck) <i>and</i> on the last {LAB.validDays} days, which it wasn't chosen on.</>,
    stops: STOPS_SWING,
  },
  explore: {
    key: 'explore', kind: 'explore', family: 'crypto', sid: 'explorer', api: '/api/explorer-cron?dry=1', S: EXPLORE as Settings, title: 'New ideas', unit: 'days', every: 'every 2 hours',
    intro: <>This lab invents strategies the other one never had: it combines building blocks (breakouts, trends, dips, volume spikes, calm or wild markets, Bitcoin's own trend) into new rules, keeps the fittest, and breeds variations of them. Only ideas that pass an honest check get to trade on paper.</>,
    howto: [['Invent and breed', 'Each run adds about 40 new ideas: random new ones, small changes to the best so far, and mixes of two good ones.'],
      ['A bar that rises', 'Try enough ideas and some look great by luck. So the bar an idea must clear rises with the number tried, and each idea gets just one look at the held-back last 180 days.'],
      ['Graduates trade on paper', 'Ideas that pass go to the same three A$1,000 accounts, cost gate, stop-losses and rollback rules as the main Lab.']],
    noRule: 'No invented idea has passed the checks yet. That is normal early on: most ideas fail, and the ones that pass need to clear a high bar.',
    tested: <>Graduates only: invented ideas that cleared the rising bar on older data and then made money after costs on the held-back last {EXPLORE.validDays} days.</>,
    stops: STOPS_SWING,
  },
  day: {
    key: 'day', kind: 'day', family: 'crypto', sid: 'daytrade', api: '/api/daytrade-cron?dry=1', S: DT as unknown as Settings, title: 'Day trading', unit: 'hours', every: 'every hour',
    intro: <>Tests day-trading rules from published research on 1-hour candles, and closes every position by the end of the day (00:00 UTC, 9:30am Darwin). Same honest loop as the main Lab, plus a walk-forward test and a daily loss limit. It watches every coin CoinSpot sells that also trades on Binance with at least US$1M a day; rules are chosen on 5 years of the 10 most-traded coins. Expect most rules to fail once costs are counted.</>,
    howto: [['Six families of ideas', "Intraday momentum, overreaction reversal, opening-range breakout, volatility breakout, calm-market mean reversion and 'recent movers' (buying right after a big 1-hour jump), each with and without a daily-trend filter (58 rules)."],
      ['Costs decide everything', 'A day trade must beat a full buy and sell. CoinSpot instant buy/sell is 1% each way plus its price gap, so about 3% a round trip; Coinbase is 0.6% each way. Few day trades clear that.'],
      ['Tight limits', `Stops on every trade, at most ${(DT.riskPerTrade * 100).toFixed(1)}% of the account at risk per trade, and no new trades for the rest of the day after a ${pct0(DT.dailyLossLimit)} drop.`]],
    noRule: 'No day-trading rule passed both checks after costs. That is the most common honest result: most published intraday edges are smaller than the cost of trading them.',
    tested: <>Each rule was tried on about 5 years of hourly candles for the 10 most-traded coins (signals then run on every CoinSpot coin). To pass: at least {DT.minTrain} trades and a t-score of {DT.minTrainT}+ after {pct(DT.refCost)} costs a trade on the older data, and still profitable on the last {DT.validDays} days.</>,
    stops: (S: Settings) => (<ul>
      <li><b>Distance:</b> 2 times the coin's typical hourly move over the planned hold, between 0.8% and 5% below the buy price.</li>
      <li><b>Checked on every hourly candle</b> since the buy, including gaps: if a candle opens below the stop, the sale happens at that open.</li>
      <li><b>End of day:</b> everything is sold by 00:00 UTC (9:30am Darwin), win or lose. Some rules sell earlier, after a set number of hours or when price gets back to its 24-hour average.</li>
      <li><b>Risk per trade:</b> each position loses at most about {(S.riskPerTrade * 100).toFixed(1)}% of the account at its stop; at most {pct0(S.maxPosition)} in one coin and {S.maxOpen} positions at once.</li>
      <li><b>Daily loss limit:</b> after a {pct0(DT.dailyLossLimit)} fall in a day ({pct0(DT.practiceLossLimit)} in learning mode), no new trades until the next UTC day.</li>
      <li><b>Big US releases:</b> no new trades 30 minutes either side of a high-impact US release (CPI, jobs, Fed), then half size for the rest of that UTC day.</li>
      <li><b>Losing streak:</b> after a {pct0(DT.ddCut)} fall from an account's best value, every new trade is half size until it recovers.</li>
    </ul>),
  },
}

export function LabSwing() { return <LabView v={VARIANTS.swing} /> }
export function SharesSwing() { return <LabView v={VARIANTS.sswing} /> }
export function SharesExplore() { return <LabView v={VARIANTS.sexplore} /> }
export function SharesDay() { return <LabView v={VARIANTS.sday} /> }
export function LabExplore() { return <LabView v={VARIANTS.explore} /> }
export function LabDay() { return <LabView v={VARIANTS.day} /> }
export default LabSwing

/** The rule engine says "coin"; on the shares lab, say "share". */
function words(st: LabState, family: Family): LabState {
  if (family !== 'shares' || !st) return st
  const w = (t: string) => t.replace(/\bcoins\b/g, 'shares').replace(/\bcoin\b/g, 'share').replace(/\.AX\b/g, '')
    .replace(/Bitcoin is above/g, 'the market index is above').replace(/Bitcoin is below/g, 'the market index is below').replace(/\bBitcoin\b/g, 'the market index')
  for (const r of st.rules) r.text = w(r.text)
  for (const e of st.events) e.text = w(e.text)
  for (const f of st.found ?? []) f.text = w(f.text)
  for (const a of Object.values(st.accounts)) for (const b of a.lastBlocked) b.why = w(b.why)
  return st
}

export function LabTabs({ family }: { family: Family }) {
  const base = family === 'crypto' ? '/lab' : '/shares'
  return (
    <div className="lab-tabs">
      <NavLink to={base} end>Swing rules</NavLink>
      <NavLink to={`${base}/explore`}>New ideas</NavLink>
      <NavLink to={`${base}/daytrade`}>Day trading</NavLink>
      {family === 'shares' && <NavLink to="/shares/calendar">Economic calendar</NavLink>}
    </div>
  )
}

function LabView({ v }: { v: Omit<Variant, 'stops'> & { stops: (S: Settings, H?: number) => ReactNode } }) {
  const S = v.S
  const [state, setState] = useState<LabState | null>(null)
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { cur } = useCurrency()

  useEffect(() => {
    let alive = true
    setState(null); setPreview(false); setError(null)
    ;(async () => {
      try {
        if (supabase) {
          const { data } = await supabase.from('lab_state').select('data').eq('id', v.sid).maybeSingle()
          if (data?.data) { if (alive) setState(words(data.data as LabState, v.family)); return }
        }
        const r = await fetch(v.api)
        const j = await r.json()
        if (j.error) throw new Error(j.error)
        if (alive) { setState(words(j.state, v.family)); setPreview(true) }
      } catch (e) { if (alive) setError(`Couldn't load the Lab: ${e instanceof Error ? e.message : e}`) }
    })()
    return () => { alive = false }
  }, [v.sid, v.api])

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
  const shares = v.family === 'shares'
  const noun = shares ? 'share' : 'coin'

  return (
    <main className="page narrow">
      <div className="page-head">
        <div className="lab-family">{v.family === 'crypto' ? 'Crypto lab' : 'Shares lab · US & ASX'}</div>
        <h1>{v.title}</h1>
        <LabTabs family={v.family} />
        <p>{v.intro} It runs on its own {v.every}. Nothing here places real orders.</p>
        <div className="howto">
          {v.howto.map(([b, t], k) => <div key={k}><span className="n">{k + 1}</span><b>{b}</b>{t}</div>)}
        </div>
      </div>

      {error && <div className="notice err">{error}</div>}
      {!state && !error && <div className="card empty">Loading… (a fresh check of the market can take up to a minute)<div className="progress"><div /></div></div>}
      {preview && <div className="notice warn small">Preview: this lab isn't saving yet, so this is a single trial run. It starts keeping its own record once its scheduled job is switched on.</div>}

      {state && (
        <>
          <section className="card">
            <div className="step-head">
              <span className="step-badge">Summary{state.lastRun ? ` · updated ${when(state.lastRun)}` : ''}</span>
              <h2>{champ ? (champ.practice ? 'Learning mode: trying several ideas on paper, dropping losers fast' : 'How the paper accounts are doing') : 'No rule has earned a place yet: all accounts are in cash'}</h2>
              {champ?.practice && <p className="hint">No rule has passed the strict checks yet, so instead of waiting the lab learns by doing. Several different ideas trade the paper accounts at once, with every fee and price gap charged; one slot always goes to an untried idea. Each idea gets a fair run of at least {state.learning?.minHoldDays ?? 14} days, and losing trades along the way are expected. Each live trade is compared with what's normal for that rule on that same coin or share; an idea is benched only when, after {state.learning?.failAfter ?? 20}+ trades, it's doing so much worse than its own normal that bad luck can't explain it. Losses here are the cost of finding out what works.{state.learning ? ` Now: ${state.learning.active} ideas trading, ${state.learning.eligible} active enough to try, ${state.learning.benched} benched.` : ''}</p>}
            </div>
            <div className="kpis" style={{ gridTemplateColumns: `repeat(${accts.length}, minmax(0, 1fr))` }}>
              {accts.map(a => {
                const v = a.valueAud ?? a.startAud
                return (
                  <div className="kpi" key={a.id}>
                    <div className="label"><span className="dot" style={{ background: COLORS[a.id] }} /> {a.exchange}</div>
                    <div className="value">{money(v)}</div>
                    <div className={`sub ${cls(v / a.startAud - 1)}`}>{pct(v / a.startAud - 1)} since start ({money(a.startAud)})</div>
                    <div className="sub">{a.positions.length ? `${a.positions.length} ${noun}${a.positions.length === 1 ? '' : 's'} held` : 'All in cash'} · {a.stats.n} finished trade{a.stats.n === 1 ? '' : 's'}{a.stats.n ? `, ${pct0(a.stats.wins / a.stats.n)} won` : ''}</div>
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
                  <thead><tr><th>{shares ? 'Share' : 'Coin'}</th><th>Price: bought → now</th><th>Value: put in → now <Info>Now = what you'd get selling right now, after the exchange fee and price gap.</Info></th><th>Stop-loss <Info>If the price falls to this level, the bot sells. Set when bought and never moved.</Info></th><th>Sells by <Info>If the stop-loss hasn't been hit, the coin is sold at this time whatever the price.</Info></th></tr></thead>
                  <tbody>{a.positions.map(p => {
                    const now = state.prices?.[p.base]
                    const worth = now ? p.units * now * (1 - p.spread / 2 - S.slippage) * (1 - a.fee) : NaN
                    const room = now ? p.stop / now - 1 : NaN
                    return (
                    <tr key={`${p.base}-${p.v}`}><td>{shares ? <b>{p.base.replace('.AX', '')}</b> : <Link to={`/predict?coin=${p.base}USDT`}><b>{p.base}</b></Link>}<div className="muted small">{day(p.t)}{p.v ? ` · rule v${p.v}` : ''}</div></td>
                      <td>{px(p.entryPx)} → {now ? px(now) : '–'}<div className={`small ${now ? cls(now / p.entryPx - 1) : ''}`}>{now ? pct(now / p.entryPx - 1) : ''}</div></td>
                      <td>{moneyUsd(p.costUsd)} → {now ? moneyUsd(worth) : '–'}<div className={`small ${now ? cls(worth / p.costUsd - 1) : ''}`}>{now ? pct(worth / p.costUsd - 1) : ''}</div></td>
                      <td><span className="neg">{px(p.stop)}</span><div className="muted small">{pct(p.stop / p.entryPx - 1, 0)}{Number.isFinite(room) ? ` · ${Math.round(Math.abs(room) * 100)}% away` : ''}</div></td>
                      <td>{day(p.exitT)}</td></tr>
                  )})}</tbody></table></div>
                  : <p className="muted small">Nothing held: waiting for the next signal that clears the cost gate.</p>}
                {a.closed.length > 0 && <Disclosure title={`Finished trades (${a.stats.n})`}>
                  <p className="small"><button className="btn small" onClick={() => downloadTrades(a, v.title)}>Download trades (CSV)</button> <span className="muted">R = result as a multiple of the risk taken (distance to the stop). Expected = what the rule normally makes on that {shares ? 'share' : 'coin'}.</span></p>
                  <div className="table-wrap"><table className="record">
                    <thead><tr><th>{shares ? 'Share' : 'Coin'}</th><th>Result after costs</th><th>R</th><th>Expected</th><th>Buy price</th><th>Sell price</th><th>Why sold</th><th>Sold</th></tr></thead>
                    <tbody>{a.closed.slice().reverse().map((c, i) => (
                      <tr key={i}><td><b>{c.base}</b>{c.v ? <div className="muted small">rule v{c.v}</div> : null}</td><td className={cls(c.net)}>{pct(c.net)}</td><td className={cls(c.rMult ?? 0)}>{c.rMult != null ? `${c.rMult > 0 ? '+' : ''}${c.rMult.toFixed(2)}R` : '–'}</td><td className="muted">{c.expected != null ? pct(c.expected) : '–'}</td><td>{px(c.entryPx)}</td><td>{px(c.exitPx)}</td><td>{c.why === 'stop' ? 'Stop-loss hit' : 'Time limit'}</td><td>{when(c.exitT)}</td></tr>
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
              <h3>How the stop-loss and limits work</h3>
              {v.stops(S, champ?.spec.H)}
            </div>
          </section>

          <NowCtx.Provider value={state?.regimeNow?.[''] ?? state?.regimeNow?.US}>
          <section className="card">
            <h2>The rule it's using</h2>
            {(() => { const R = state?.regimeNow || {}; const parts = Object.entries(R).map(([m, x]) => `${m === '' ? 'Crypto (Bitcoin)' : m === 'US' ? 'US (S&P 500)' : 'ASX (ASX 200)'}: ${TREND_TXT[x.trend]}, ${VOL_TXT[x.vol].toLowerCase()} swings`); return parts.length ? <p className="small" style={{ marginTop: 0 }}><b>Market now</b> <Info>Trend: the leader above its 200-day average and up over 30 days (uptrend), below it and down over 30 days (downtrend), otherwise mixed. Swings: last 30 days' daily moves compared with its own previous year (lower, middle or upper third).</Info> {parts.join(' · ')}</p> : null })()}
            {champ ? (
              <RuleCard r={champ} title={`${champ.practice ? 'Top-scoring idea' : 'Current rule'} · v${champ.v}`} />
            ) : <p className="muted">{v.noRule}</p>}
            {changes.length > 0 && (<>
              <h3>Latest rule changes</h3>
              <ul className="lab-events">{changes.map((e, i) => <li key={i}><span className="tag">{KIND[e.kind] ?? e.kind}</span> {e.text} <span className="muted small">{when(e.t)}</span></li>)}</ul>
            </>)}
            {challengers.length > 0 && <Disclosure title={champ?.practice ? `Other ideas trading on paper (${challengers.length})` : `Backup rules being tested on paper (${challengers.length})`}>
              {champ?.practice ? <p className="muted small">In learning mode these trade the paper accounts too. The one marked "untried" is the explorer slot, which rotates through ideas with the least live record.</p> : <p className="muted small">These trade "in the shadow" with no money. One replaces the current rule only if its own live results beat it by at least {pct(S.promoteBy)} a trade over {S.promoteAfter}+ trades. The previous rule stays here, so a worse replacement gets rolled back automatically.</p>}
              {challengers.map(r => <RuleCard key={r.v} r={r} title={`v${r.v}${r.practice ? (r.explorer ? ' · untried idea' : ' · learning') : ''}${r.wasChampion ? ' · previous rule' : ''}`} small />)}
            </Disclosure>}
            {retired.length > 0 && <Disclosure title={`Retired rules (${retired.length})`}>
              <ul className="lab-events">{retired.map(r => <li key={r.v}><b>v{r.v}</b> {r.text} <span className="muted small">— {r.reason}</span></li>)}</ul>
            </Disclosure>}
          </section>
          </NowCtx.Provider>

          <section className="card">
            <h2>The cost gate</h2>
            <p className="muted small" style={{ marginTop: 0 }}>Mark's rule: only buy when the expected gain beats the full cost of buying and selling, plus a {pct(S.margin)} safety margin.</p>
            <div className="gate-grid">
              {accts.map(a => {
                const orderUsd = S.maxPosition * (a.valueAud ?? a.startAud) / rate   // a full-size order
                const base = 2 * feeFrac(a, orderUsd, 150, rate) + 2 * S.slippage
                const est = champ ? estimate(champ.all) : NaN
                const ok = champ && est > base + S.margin
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
            <p className="hint">Expected gain = the average of every past signal of this rule, losers included, minus a margin for luck. {shares
              ? <>Costs are for a full-size order (about {pct0(S.maxPosition)} of the account) at Interactive Brokers: {accts.map(a => `${a.feeLabel} (${a.market})`).join('; ')}. Price gap is assumed: about 0.03% for US large caps and 0.1% for the ASX names (no free live order book).</>
              : <>Price gap = the difference between the exchange's buy and sell prices, read live (CoinSpot coins missing from its public feed are assumed to have a 1% gap).</>}</p>
            {accts.some(a => a.lastBlocked.length) && <Disclosure title="Recently skipped signals">
              <ul className="lab-events">{accts.flatMap(a => a.lastBlocked.slice(-5).reverse().map((b, i) => <li key={a.id + i}><b>{a.exchange}</b> skipped {b.base}: {b.why} <span className="muted small">{when(b.t)}</span></li>))}</ul>
            </Disclosure>}
          </section>

          {v.kind === 'explore' && <ExploreCard state={state} />}
          {v.kind === 'day' && <WalkCard state={state} costs={shares ? "Interactive Brokers' US costs" : 'Binance-level costs'} />}

          {state.found && (
            <section className="card">
              <Disclosure title={<b>{v.kind === 'explore' ? `Graduated ideas (${state.found.length})` : `All ${state.found.length} rules tested`}</b>}>
                <p className="muted small">{v.tested}</p>
                <div className="table-wrap"><table className="record">
                  <thead><tr><th>Rule</th><th>Older data</th><th>Last {S.validDays} days</th><th>Passed</th></tr></thead>
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

          <p className="hint">{shares ? "Fills are simulated at each market's closing price plus the price gap, Interactive Brokers' fee and slippage. Prices come from Yahoo Finance's daily data, adjusted for splits and dividends. US results are shown in Australian dollars at today's rate (currency conversion fees aren't counted)." : "Fills are simulated at Binance's price plus each exchange's live price gap, fee and slippage, so real fills will differ a little."} A few weeks of paper results is still mostly luck: judge it over months.</p>
        </>
      )}
    </main>
  )
}

const CHECK_TEXT: Record<keyof Rigor['checks'], [string, string]> = {
  random: ['Beats random entries', 'Beat at least 95% of 200 runs that bought the same coins at random times and held them as long, AND by more than one round of trading costs (a tiny but "significant" gap is just the market\'s drift)'],
  doubleFee: ['Survives double fees', 'Still makes money if trading costs are twice what we assume'],
  neighbours: ['Nearby settings work too', 'At least half the other settings of the same idea also make money after costs, so it is not a lucky spike'],
  deflated: ['Real after counting tries', 'Deflated Sharpe of at least 95% (daily ups and downs of every open trade counted): the result is unlikely to be the luckiest of all the rules this lab has tried'],
  index: ['Beats the market index', 'Shares only: made more than buying the market index (S&P 500 or ASX 200 fund) over exactly the same days, after costs'],
}
const TREND_TXT = { up: 'Uptrend', mixed: 'Mixed', down: 'Downtrend' } as const
const VOL_TXT = { calm: 'Calm', normal: 'Normal', wild: 'Wild' } as const
const VERDICT: Record<string, [string, string]> = { suits: ['suits ✓', 'pos'], struggles: ['struggles ✓', 'neg'], 'leans better': ['leans better', ''], 'leans worse': ['leans worse', ''], same: ['no difference', 'muted'], 'too few': ['too few trades', 'muted'] }

/** How a rule did in each market type, and whether each difference is confirmed. */
function RegimeBox({ p, now }: { p: NonNullable<Rigor['regime']>; now?: { trend: 'up' | 'mixed' | 'down'; vol: 'calm' | 'normal' | 'wild' } }) {
  const row = (dim: 'trend' | 'vol', k: string, label: string) => {
    const c = (p.cells[dim] as Record<string, { n: number; mean: number; z?: number }>)[k], v = (p.verdicts[dim] as Record<string, string>)[k], w = (p.weights[dim] as Record<string, number>)[k]
    const isNow = now && (dim === 'trend' ? now.trend === k : now.vol === k)
    return (
      <tr key={dim + k} style={isNow ? { fontWeight: 700 } : undefined}>
        <td>{label}{isNow ? ' (now)' : ''}</td><td className="r">{c.n}</td><td className={`r ${cls(c.mean)}`}>{pct(c.mean)}</td>
        <td className={VERDICT[v]?.[1]}>{VERDICT[v]?.[0] ?? v}{c.z != null ? <span className="muted"> · z {c.z.toFixed(1)}</span> : null}</td><td className="r">{w === 1 ? '1×' : `${w.toFixed(2)}×`}</td>
      </tr>
    )
  }
  return (
    <div style={{ marginTop: 8 }}>
      <b>Market types</b> <Info>Every past trade is tagged with the market it was bought into (trend and volatility of Bitcoin, or of the index for shares, from days that had already closed). Each type is always compared against all the others: a difference only counts (✓) with 30+ trades, a gap of 2.5+ standard errors with same-day trades counted once, and the same direction in both the older and newer half of the history. Confirmed differences change the size of a trade (0.25× to 1.5×), they never switch the rule off.</Info>
      <span className="muted"> · {p.summary}</span>
      <div className="table-scroll"><table className="table small" style={{ marginTop: 4 }}>
        <thead><tr><th>Market</th><th className="r">Trades</th><th className="r">Avg after costs</th><th>Compared with the other types</th><th className="r">Size</th></tr></thead>
        <tbody>
          {(['up', 'mixed', 'down'] as const).map(k => row('trend', k, TREND_TXT[k]))}
          {(['calm', 'normal', 'wild'] as const).map(k => row('vol', k, VOL_TXT[k]))}
        </tbody>
      </table></div>
    </div>
  )
}

function RigorBox({ g, now }: { g: Rigor; now?: { trend: 'up' | 'mixed' | 'down'; vol: 'calm' | 'normal' | 'wild' } }) {
  const years = Object.entries(g.years || {})
  const keys = (Object.keys(CHECK_TEXT) as (keyof Rigor['checks'])[]).filter(k => g.checks[k] !== undefined)
  return (
    <div className="explain-box small" style={{ marginTop: 8 }}>
      <div><b>Professional checks</b> {g.passedAll ? <span className="tag green">All passed</span> : <span className="tag">{keys.filter(k => g.checks[k]).length} of {keys.length} passed</span>}{g.v !== 2 && <span className="muted"> · made under the older checks, re-checked at the next daily re-test</span>}</div>
      <ul className="lab-events" style={{ margin: '6px 0' }}>
        {keys.map(k => (
          <li key={k}>{g.checks[k] ? '✓' : '✗'} {CHECK_TEXT[k][0]} <Info>{CHECK_TEXT[k][1]}</Info>
            <span className="muted"> · {k === 'random' ? `random runs beat it ${pct0(g.randomP)} of the time${g.edgeVsRandom != null ? `; ${pct(g.edgeVsRandom)} a trade better than random` : ''}` : k === 'index' ? `${pct(g.vsIndex ?? 0)} a trade above the index after costs` : k === 'doubleFee' ? `${pct(g.meanNet)} a trade after one set of costs` : k === 'neighbours' ? `${g.neighbours.up} of ${g.neighbours.n} other settings make money` : `${pct0(g.dsr)} after ${g.trials.toLocaleString()} rules tried`}</span></li>
        ))}
      </ul>
      <div className="muted">Daily Sharpe {g.sharpe.toFixed(2)} over {g.days.toLocaleString()} days · spread across its open trades: {pct(g.annual)} a year, worst fall {pct0(g.maxDD)} · worst fall in 95% of shuffled trade orders at 10% a trade: {pct0(g.shuffleDD)}</div>
      {years.length > 0 && <div className="muted">By year (a trade, after costs): {years.map(([y, o]) => <span key={y} className={cls(o.mean)}>{y} {pct(o.mean)} ({o.n}) </span>)}</div>}
      {g.regime && <RegimeBox p={g.regime} now={now} />}
    </div>
  )
}

function downloadTrades(a: Account, lab: string) {
  const cols = ['account', 'rule', 'asset', 'entry_time', 'entry_price', 'fill_price', 'stop', 'exit_time', 'exit_price', 'size_usd', 'cost_est', 'net_after_costs', 'gross', 'r_multiple', 'expected', 'why_sold']
  const iso = (t: number) => new Date(t).toISOString()
  const rows = a.closed.map(c => [a.exchange, c.v, c.base, iso(c.t), c.entryPx, c.fillPx, c.stop, iso(c.exitT), c.exitPx, c.costUsd?.toFixed(2), c.cost, c.net, c.gross, c.rMult ?? '', c.expected ?? '', c.why])
  const csv = [cols, ...rows].map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const el = document.createElement('a'); el.href = url; el.download = `${lab} - ${a.exchange} trades.csv`.replace(/[^\w .-]/g, ''); el.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

type RegimeNow = { trend: 'up' | 'mixed' | 'down'; vol: 'calm' | 'normal' | 'wild' }
const NowCtx = createContext<RegimeNow | undefined>(undefined)

function RuleCard({ r, title, small }: { r: LabRule; title: string; small?: boolean }) {
  const live = liveRecord(r)
  const now = useContext(NowCtx)
  return (
    <div className={`lab-rule ${small ? 'small' : ''}`}>
      <div className="lab-rule-head"><span className={`tag ${r.status === 'champion' ? 'green' : ''}`}>{title}</span>{r.reason && <span className="muted small">{r.reason}</span>}</div>
      <p className="lab-rule-text">{r.text}</p>
      {cardFor(r.spec?.kind) && <div className="muted small" style={{ margin: '4px 0 8px' }}><b>Why it could work:</b> {cardFor(r.spec?.kind)!.edge} <b>What kills it:</b> {cardFor(r.spec?.kind)!.fails}</div>}
      <div className="lab-rule-stats">
        <span>Past signals: <b className={cls(r.all.mean)}>{pct(r.all.mean)}</b> a trade before costs, won {pct0(r.all.win)} of {r.all.n}</span>
        <span>Conservative estimate: <b>{pct(estimate(r.all))}</b></span>
        {r.vsIndex && <span>Versus the market index: <b className={cls(r.vsIndex.mean)}>{pct(r.vsIndex.mean)}</b> a trade over the same days, before costs</span>}
        <span>Live on paper: {live.n ? <><b className={cls(live.mean)}>{pct(live.mean)}</b> a trade over {live.n}, won {pct0(live.win)}</> : 'no closed trades yet'}</span>
      </div>
      {r.rigor && <RigorBox g={r.rigor} now={now} />}
    </div>
  )
}

interface ExploreState {
  gen: number; tried: number; holdoutTests: number; hurdle?: number
  population: { id: string; text: string; fitness: number; train: { n: number; mean: number; t: number }; tested: boolean; passed?: boolean; gen: number }[]
  graduates: { id: string; text: string; train: { t: number }; valid: { n: number; mean: number } }[]
  log: { t: number; text: string; trainT: number; valid: { n: number; mean: number; t: number }; passed: boolean }[]
}

function ExploreCard({ state }: { state: LabState }) {
  const ex = (state as unknown as { explore?: ExploreState }).explore
  if (!ex) return null
  const bar = ex.hurdle ?? hurdle(ex.tried)
  return (
    <section className="card">
      <h2>The idea factory</h2>
      <div className="kpis">
        <div className="kpi"><div className="label">Ideas tried</div><div className="value">{ex.tried.toLocaleString()}</div><div className="sub">over {ex.gen} runs</div></div>
        <div className="kpi"><div className="label">Bar to clear <Info>The t-score an idea needs on older data before it gets its one look at the held-back period. It rises with the number of ideas tried, because the luckiest of many useless ideas looks better and better.</Info></div><div className="value">{bar.toFixed(2)}</div><div className="sub">t-score on older data</div></div>
        <div className="kpi"><div className="label">Checked on held-back data</div><div className="value">{ex.holdoutTests}</div><div className="sub">one look each</div></div>
        <div className="kpi"><div className="label">Graduated</div><div className="value">{ex.graduates.length}</div><div className="sub">may trade on paper</div></div>
      </div>
      <h3>Best ideas so far (on older data)</h3>
      <div className="table-wrap"><table className="record">
        <thead><tr><th>Idea</th><th>Trades</th><th>Avg after costs</th><th>t-score</th><th>Status</th></tr></thead>
        <tbody>{ex.population.slice(0, 10).map(p => (
          <tr key={p.id}><td style={{ minWidth: 220, whiteSpace: 'normal' }}>{p.text}</td><td>{p.train.n}</td>
            <td className={cls(p.train.mean)}>{pct(p.train.mean)}</td><td>{p.train.t.toFixed(2)}</td>
            <td>{p.passed ? <span className="tag green">Graduated</span> : p.tested ? <span className="tag red">Failed check</span> : p.train.t >= bar ? <span className="tag amber">Checking</span> : <span className="tag">Below bar</span>}</td></tr>
        ))}</tbody></table></div>
      {ex.log.length > 0 && <Disclosure title={`Recent checks on held-back data (${ex.log.length})`}>
        <ul className="lab-events">{ex.log.slice().reverse().slice(0, 15).map((l, i) => (
          <li key={i}><span className={`tag ${l.passed ? 'green' : 'red'}`}>{l.passed ? 'Passed' : 'Failed'}</span> {l.text} <span className="muted small">held-back: {pct(l.valid.mean)} a trade over {l.valid.n} trades · {when(l.t)}</span></li>
        ))}</ul>
      </Disclosure>}
    </section>
  )
}

interface WalkState { months: { start: number; rule: string | null; n: number; mean: number; sum: number }[]; total: { n: number; mean: number; t: number; win: number } }

function WalkCard({ state, costs }: { state: LabState; costs: string }) {
  const w = (state as unknown as { walk?: WalkState }).walk
  if (!w) return null
  return (
    <section className="card">
      <h2>Walk-forward test <Info>Each month, the bot picks the rule that looked best over the previous 120 days only, then records what it actually earned that month. Stitched together, this is what the whole selection process would have made, with no hindsight.</Info></h2>
      <p className="muted small" style={{ marginTop: 0 }}>{w.total.n ? <>Following the process would have averaged <b className={cls(w.total.mean)}>{pct(w.total.mean, 2)}</b> a trade after {costs} over {w.total.n} trades ({pct0(w.total.win)} won).</> : 'Not enough history yet.'}</p>
      <div className="table-wrap"><table className="record">
        <thead><tr><th>Month from</th><th style={{ textAlign: 'left' }}>Rule chosen</th><th>Trades</th><th>Avg a trade</th></tr></thead>
        <tbody>{w.months.slice().reverse().map(m => (
          <tr key={m.start}><td>{day(m.start)}</td><td style={{ minWidth: 220, whiteSpace: 'normal', textAlign: 'left' }}>{m.rule ?? <span className="muted">none looked worth it</span>}</td><td>{m.n}</td><td className={cls(m.mean)}>{m.n ? pct(m.mean, 2) : '–'}</td></tr>
        ))}</tbody></table></div>
    </section>
  )
}
