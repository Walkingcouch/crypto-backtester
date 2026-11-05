import type { Metrics } from '../lib/engine'
import { money, money0, num, pct, sign } from '../lib/format'
import { Info } from './Info'
import type { Cur } from '../lib/currency'

export const EXPLAIN = {
  sharpe: 'Return per unit of bumpiness, per year. Higher is better. Around 1 or more is good for a simple strategy; holding crypto is often 0.5–1.2.',
  drawdown: 'The biggest fall from a high point to a low before recovering. Ask yourself: could I sit through this without panic-selling?',
  trades: 'Each buy or sell. More trades means more fees eating into returns.',
  winRate: 'Share of complete buy→sell rounds that made money. Trend strategies often win less than half the time but win big on a few.',
  cagr: 'The steady yearly growth rate that would give the same end result.',
  timeInMarket: 'How often the strategy is holding coins rather than sitting in cash.',
  calmar: 'Yearly return divided by the worst drop. Higher means better reward for the pain.',
  sortino: 'Like Sharpe, but only counts downward moves as risk.',
  volatility: 'How much the value jumps around, per year.',
}

export function scoreLabel(sharpe: number) {
  if (sharpe >= 1.2) return { text: 'Strong', cls: 'green' }
  if (sharpe >= 0.7) return { text: 'Decent', cls: 'green' }
  if (sharpe >= 0.3) return { text: 'Weak', cls: 'amber' }
  return { text: 'Poor', cls: 'red' }
}

/** The plain-English headline: "$200 → $X" vs holding. */
export function Headline({ m, bench, cash, cur }: { m: Metrics; bench: Metrics; cash: number; cur?: Cur }) {
  const s = scoreLabel(m.sharpe), b = scoreLabel(bench.sharpe)
  return (
    <div className="headline">
      <div className="headline-main">
        <div className="hl-label">Strategy</div>
        <div className="hl-value">{money0(cash, cur)} <span className="arrow">→</span> <span className={sign(m.totalReturn)}>{money0(m.finalEquity, cur)}</span></div>
        <div className="hl-sub">{pct(m.totalReturn)} total · {pct(m.cagr)} a year</div>
      </div>
      <div className="headline-bench">
        <div className="hl-label">If you'd just bought and held</div>
        <div className="hl-value small-v">{money0(cash, cur)} <span className="arrow">→</span> {money0(bench.finalEquity, cur)}</div>
        <div className="hl-sub">{pct(bench.totalReturn)} total</div>
      </div>
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Worst drop <Info>{EXPLAIN.drawdown}</Info></div>
          <div className="stat-value neg">{pct(m.maxDrawdown, 0)}</div>
          <div className="stat-sub">holding: {pct(bench.maxDrawdown, 0)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Risk-adjusted score <Info>{EXPLAIN.sharpe}</Info></div>
          <div className="stat-value">{num(m.sharpe)} <span className={`tag ${s.cls}`}>{s.text}</span></div>
          <div className="stat-sub">holding: {num(bench.sharpe)} ({b.text.toLowerCase()})</div>
        </div>
        <div className="stat">
          <div className="stat-label">Trades <Info>{EXPLAIN.trades}</Info></div>
          <div className="stat-value">{m.trades}</div>
          <div className="stat-sub">{money(m.feesPaid, cur)} in fees</div>
        </div>
      </div>
    </div>
  )
}

/** Overall verdict for a period, in plain language. */
export function verdict(m: Metrics, bench: Metrics) {
  const betterRisk = m.sharpe > bench.sharpe
  const smallerDrop = m.maxDrawdown > bench.maxDrawdown + 0.05
  const moreMoney = m.totalReturn > bench.totalReturn
  if (m.totalReturn < 0 && bench.totalReturn > 0)
    return { cls: 'bad', title: 'Lost money while holding made money', body: 'This strategy would have done worse than doing nothing clever at all.' }
  if (m.totalReturn < 0 && bench.totalReturn < 0 && moreMoney)
    return { cls: 'mixed', title: 'Lost less than holding', body: 'Prices fell over this period. The strategy still lost money, but less, by stepping aside during some of the falls.' }
  if (betterRisk && moreMoney)
    return { cls: 'good', title: 'Beat holding on both return and risk', body: 'It made more money and gave a better return for the ups and downs.' }
  if (betterRisk && smallerDrop)
    return { cls: 'good', title: 'Smoother ride than holding', body: 'Less profit than holding, but much smaller falls along the way, and better return for the risk taken. That\'s usually how trend-following earns its keep.' }
  if (smallerDrop)
    return { cls: 'mixed', title: 'Smaller falls, but weaker overall', body: 'It avoided some of the worst drops, but holding still gave a better return for the risk.' }
  return { cls: 'bad', title: 'No better than holding', body: 'Simply buying and holding did as well or better, with less effort and fewer fees.' }
}

const ROWS: [keyof Metrics, string, (x: number) => string, string?][] = [
  ['finalEquity', 'Ending value', money], ['totalReturn', 'Total return', pct], ['cagr', 'Yearly return', pct, EXPLAIN.cagr],
  ['sharpe', 'Risk-adjusted score (Sharpe)', num, EXPLAIN.sharpe], ['sortino', 'Sortino', num, EXPLAIN.sortino],
  ['maxDrawdown', 'Worst drop', pct, EXPLAIN.drawdown], ['calmar', 'Calmar', num, EXPLAIN.calmar],
  ['volatility', 'Bumpiness (volatility)', pct, EXPLAIN.volatility], ['trades', 'Trades', x => String(x), EXPLAIN.trades],
  ['winRate', 'Winning rounds', pct, EXPLAIN.winRate], ['feesPaid', 'Fees paid', money], ['timeInMarket', 'Time holding coins', pct, EXPLAIN.timeInMarket],
]

export function MetricTable({ cols, cur }: { cols: { name: string; m: Metrics }[]; cur?: Cur }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Measure</th>{cols.map(c => <th key={c.name}>{c.name}</th>)}</tr></thead>
        <tbody>
          {ROWS.map(([k, label, f, tip]) => (
            <tr key={k}><td>{label}{tip && <> <Info>{tip}</Info></>}</td>{cols.map(c => <td key={c.name}>{k === 'finalEquity' || k === 'feesPaid' ? money(c.m[k] as number, cur) : f(c.m[k] as number)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
