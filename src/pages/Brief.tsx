import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

interface Acct { name: string; value: number; start: number; sinceStart: number; today: number | null; open: number; trades24h: number; net24h: number; closed: number; winRate: number | null; recent: { base: string; net: number; r: number | null; rule: number; at: number }[] }
interface LabRow {
  id: string; name: string; path: string; updated: number; late: boolean
  accounts?: Acct[]; mode?: string; tested?: number; passingAll?: number; trials?: number | null
  active?: { v: number; text: string; status: string; explorer: boolean; checks: number | null }[]
  best?: { text: string; checks: number; sharpe: number; dsr: number } | null
  signals?: number; sourcesDown?: string[]
}
interface Brief { at: number; labs: LabRow[]; alerts: string[]; decisions: string[]; events: { t: number; market: string; title: string; forecast: string | null; previous: string | null }[] }

const pct = (x: number | null | undefined, d = 1) => x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`
const cls = (x: number | null | undefined) => (x == null ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '')
const aud = (x: number) => `A$${x.toLocaleString('en-AU', { maximumFractionDigits: 0 })}`
const darwin = (t: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Darwin', ...o }).format(new Date(t))
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago` }

export default function Brief() {
  const [b, setB] = useState<Brief | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    fetch('/api/brief').then(r => r.json()).then(j => { if (alive) (j.error ? setError(j.error) : setB(j)) }).catch(e => alive && setError(String(e)))
    return () => { alive = false }
  }, [])

  const trading = b?.labs.filter(l => l.accounts) || []
  const all = trading.flatMap(l => l.accounts!)
  const start = all.reduce((s, a) => s + a.start, 0), value = all.reduce((s, a) => s + a.value, 0)
  const trades24 = all.reduce((s, a) => s + a.trades24h, 0)

  return (
    <div className="page">
      <div className="page-head">
        <h1>Today</h1>
        <p>One look at every lab: is everything running, how the paper accounts are doing, what traded, and anything that needs you.{b ? ` Updated ${darwin(b.at, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} Darwin.` : ''}</p>
      </div>
      {error && <div className="notice err">{error}</div>}
      {!b && !error && <div className="card empty">Loading…<div className="progress"><div /></div></div>}
      {b && (<>
        <section className="card">
          <div className="kpis">
            <div className="kpi"><div className="label">All paper accounts</div><div className="value">{aud(value)}</div><div className={`sub ${cls(value / start - 1)}`}>{pct(value / start - 1, 2)} since start ({aud(start)})</div></div>
            <div className="kpi"><div className="label">Trades closed, last 24 h</div><div className="value">{trades24}</div><div className="sub">across {trading.length} labs</div></div>
            <div className="kpi"><div className="label">Health</div><div className={`value ${b.alerts.length ? 'neg' : 'pos'}`}>{b.alerts.length ? `${b.alerts.length} alert${b.alerts.length > 1 ? 's' : ''}` : 'All running'}</div><div className="sub">every lab checked against its schedule</div></div>
          </div>
          {b.alerts.length > 0 && <div className="notice err small">{b.alerts.map((a, i) => <div key={i}>{a}</div>)}</div>}
          {b.decisions.length > 0 && <div className="notice warn small"><b>Needs you:</b>{b.decisions.map((d, i) => <div key={i}>{d}</div>)}</div>}
        </section>

        {b.events.length > 0 && <section className="card">
          <h2>Big releases in the next 24 hours</h2>
          <p className="muted small" style={{ marginTop: 0 }}>The day labs stand aside around these and trade half size for the rest of that session.</p>
          <ul className="lab-events">{b.events.map((e, i) => <li key={i}><b>{darwin(e.t, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</b> · {e.market} · {e.title}{e.forecast ? <span className="muted"> · forecast {e.forecast}, previous {e.previous ?? '–'}</span> : null}</li>)}</ul>
        </section>}

        {b.labs.map(l => (
          <section className="card" key={l.id}>
            <div className="step-head">
              <span className="step-badge">{l.late ? '⚠ late · ' : ''}ran {ago(l.updated)}{l.mode ? ` · ${l.mode}` : ''}</span>
              <h2><Link to={l.path}>{l.name}</Link></h2>
            </div>
            {l.accounts && <div className="table-wrap"><table className="record stack-sm">
              <thead><tr><th>Account</th><th>Value</th><th>Today</th><th>Since start</th><th>Open</th><th>Closed (24 h)</th><th>All trades</th></tr></thead>
              <tbody>{l.accounts.map(a => (
                <tr key={a.name}><td>{a.name}</td><td>{aud(a.value)}</td><td className={cls(a.today)}>{pct(a.today, 2)}</td><td className={cls(a.sinceStart)}>{pct(a.sinceStart, 2)}</td><td>{a.open}</td>
                  <td>{a.trades24h ? <>{a.trades24h} <span className={cls(a.net24h)}>({a.recent.map(x => `${x.base} ${pct(x.net)}${x.r != null ? ` ${x.r > 0 ? '+' : ''}${x.r.toFixed(1)}R` : ''}`).join(', ')})</span></> : '–'}</td>
                  <td>{a.closed}{a.winRate != null ? `, ${Math.round(a.winRate * 100)}% won` : ''}</td></tr>
              ))}</tbody></table></div>}
            {l.active && l.active.length > 0 && <p className="small"><b>Trading now:</b> {l.active.map(r => `v${r.v}${r.explorer ? ' (untried idea)' : ''}`).join(', ')} <span className="muted">· {l.tested} rules tested, {l.passingAll} pass every check{l.trials ? `, ${l.trials.toLocaleString()} tried in total` : ''}</span></p>}
            {l.best && <p className="small muted">Closest to passing: “{l.best.text}” ({l.best.checks} of 4 checks, daily Sharpe {l.best.sharpe.toFixed(2)})</p>}
            {l.signals != null && <p className="small">{l.signals.toLocaleString()} signals tracked{l.sourcesDown?.length ? <span className="muted"> · not reporting: {l.sourcesDown.join(', ')}</span> : ''}</p>}
          </section>
        ))}
      </>)}
    </div>
  )
}
