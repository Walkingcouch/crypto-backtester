import { useEffect, useMemo, useState } from 'react'
import { LabTabs } from './Lab'

interface Ev { t: number; market: 'US' | 'ASX'; country: string; title: string; impact: string; forecast: string | null; previous: string | null; kind: string }
interface Meeting { t: number; bank: string; title: string; market: string }
interface News { t: number | null; title: string; link: string; source: string; market: string }
interface Econ { at: number; week: Ev[]; fomc: Meeting[]; rba: Meeting[]; news: News[]; errors: string[] }

const fmt = (t: number, tz: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, ...o }).format(new Date(t))
const darwin = (t: number) => fmt(t, 'Australia/Darwin', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const darwinTime = (t: number) => fmt(t, 'Australia/Darwin', { hour: 'numeric', minute: '2-digit' })
const darwinDay = (t: number) => fmt(t, 'Australia/Darwin', { weekday: 'long', day: 'numeric', month: 'long' })
const minutesIn = (t: number, tz: string) => { const [h, m] = fmt(t, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).split(':').map(Number); return h * 60 + m }

/** Where the release falls against that market's trading session. */
function sessionNote(e: { t: number; market: string }) {
  const us = e.market === 'US'
  const m = minutesIn(e.t, us ? 'America/New_York' : 'Australia/Sydney')
  const open = us ? 9 * 60 + 30 : 10 * 60, close = 16 * 60
  const name = us ? 'US' : 'ASX'
  if (m < open && open - m <= 120) return `${Math.round((open - m) / 60 * 10) / 10 === 1 ? 'an hour' : `${Math.round(open - m)} min`} before the ${name} open`
  if (m < open) return `before the ${name} open`
  if (m < close) return `during the ${name} session`
  return `after the ${name} close`
}
const until = (t: number) => {
  const d = t - Date.now()
  if (d < 0) return 'just happened'
  const h = Math.floor(d / 3_600_000)
  return h >= 48 ? `in ${Math.round(h / 24)} days` : h >= 1 ? `in ${h} h ${Math.round((d % 3_600_000) / 60_000)} min` : `in ${Math.round(d / 60_000)} min`
}

export default function EconCalendar() {
  const [data, setData] = useState<Econ | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [show, setShow] = useState<'both' | 'US' | 'ASX'>('both')
  const [high, setHigh] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/econ').then(r => r.json()).then(j => { if (alive) (j.error ? setError(j.error) : setData(j)) }).catch(e => alive && setError(String(e)))
    return () => { alive = false }
  }, [])

  const week = useMemo(() => (data?.week ?? []).filter(e => (show === 'both' || e.market === show) && (!high || e.impact === 'High')), [data, show, high])
  const soon = useMemo(() => (data?.week ?? []).filter(e => e.impact === 'High' && e.t > Date.now() - 3_600_000 && e.t < Date.now() + 36 * 3_600_000), [data])
  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>()
    for (const e of week) { const k = darwinDay(e.t); m.set(k, [...(m.get(k) ?? []), e]) }
    return [...m]
  }, [week])
  const banks = useMemo(() => [...(data?.fomc ?? []), ...(data?.rba ?? [])].sort((a, b) => a.t - b.t), [data])

  return (
    <main className="page narrow">
      <div className="page-head">
        <div className="lab-family">Shares lab · US &amp; ASX</div>
        <h1>Economic calendar</h1>
        <LabTabs family="shares" />
        <p>The releases and central-bank decisions that move US and Australian shares, in Darwin time. A Fed decision or a hot inflation number can swing the whole market at the open, so the day-trading lab stands aside from new trades within an hour of any high-impact release for that market.</p>
      </div>

      {error && <div className="notice err">Couldn't load the calendar: {error}</div>}
      {!data && !error && <div className="card empty">Loading…<div className="progress"><div /></div></div>}

      {data && (
        <>
          <section className="card">
            <h2>Next 36 hours: high impact</h2>
            {soon.length ? <ul className="econ-list">{soon.map((e, i) => (
              <li key={i} className="econ-item hi">
                <div className="econ-when"><b>{darwin(e.t)}</b><span className="muted small">{until(e.t)}</span></div>
                <div className="econ-what"><span className={`tag ${e.market === 'US' ? 'blue' : 'gold'}`}>{e.country}</span> <b>{e.title}</b>
                  <div className="muted small">{sessionNote(e)}{e.forecast ? ` · forecast ${e.forecast}` : ''}{e.previous ? ` · previous ${e.previous}` : ''}</div></div>
              </li>))}</ul>
              : <p className="muted">Nothing high-impact for the US or Australia in the next 36 hours.</p>}
          </section>

          <section className="card">
            <h2>Next central-bank decisions</h2>
            {banks.length ? <ul className="econ-list">{banks.map((m, i) => (
              <li key={i} className="econ-item">
                <div className="econ-when"><b>{darwin(m.t)}</b><span className="muted small">{until(m.t)}</span></div>
                <div className="econ-what"><span className={`tag ${m.market === 'US' ? 'blue' : 'gold'}`}>{m.market === 'US' ? 'US' : 'Australia'}</span> <b>{m.bank}</b>
                  <div className="muted small">{m.title} · {sessionNote(m)}</div></div>
              </li>))}</ul>
              : <p className="muted">Meeting dates are unavailable right now.</p>}
            <p className="hint">Fed decisions come at 2:00pm New York with the Chair's press conference at 2:30pm, in the last two hours of US trading. RBA decisions come at 2:30pm Sydney, in the last 90 minutes of ASX trading.</p>
          </section>

          <section className="card">
            <div className="econ-head">
              <h2>This week</h2>
              <div className="econ-filters">
                {(['both', 'US', 'ASX'] as const).map(k => <button key={k} className={`chip chip-sm ${show === k ? 'on' : ''}`} onClick={() => setShow(k)}>{k === 'both' ? 'US + Australia' : k === 'US' ? 'US' : 'Australia'}</button>)}
                <button className={`chip chip-sm ${high ? 'on' : ''}`} onClick={() => setHigh(h => !h)}>High impact only</button>
              </div>
            </div>
            {byDay.length ? byDay.map(([d, evs]) => (
              <div key={d} className="econ-day">
                <h3>{d}</h3>
                <ul className="econ-list">{evs.map((e, i) => (
                  <li key={i} className={`econ-item ${e.impact === 'High' ? 'hi' : ''}`}>
                    <div className="econ-when"><b>{darwinTime(e.t)}</b><span className={`tag ${e.impact === 'High' ? 'red' : e.impact === 'Holiday' ? '' : 'gold'}`}>{e.impact === 'Holiday' ? 'Holiday' : e.impact}</span></div>
                    <div className="econ-what"><span className={`tag ${e.market === 'US' ? 'blue' : 'gold'}`}>{e.country}</span> {e.title}
                      <div className="muted small">{e.impact !== 'Holiday' && sessionNote(e)}{e.forecast ? ` · forecast ${e.forecast}` : ''}{e.previous ? ` · previous ${e.previous}` : ''}</div></div>
                  </li>))}</ul>
              </div>)) : <p className="muted">No matching releases this week.</p>}
            <p className="hint">Times are Darwin time. Impact ratings, forecasts and previous figures come from the Forex Factory calendar. High impact = releases that usually move the whole market (inflation, jobs, GDP, retail sales, central-bank decisions and the Fed Chair's or RBA Governor's comments).</p>
          </section>

          <section className="card">
            <h2>Latest from the Fed and the RBA</h2>
            <ul className="lab-events">{data.news.slice(0, 12).map((n, i) => (
              <li key={i}><span className={`tag ${n.market === 'US' ? 'blue' : 'gold'}`}>{n.source}</span> <a href={n.link} target="_blank" rel="noreferrer">{n.title}</a>{n.t ? <span className="muted small"> · {darwin(n.t)}</span> : null}</li>))}</ul>
            <p className="hint">Monetary-policy press releases and speeches from federalreserve.gov (including the Chair's), and media releases from rba.gov.au.</p>
          </section>

          {data.errors.length > 0 && <p className="hint">Some sources didn't respond: {data.errors.join('; ')}.</p>}
          <p className="hint">Updated {darwin(data.at)} Darwin time. Refresh for the latest.</p>
        </>
      )}
    </main>
  )
}
