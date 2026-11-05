import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listReveals, type Reveal } from '../lib/store'
import { useAuth } from '../lib/auth'
import { cloudEnabled } from '../lib/supabase'
import { num, paramStr, pct, sign } from '../lib/format'
import { byId } from '../lib/strategies'
import { scoreLabel } from '../components/Metrics'

export default function Ledger({ embedded = false }: { embedded?: boolean }) {
  const { session, ready } = useAuth()
  const [rows, setRows] = useState<Reveal[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    listReveals().then(setRows).catch(e => setErr(e.message))
  }, [ready, session])

  // how many times each strategy has been checked on the same recent prices
  const counts = new Map<string, number>()
  rows?.forEach(r => counts.set(r.period_key + r.strategy_id, (counts.get(r.period_key + r.strategy_id) || 0) + 1))

  return (
    <div className={embedded ? '' : 'page'}>
      <div className="page-head">
        {!embedded && <h1>Final checks</h1>}
        <p>Every final check is recorded here permanently, by anyone signed in. If a strategy is checked more than once on the
          same recent prices it's flagged, because repeat checks aren't a fair test.</p>
        {cloudEnabled && !session && <div className="notice info">Showing this browser only. <Link to="/account">Sign in</Link> to see the record you share with your partner.</div>}
      </div>
      {err && <div className="notice err">{err}</div>}
      {!rows ? <div className="card empty">Loading…</div> : rows.length === 0 ? (
        <div className="card empty">No final checks yet. Run a test, then press <b>Run final check</b>.</div>
      ) : (
        <div className="list">
          {rows.map((r, i) => {
            const n = counts.get(r.period_key + r.strategy_id) || 1
            const s = byId(r.strategy_id)
            const sc = scoreLabel(r.sharpe)
            const beat = r.total_return > r.bh_return
            return (
              <div className="card list-item" key={r.id ?? i}>
                <div className="flex">
                  <b>{s?.friendly ?? r.strategy_id}</b>
                  <span className="muted small">{r.symbol.replace('USDT', '')} · {r.test_from.slice(0, 7)} → {r.test_to.slice(0, 7)}</span>
                  <span className="spacer" />
                  {n > 1 ? <span className="tag amber">checked {n}×</span> : <span className="tag green">fair test</span>}
                </div>
                <div className="li-stats">
                  <div><span>Return</span><b className={sign(r.total_return)}>{pct(r.total_return, 0)}</b></div>
                  <div><span>Holding</span><b className={sign(r.bh_return)}>{pct(r.bh_return, 0)}</b></div>
                  <div><span>Worst drop</span><b className="neg">{pct(r.max_drawdown, 0)}</b></div>
                  <div><span>Score</span><b>{num(r.sharpe)} <span className={`tag ${sc.cls}`}>{sc.text}</span></b></div>
                </div>
                <div className="hint">
                  {r.author ? `${r.author} · ` : ''}{new Date(r.created_at!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  {' · '}settings {paramStr(r.params)} · fee {pct(r.fee, 2)} · {beat ? 'beat holding on return' : 'trailed holding on return'}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
