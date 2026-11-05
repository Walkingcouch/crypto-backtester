import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listReveals, type Reveal } from '../lib/store'
import { useAuth } from '../lib/auth'
import { cloudEnabled } from '../lib/supabase'
import { num, paramStr, pct, sign } from '../lib/format'
import { byId } from '../lib/strategies'

export default function Ledger() {
  const { session, ready } = useAuth()
  const [rows, setRows] = useState<Reveal[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    listReveals().then(setRows).catch(e => setErr(e.message))
  }, [ready, session])

  // count reveals per strategy+period to flag repeats
  const counts = new Map<string, number>()
  rows?.forEach(r => counts.set(r.period_key + r.strategy_id, (counts.get(r.period_key + r.strategy_id) || 0) + 1))

  return (
    <main className="page">
      <div className="page-head">
        <h1>Test ledger</h1>
        <p>Every time anyone reveals an unseen test result, it's recorded here and can't be edited or deleted. Strategies
          revealed more than once on the same period are flagged — those results are no longer truly unseen.</p>
        {cloudEnabled && !session && <div className="notice info">Showing this browser's ledger only. <Link to="/account">Sign in</Link> to see the shared ledger.</div>}
      </div>
      {err && <div className="notice err">{err}</div>}
      <div className="card">
        {!rows ? <div className="empty">Loading…</div> : rows.length === 0 ? (
          <div className="empty">No test results revealed yet. Run a backtest and reveal its unseen test to start the record.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Who</th><th>Strategy</th><th>Market</th><th>Test period</th><th>Settings</th><th>Fee</th>
                <th>Sharpe</th><th>Return</th><th>Max DD</th><th>Buy &amp; hold</th><th>Looks</th></tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const n = counts.get(r.period_key + r.strategy_id) || 1
                  return (
                    <tr key={r.id ?? i}>
                      <td>{new Date(r.created_at!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                      <td>{r.author || '—'}</td>
                      <td>{byId(r.strategy_id)?.name ?? r.strategy_id} <span className="muted small">v{r.strategy_version}</span></td>
                      <td>{r.symbol} {r.interval}</td>
                      <td>{r.test_from} → {r.test_to}</td>
                      <td className="mono">{paramStr(r.params)}</td>
                      <td>{pct(r.fee, 2)}</td>
                      <td>{num(r.sharpe)}</td>
                      <td className={sign(r.total_return)}>{pct(r.total_return)}</td>
                      <td className="neg">{pct(r.max_drawdown)}</td>
                      <td className={sign(r.bh_return)}>{pct(r.bh_return)}</td>
                      <td>{n > 1 ? <span className="tag amber">{n}× seen</span> : <span className="tag green">first</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  )
}
