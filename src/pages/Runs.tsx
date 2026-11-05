import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { deleteRun, listRuns, type SavedRun } from '../lib/store'
import { useAuth } from '../lib/auth'
import { cloudEnabled } from '../lib/supabase'
import { num, paramStr, pct, sign } from '../lib/format'
import { fmtMoney, type Cur } from '../lib/currency'

export default function Runs({ embedded = false }: { embedded?: boolean }) {
  const { session, ready } = useAuth()
  const [rows, setRows] = useState<SavedRun[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = () => listRuns().then(setRows).catch(e => setErr(e.message))
  useEffect(() => { if (ready) load() }, [ready, session])

  return (
    <div className={embedded ? '' : 'page'}>
      <div className="page-head">
        {!embedded && <h1>Saved runs</h1>}
        <p>Results you've saved, with every setting recorded so you can compare them later.</p>
        {cloudEnabled && !session && <div className="notice info">Showing results saved in this browser. <Link to="/account">Sign in</Link> to save across devices and see your partner's runs.</div>}
      </div>
      {err && <div className="notice err">{err}</div>}
      {!rows ? <div className="card empty">Loading…</div> : rows.length === 0 ? (
        <div className="card empty">Nothing saved yet. After a test, press <b>Save result</b>.</div>
      ) : (
        <div className="stack">
          {rows.map(r => {
            const s = r.settings as Record<string, number | string>
            const tm = r.test_metrics
            const mine = !session || r.user_id === session.user.id
            return (
              <div className="card" key={r.id}>
                <div className="card-title">
                  <div>
                    <h2>{r.title}</h2>
                    <div className="small muted">
                      {r.author ? `${r.author} · ` : ''}{new Date(r.created_at!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                      {' · '}settings <span className="mono">{paramStr(r.params)}</span>
                      {' · '}fee {pct(Number(s.fee), 2)} · start {fmtMoney(Number(s.cash), (s.currency as Cur) || 'USD', 0)}
                    </div>
                  </div>
                  {mine && <button className="btn btn-ghost btn-sm" onClick={async () => { if (confirm('Delete this saved run?')) { await deleteRun(r.id!); load() } }}>Delete</button>}
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Period</th><th>Dates</th><th>Return</th><th>Score</th><th>Worst drop</th><th>Trades</th></tr></thead>
                    <tbody>
                      <tr><td>Older prices</td><td>{String(s.train_from)} → {String(s.test_from)}</td>
                        <td className={sign(r.train_metrics.totalReturn)}>{pct(r.train_metrics.totalReturn)}</td>
                        <td>{num(r.train_metrics.sharpe)}</td><td className="neg">{pct(r.train_metrics.maxDrawdown)}</td><td>{r.train_metrics.trades}</td></tr>
                      <tr><td>Final check</td><td>{String(s.test_from)} → {String(s.test_to)}</td>
                        {tm ? <>
                          <td className={sign(tm.totalReturn)}>{pct(tm.totalReturn)}</td><td>{num(tm.sharpe)}</td>
                          <td className="neg">{pct(tm.maxDrawdown)}</td><td>{tm.trades}</td></>
                          : <td colSpan={4} className="muted">not run yet</td>}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
