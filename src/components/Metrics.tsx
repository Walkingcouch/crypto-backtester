import type { Metrics } from '../lib/engine'
import { money, num, pct, sign } from '../lib/format'

export function Kpis({ m, bench }: { m: Metrics; bench: Metrics }) {
  const items = [
    { label: 'Total return', v: pct(m.totalReturn), cls: sign(m.totalReturn), sub: `Buy & hold ${pct(bench.totalReturn)}` },
    { label: 'Sharpe', v: num(m.sharpe), cls: '', sub: `Buy & hold ${num(bench.sharpe)}` },
    { label: 'Max drawdown', v: pct(m.maxDrawdown), cls: 'neg', sub: `Buy & hold ${pct(bench.maxDrawdown)}` },
    { label: 'Trades', v: String(m.trades), cls: '', sub: `Fees ${money(m.feesPaid)}` },
  ]
  return (
    <div className="kpis">
      {items.map(i => (
        <div className="kpi" key={i.label}>
          <div className="label">{i.label}</div>
          <div className={`value ${i.cls}`}>{i.v}</div>
          <div className="sub">{i.sub}</div>
        </div>
      ))}
    </div>
  )
}

const ROWS: [keyof Metrics, string, (x: number) => string][] = [
  ['finalEquity', 'Final equity', money], ['totalReturn', 'Total return', pct], ['cagr', 'Annual return (CAGR)', pct],
  ['sharpe', 'Sharpe', num], ['sortino', 'Sortino', num], ['maxDrawdown', 'Max drawdown', pct],
  ['calmar', 'Calmar', num], ['volatility', 'Volatility (yearly)', pct], ['trades', 'Trades', x => String(x)],
  ['winRate', 'Win rate (round trips)', pct], ['feesPaid', 'Fees paid', money], ['timeInMarket', 'Time in market', pct],
]

export function MetricTable({ cols }: { cols: { name: string; m: Metrics }[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Metric</th>{cols.map(c => <th key={c.name}>{c.name}</th>)}</tr></thead>
        <tbody>
          {ROWS.map(([k, label, f]) => (
            <tr key={k}><td>{label}</td>{cols.map(c => <td key={c.name}>{f(c.m[k] as number)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
