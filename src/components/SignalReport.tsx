import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Disclosure, Info } from './Info'

interface H { n: number; dates: number; avg: number; t: number; win: number; randomP: number; older: number; newer: number; enough: boolean; checks: { profit: boolean; solid: boolean; random: boolean; consistent: boolean }; score: number | null; ifTradeDate: number | null; missingPrices: number }
interface Stream { stream: string; name: string; signals: number; best: number | null; score: number | null; grade: string | null; verdict: string; horizons: Record<string, H> }
interface Report { at: number; bar: number; tests: number; streams: Stream[]; events: number; lagDays: number; oldest: number | null; prices: number; priceMissingCount: number; archived: number }

const pct = (x: number | null | undefined) => x == null ? '–' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(2)}%`
const cls = (x: number | null | undefined) => (x == null ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '')
const GRADE_TAG: Record<string, string> = { A: 'green', B: 'green', C: 'amber', D: 'red', F: 'red' }
const CHECKS: [keyof H['checks'], string, string][] = [
  ['profit', 'Makes money after costs', 'The average result, in the signal\'s direction and beyond the market index, is positive after a round-trip trading cost.'],
  ['solid', 'Statistically solid', 'The t-score clears the bar for the number of tests run. Signals published on the same day count as one, because they aren\'t independent.'],
  ['random', 'Beats random dates', 'Better than 95% of 200 runs that traded the same shares or coins, in the same direction, on random days.'],
  ['consistent', 'Consistent over time', 'Positive in both the older half and the newer half of the signals.'],
]

export default function SignalReport() {
  const [r, setR] = useState<Report | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (supabase) {
          const { data } = await supabase.from('lab_state').select('data').eq('id', 'smart-test').maybeSingle()
          if (data?.data) { if (alive) setR(data.data as Report); return }
        }
        const j = await (await fetch('/api/smart-backtest-cron?dry=1')).json()
        if (alive) (j.error ? setError(j.error) : setR(j))
      } catch (e) { if (alive) setError(String(e)) }
    })()
    return () => { alive = false }
  }, [])

  return (
    <section className="card">
      <h2>Report card: which smart money is worth following?</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Each stream is backtested on what prices did <b>after</b> its signals became public, the first moment we could act: buy at the next day's open
        (or avoid / sell for a sell signal), hold 1, 5, 20 or 60 trading days, measured beyond the market index, after trading costs. Re-run every morning.
      </p>
      {error && <div className="notice err small">{error}</div>}
      {!r && !error && <div className="muted small">Loading the report card…</div>}
      {r && (<>
        <div className="table-wrap"><table className="record stack-sm">
          <thead><tr><th>Stream</th><th>Grade <Info>A = passes all 4 checks at its best holding period, F = none. Needs at least 30 signals on 15+ different days to be graded.</Info></th><th>Signals tested</th><th>Best hold</th><th>Average a trade <Info>In the signal's direction, beyond the market index, after costs, at the best holding period.</Info></th><th>Won</th><th>Verdict</th></tr></thead>
          <tbody>{r.streams.map(s => {
            const h = s.best ? s.horizons[s.best] : null
            const n = Math.max(...Object.values(s.horizons).map(x => x.n))
            return (
              <tr key={s.stream}>
                <td style={{ minWidth: 200, whiteSpace: 'normal' }}>{s.name}</td>
                <td>{s.grade ? <span className={`tag ${GRADE_TAG[s.grade]}`}>{s.grade}</span> : <span className="tag">–</span>}</td>
                <td>{n.toLocaleString()}</td>
                <td>{s.best ? `${s.best} day${s.best > 1 ? 's' : ''}` : '–'}</td>
                <td className={cls(h?.avg)}>{h ? pct(h.avg) : '–'}</td>
                <td>{h ? `${Math.round(h.win * 100)}%` : '–'}</td>
                <td className="small" style={{ minWidth: 180, whiteSpace: 'normal' }}>{s.verdict}</td>
              </tr>
            )
          })}</tbody></table></div>
        <p className="muted small">
          {r.events.toLocaleString()} signals with prices for {r.prices} shares and coins. US politicians' filings arrive about {r.lagDays} days after the trade, so they're tested from the filing date.
          Updated {new Date(r.at).toLocaleString('en-AU', { timeZone: 'Australia/Darwin', weekday: 'short', hour: 'numeric', minute: '2-digit' })} Darwin.
        </p>
        <Disclosure title="Full results by stream and holding period">
          {r.streams.filter(s => Object.values(s.horizons).some(h => h.n)).map(s => (
            <div key={s.stream} style={{ marginBottom: 14 }}>
              <h3 style={{ marginBottom: 4 }}>{s.name} {s.grade && <span className={`tag ${GRADE_TAG[s.grade]}`}>{s.grade}</span>}</h3>
              <div className="table-wrap"><table className="record stack-sm">
                <thead><tr><th>Hold</th><th>Signals (days)</th><th>Average after costs</th><th>t-score</th><th>Random dates beat it</th><th>Older half / newer half</th>{s.stream.startsWith('pol-us') && <th>If bought on the trade date <Info>What the same trade would have made if you'd known on the day the politician traded, before the filing was public. The gap is what the filing delay costs.</Info></th>}<th>Checks</th></tr></thead>
                <tbody>{Object.entries(s.horizons).map(([hd, h]) => (
                  <tr key={hd}><td>{hd} day{hd !== '1' ? 's' : ''}</td><td>{h.n} ({h.dates})</td><td className={cls(h.avg)}>{pct(h.avg)}</td><td>{h.t.toFixed(2)}</td>
                    <td>{Math.round(h.randomP * 100)}%</td><td><span className={cls(h.older)}>{pct(h.older)}</span> / <span className={cls(h.newer)}>{pct(h.newer)}</span></td>
                    {s.stream.startsWith('pol-us') && <td className={cls(h.ifTradeDate)}>{pct(h.ifTradeDate)}</td>}
                    <td>{h.enough ? CHECKS.map(([k]) => (h.checks[k] ? '✓' : '✗')).join(' ') : 'too few'}</td></tr>
                ))}</tbody></table></div>
            </div>
          ))}
          <ul className="lab-events small">{CHECKS.map(([k, name, why]) => <li key={k}><b>{name}:</b> {why}{k === 'solid' ? ` Bar now: t ≥ ${r.bar} (${r.tests} tests run).` : ''}</li>)}</ul>
        </Disclosure>
      </>)}
    </section>
  )
}
