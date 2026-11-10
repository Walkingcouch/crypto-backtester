import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import FanChart, { OutcomeBars } from '../components/FanChart'
import { Info } from '../components/Info'
import Chatter, { type ChatterData } from '../components/Chatter'
import CoinTable, { MarketNotes } from '../components/CoinTable'
import CompareForecastChart, { type ForecastLine } from '../components/CompareForecastChart'
import { useCoinMarket } from '../lib/useCoinMarket'
import { fetchCandles } from '../lib/data'
import { attachMood, forecastAt, HORIZONS, moodZones, prepare, trackRecord, type Forecast, type Prepared, type TrackRecord } from '../lib/forecast'
import { fmtMoney, fxSeries, nowRate, rateAt, useCurrency, type Cur, type FxSeries } from '../lib/currency'
import { supabase } from '../lib/supabase'

const COINS = [
  { sym: 'BTCUSDT', name: 'Bitcoin' }, { sym: 'ETHUSDT', name: 'Ethereum' }, { sym: 'SOLUSDT', name: 'Solana' },
  { sym: 'XRPUSDT', name: 'XRP' }, { sym: 'ADAUSDT', name: 'Cardano' }, { sym: 'DOGEUSDT', name: 'Dogecoin' },
]
const DAY = 86_400_000
const PALETTE = ['#0b7a5c', '#3b6fd8', '#d9822b', '#b5459b', '#2a9db5', '#c2412d']
const MAX_COMPARE = 6
const pct = (x: number, d = 0) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '–')
const pct0 = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–')
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
function fmtPrice(x: number, cur: Cur) {
  if (!Number.isFinite(x)) return '–'
  const digits = x >= 1000 ? 0 : x >= 10 ? 2 : x >= 1 ? 3 : 5
  return fmtMoney(x, cur, digits)
}

interface Loaded { symbol: string; t: number[]; closes: number[]; P: Prepared; live: number }
interface LogRow { as_of: string; made_at: string; target_at: string | null; outcome: number | null; symbol: string; horizon: number; price: number; p5: number; p10: number; p25: number; p75: number; p90: number; p95: number; p_up: number }

export default function Predict() {
  const [params, setParams] = useSearchParams()
  const { cur, live: liveFx } = useCurrency()
  const symParam = (params.get('coin') || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const h = HORIZONS.some(x => x.days === +(params.get('h') || 0)) ? +(params.get('h') as string) : 30
  const [, setOther] = useState(COINS.some(c => c.sym === symParam) ? '' : symParam)
  const [data, setData] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [record, setRecord] = useState<TrackRecord | null>(null)
  const [recordMood, setRecordMood] = useState<TrackRecord | null>(null)
  const [chatter, setChatter] = useState<ChatterData | null>(null)
  const [chatterErr, setChatterErr] = useState<string | null>(null)
  const [fx, setFx] = useState<FxSeries | null>(null)
  const [log, setLog] = useState<{ rows: LogRow[]; error?: string } | null>(null)
  const [track, setTrack] = useState<{ tracked?: string | false; saved?: unknown; error?: string } | null>(null)
  const [logBump, setLogBump] = useState(0)

  const focusBase = symParam.replace(/USDT$/, '')
  const selected = useMemo(() => {
    const list = (params.get('compare') || '').split(',').filter(Boolean)
    return list.includes(focusBase) ? list : [focusBase, ...list].slice(0, MAX_COMPARE)
  }, [params, focusBase])
  const M = useCoinMarket({ keep: selected, pageSize: 25 })
  const [listOpen, setListOpen] = useState(true)
  const forecastRef = useRef<HTMLDivElement>(null)
  const compareRef = useRef<HTMLDivElement>(null)
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); p.set(k, v); setParams(p, { replace: true }) }
  const colorOf = (b: string) => PALETTE[Math.max(0, selected.indexOf(b)) % PALETTE.length]
  /** Tick or untick a coin. Ticking also makes it the coin shown in detail below. */
  function toggle(b: string) {
    const p = new URLSearchParams(params)
    let list = selected.slice()
    if (list.includes(b)) {
      if (list.length === 1) return
      list = list.filter(x => x !== b)
      if (b === focusBase) p.set('coin', list[0] + 'USDT')
    } else {
      if (list.length >= MAX_COMPARE) list = list.slice(0, MAX_COMPARE - 1)
      list.push(b); p.set('coin', b + 'USDT')
    }
    p.set('compare', list.join(','))
    setParams(p, { replace: true })
  }
  const focusOn = (b: string) => { set('coin', b + 'USDT'); window.setTimeout(() => forecastRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60) }

  // forecasts for every ticked coin (for the comparison chart)
  const [cmp, setCmp] = useState<Map<string, ForecastLine | { base: string; error: string }>>(new Map())
  useEffect(() => {
    if (selected.length < 2) return
    let alive = true
    for (const b of selected) {
      const key = `${b}|${h}`
      if (cmp.has(key)) continue
      fetchCandles(b + 'USDT', '1d', '2017-01-01').then(bars => {
        if (!alive) return
        const P = prepare(bars.map(x => x.c))
        const fc = bars.length >= 400 ? forecastAt(P, P.n - 1, h) : null
        const last = bars[bars.length - 1]?.c
        const from = Math.max(0, bars.length - Math.max(90, h * 2))
        const line = fc ? {
          base: b, color: '', t: bars.slice(from).map(x => x.t), pct: bars.slice(from).map(x => (x.c / last - 1) * 100),
          target: (Number.isFinite(fc.analog.median) ? fc.analog.median : 0) * 100,
          lo: (fc.levels.p10 / fc.price - 1) * 100, hi: (fc.levels.p90 / fc.price - 1) * 100,
        } : { base: b, error: `${b} needs at least 400 days of history` }
        setCmp(m => new Map(m).set(key, line))
      }).catch(e => alive && setCmp(m => new Map(m).set(key, { base: b, error: String(e.message || e) })))
    }
    return () => { alive = false }
  }, [selected, h]) // eslint-disable-line react-hooks/exhaustive-deps
  const cmpLines = selected.map(b => cmp.get(`${b}|${h}`)).filter((l): l is ForecastLine => !!l && !('error' in l)).map(l => ({ ...l, color: colorOf(l.base) }))
  const cmpErrors = selected.map(b => cmp.get(`${b}|${h}`)).filter((l): l is { base: string; error: string } => !!l && 'error' in l)
  const symbol = symParam
  const base = symbol.replace(/USDT$/, '')
  const coinName = COINS.find(c => c.sym === symbol)?.name ?? base
  const hLabel = HORIZONS.find(x => x.days === h)!.label

  // news, social, trending and Fear & Greed (server-side, cached)
  useEffect(() => {
    fetch('/api/chatter').then(r => { if (!r.ok) throw new Error(`News feed unavailable (${r.status}).`); return r.json() })
      .then(setChatter).catch(e => setChatterErr(e.message))
  }, [])

  // load history + live price
  useEffect(() => {
    let alive = true
    setError(null); setData(null); setRecord(null)
    setBusy(`Loading ${coinName} history…`)
    ;(async () => {
      try {
        const bars = await fetchCandles(symbol, '1d', '2017-01-01', n => alive && setBusy(`Loading ${coinName} history… ${n.toLocaleString()} days`))
        if (bars.length < 400) throw new Error(`${base} has only ${bars.length} days of history. Forecasts need at least 400.`)
        let live = bars[bars.length - 1].c
        try {
          const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`)
          if (r.ok) { const j = await r.json(); if (+j.price > 0) live = +j.price }
        } catch { /* use last close */ }
        if (!alive) return
        const closes = bars.map(b => b.c)
        setData({ symbol, t: bars.map(b => b.t), closes, P: prepare(closes), live })
        // add this coin to the 5-hourly log and save a forecast for it now
        setTrack(null)
        fetch(`/api/track?coin=${symbol}&name=${encodeURIComponent(coinName)}`)
          .then(r => r.json()).then(j => { if (alive) { setTrack(j); setLogBump(b => b + 1) } })
          .catch(() => alive && setTrack({ error: 'Could not reach the log right now.' }))
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)) }
      finally { if (alive) setBusy(null) }
    })()
    return () => { alive = false }
  }, [symbol]) // eslint-disable-line react-hooks/exhaustive-deps

  // feed market mood (Fear & Greed history) into the data
  const P = useMemo(() => {
    if (!data) return null
    const hist = chatter?.fng?.history
    return hist?.length ? attachMood(prepare(data.closes), data.t, hist) : data.P
  }, [data, chatter])
  const hasMood = !!P?.mood && Number.isFinite(P.mood[P.n - 1])

  // use mood only if it has actually improved this coin's past direction calls
  const moodHelps = !!(record && recordMood && recordMood.n >= 100 && recordMood.brier < record.brier - 0.002)
  const f: Forecast | null = useMemo(() => (P ? forecastAt(P, P.n - 1, h, { mood: moodHelps }) : null), [P, h, moodHelps])
  const zones = useMemo(() => (P && hasMood ? moodZones(P, h) : []), [P, h, hasMood])

  // walk-forward track record (heavier: run after paint)
  useEffect(() => {
    setRecord(null); setRecordMood(null)
    if (!P) return
    const id = window.setTimeout(() => {
      const plain = trackRecord(P, h, 3)
      setRecord(plain)
      if (P.mood) window.setTimeout(() => setRecordMood(trackRecord(P, h, 3, 300, { mood: true })), 20)
    }, 30)
    return () => window.clearTimeout(id)
  }, [P, h])

  // AUD history for the chart
  useEffect(() => {
    if (cur !== 'AUD' || !data || fx) return
    fxSeries(data.t[Math.max(0, data.t.length - 400)]).then(setFx).catch(() => setFx(null))
  }, [cur, data, fx])

  // daily live log from Supabase
  useEffect(() => {
    setLog(null)
    if (!supabase) return
    supabase.from('forecasts').select('*').eq('symbol', symbol).eq('horizon', h).order('made_at', { ascending: false }).limit(2000)
      .then(({ data: rows, error: err }) => setLog(err ? { rows: [], error: err.message } : { rows: (rows ?? []) as LogRow[] }))
  }, [symbol, h, logBump])

  const rate = nowRate(cur, liveFx)
  const scale = f && data ? (data.live / f.price) * (rate ?? 1) : 1
  const fmt = (x: number) => fmtPrice(x, rate == null ? 'USD' : cur)

  const chart = useMemo(() => {
    if (!data || !f) return null
    const n = data.t.length, from = Math.max(0, n - Math.max(120, h * 3))
    const t = data.t.slice(from), c = data.closes.slice(from)
    const conv = c.map((p, i) => (cur === 'AUD' && fx ? p * rateAt(fx, t[i]) : p * (rate ?? 1)))
    // make the last point the live price (if the history is current)
    if (Date.now() - t[t.length - 1] < 3 * DAY) { t.push(Date.now()); conv.push(data.live * (rate ?? 1)) }
    const L = f.levels, k = scale
    return { t, prices: conv, levels: { p5: L.p5 * k, p10: L.p10 * k, p25: L.p25 * k, p50: L.p50 * k, p75: L.p75 * k, p90: L.p90 * k, p95: L.p95 * k } }
  }, [data, f, h, cur, fx, rate, scale])

  const graded = useMemo(() => {
    if (!log || !data) return null
    const done: (LogRow & { outcome: number })[] = []
    let pending = 0, nextDue: number | null = null
    for (const r of log.rows) {
      if (r.outcome != null) { done.push(r as LogRow & { outcome: number }); continue }
      const due = r.target_at ? Date.parse(r.target_at) : Date.parse(r.made_at) + h * DAY
      pending++; if (nextDue == null || due < nextDue) nextDue = due
    }
    const n = done.length
    const in80 = done.filter(r => r.outcome >= r.p10 && r.outcome <= r.p90).length
    const in50 = done.filter(r => r.outcome >= r.p25 && r.outcome <= r.p75).length
    const dir = done.filter(r => (r.p_up >= 0.5) === (r.outcome > r.price)).length
    const since = log.rows.length ? log.rows[log.rows.length - 1].made_at : null
    return { n, in80, in50, dir, pending, nextDue, since, recent: done.slice(0, 8) }
  }, [log, data, h])

  const trendTxt = f ? (f.situation.trend === 1 ? 'Uptrend' : f.situation.trend === -1 ? 'Downtrend' : 'Mixed trend') : ''
  const volTxt = f ? (f.situation.volPct < 0.25 ? 'calm' : f.situation.volPct > 0.75 ? 'wild' : 'normal') : ''

  return (
    <main className="page narrow">
      <div className="page-head">
        <h1>Predictions</h1>
        <p>Where the price could be, based on how this coin has moved before. Every forecast is tested against what actually
          happened, so you can see how much to trust it.</p>
      </div>

      <section className="card">
        <div className="card-title">
          <div><h2 style={{ margin: 0 }}>Choose a coin</h2>
            <div className="small muted">Rank and filter every coin, then tick one or more to see their predictions.</div></div>
          <button className="btn btn-ghost btn-sm" onClick={() => setListOpen(o => !o)}>{listOpen ? 'Hide list' : `Show all coins${M.all.length ? ` (${M.all.length})` : ''}`}</button>
        </div>
        <div className="chips" style={{ marginBottom: 12 }}>
          {COINS.map(c => (
            <button key={c.sym} className={`chip chip-sm ${selected.includes(c.sym.replace(/USDT$/, '')) ? 'on' : ''}`} onClick={() => { setOther(''); if (selected.includes(c.sym.replace(/USDT$/, ''))) focusOn(c.sym.replace(/USDT$/, '')); else toggle(c.sym.replace(/USDT$/, '')) }}><b>{c.name}</b></button>
          ))}
        </div>
        {listOpen && (
          <>
            <MarketNotes M={M} />
            <div style={{ height: 12 }} />
            <CoinTable M={M} mode="compare" selected={selected} colorOf={colorOf} onRow={b => { setOther(''); toggle(b) }} />
            <p className="hint" style={{ marginTop: 10 }}>Tap coins to tick them (up to {MAX_COMPARE}). Ticked coins are compared on one forecast chart, and the last one you tick is shown in detail below.</p>
          </>
        )}
      </section>

      {selected.length >= 2 && (
        <section className="card" ref={compareRef}>
          <div className="card-title">
            <div><h2 style={{ margin: 0 }}>Compare forecasts · {hLabel}</h2>
              <div className="small muted">Past moves shown relative to today's price (0%). Heavy line = typical result in similar past moments; dashed = likely (80%) range.</div></div>
          </div>
          <div className="predict-controls" style={{ marginTop: 0, marginBottom: 8 }}>
            <label className="mini"><span>Forecast for</span>
              <select value={h} onChange={e => set('h', e.target.value)} className="horizon-select">
                {HORIZONS.map(x => <option key={x.days} value={x.days}>{x.label}</option>)}
              </select></label>
          </div>
          <div className="compare-legend">
            {selected.map(b => {
              const l = cmpLines.find(x => x.base === b)
              return (
                <span key={b} className={`cl-item ${b === focusBase ? 'cl-focus' : ''}`}>
                  <i style={{ background: colorOf(b) }} /><b>{b}</b>
                  {l ? <span className="small">{l.target >= 0 ? '+' : ''}{l.target.toFixed(1)}% <span className="muted">({l.lo.toFixed(0)}% to +{l.hi.toFixed(0)}%)</span></span> : <span className="muted small">…</span>}
                  {b !== focusBase ? <button className="cl-link" onClick={() => focusOn(b)}>Details</button> : <span className="tag green">shown below</span>}
                  <button aria-label={`Remove ${b}`} onClick={() => toggle(b)}>×</button>
                </span>
              )
            })}
          </div>
          {cmpErrors.map(e => <div key={e.base} className="notice warn small">{e.error}</div>)}
          {cmpLines.length ? <CompareForecastChart lines={cmpLines} h={h} focus={focusBase} onFocus={focusOn} /> : <div className="chart empty">Loading forecasts…</div>}
          <p className="hint">Tap a line or "Details" to see that coin's full prediction, track record and news below.</p>
        </section>
      )}

      <section className="card predict-bar" ref={forecastRef}>
        <div className="predict-controls" style={{ marginTop: 0 }}>
          <div><div className="small muted">Predicting</div><div className="pb-coin">{coinName}{coinName !== base && <span className="muted"> {base}</span>}</div></div>
          <label className="mini"><span>Forecast for</span>
            <select value={h} onChange={e => set('h', e.target.value)} className="horizon-select">
              {HORIZONS.map(x => <option key={x.days} value={x.days}>{x.label}</option>)}
            </select>
          </label>
          {data && <span className="small muted">Price now: <b style={{ color: 'var(--text)' }}>{fmt(data.live * (rate ?? 1))}</b></span>}
        </div>
        {busy && <><div className="progress"><div /></div><p className="hint">{busy}</p></>}
        {error && <div className="notice err" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
      </section>

      {f && data && chart && (
        <>
          <section className="card">
            <div className="step-head">
              <span className="step-badge">{coinName} in {hLabel}</span>
              <h2>Likely between {fmt(chart.levels.p10)} and {fmt(chart.levels.p90)}</h2>
              <p className="muted small">That's the 80% range: past forecasts like this caught the real price about 8 times in 10{record ? ` (for ${base}, ${pct0(record.cover80)})` : ''}.</p>
            </div>
            <div className="range-grid">
              <div className="stat"><div className="stat-label">Middle half (50%) <Info>Half the time the price ended up inside this narrower range.</Info></div>
                <div className="stat-value small-v">{fmt(chart.levels.p25)} – {fmt(chart.levels.p75)}</div>
                <div className="stat-sub">{pct(chart.levels.p25 / chart.levels.p50 - 1)} to {pct(chart.levels.p75 / chart.levels.p50 - 1)}</div></div>
              <div className="stat"><div className="stat-label">Likely (80%)</div>
                <div className="stat-value small-v">{fmt(chart.levels.p10)} – {fmt(chart.levels.p90)}</div>
                <div className="stat-sub">{pct(chart.levels.p10 / chart.levels.p50 - 1)} to {pct(chart.levels.p90 / chart.levels.p50 - 1)}</div></div>
              <div className="stat"><div className="stat-label">Wide (90%) <Info>Only 1 time in 10 did the price land outside this. Useful for deciding where a stop-loss would rarely be hit by normal noise.</Info></div>
                <div className="stat-value small-v">{fmt(chart.levels.p5)} – {fmt(chart.levels.p95)}</div>
                <div className="stat-sub">{pct(chart.levels.p5 / chart.levels.p50 - 1)} to {pct(chart.levels.p95 / chart.levels.p50 - 1)}</div></div>
              <div className="stat"><div className="stat-label">Chance it's higher <Info>From similar past moments, blended with how often {base} rose over {hLabel} in general. Direction is close to a coin flip for any method; check the track record below before leaning on it.</Info></div>
                <div className="stat-value">{pct0(f.pUp)}</div>
                <div className="stat-sub">usually {pct0(f.baseUp)} over any {hLabel}</div></div>
            </div>
            <div className="situation">
              <span className={`tag ${f.situation.trend === 1 ? 'green' : f.situation.trend === -1 ? 'red' : ''}`}>{trendTxt}</span>
              <span className="tag">{pct(f.situation.r7)} in 7 days</span>
              <span className="tag">{pct(f.situation.r30)} in 30 days</span>
              <span className="tag">Volatility {volTxt} ({Math.round(f.situation.volPct * 100)}th percentile)</span>
            </div>
            <FanChart t={chart.t} prices={chart.prices} levels={chart.levels} h={h} fmt={fmt} target={chart.prices[chart.prices.length - 1] * (1 + (Number.isFinite(f.analog.median) ? f.analog.median : 0))} />
            <p className="hint">Heavy line: today's price to the typical result in similar past moments ({pct(f.analog.median, 1)}). Dashed lines: the likely (80%) range. Direction is the least reliable part, so check the track record below.
              {cur === 'AUD' && ' Converted at today\'s exchange rate.'}</p>
          </section>

          <section className="card">
            <div className="step-head">
              <span className="step-badge">What happened next</span>
              <h2>{f.analog.n} past moments that looked like today</h2>
              <p className="muted small">Days when {base} had a similar 7- and 30-day move (allowing for how wild it was) and the same trend{f.usedMood ? `, and similar market mood (Fear & Greed ${f.mood})` : ''}. Here's where it was {hLabel} later.</p>
            </div>
            <div className="range-grid">
              <div className="stat"><div className="stat-label">Ended higher</div><div className="stat-value">{pct0(f.analog.up)}</div><div className="stat-sub">of {f.analog.n} cases</div></div>
              <div className="stat"><div className="stat-label">Typical result</div><div className={`stat-value ${f.analog.median >= 0 ? 'pos' : 'neg'}`}>{pct(f.analog.median, 1)}</div><div className="stat-sub">the middle case</div></div>
              <div className="stat"><div className="stat-label">Usual range</div><div className="stat-value small-v">{pct(f.analog.p10)} to {pct(f.analog.p90)}</div><div className="stat-sub">8 in 10 cases</div></div>
              <div className="stat"><div className="stat-label">Worst / best</div><div className="stat-value small-v"><span className="neg">{pct(f.analog.worst)}</span> / <span className="pos">{pct(f.analog.best)}</span></div><div className="stat-sub">single cases</div></div>
            </div>
            <OutcomeBars outcomes={f.analog.outcomes} />
            <p className="hint">Similar dates: {f.analog.idx.slice().sort((a, b) => b - a).slice(0, 10).map(i => new Date(data.t[i]).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })).join(' · ')}{f.analog.n > 10 ? ' …' : ''}</p>
          </section>

          <section className="card">
            <div className="step-head">
              <span className="step-badge">Track record</span>
              <h2>How accurate has this been for {base}?</h2>
              <p className="muted small">We re-made this forecast on past days, using only the prices known on each day, and checked what happened {hLabel} later.</p>
            </div>
            {!record ? <div className="empty small">Testing past forecasts…</div> : record.n === 0 ? <div className="empty small">Not enough history to test yet.</div> : (
              <>
                <div className="table-wrap"><table className="record">
                  <thead><tr><th>Forecast</th><th>Aim</th><th>Got</th><th></th></tr></thead>
                  <tbody>
                    {([['50% range', 0.5, record.cover50], ['80% range', 0.8, record.cover80], ['90% range', 0.9, record.cover90]] as const).map(([name, aim, got]) => {
                      const off = got - aim
                      return <tr key={name}><td>{name}</td><td>{pct0(aim)}</td><td><b>{pct0(got)}</b></td>
                        <td>{Math.abs(off) <= 0.05 ? <span className="tag green">Reliable</span> : off < 0 ? <span className="tag amber">Too narrow</span> : <span className="tag">A bit cautious</span>}</td></tr>
                    })}
                    <tr><td>Higher/lower <Info>Right if it said 50%+ and the price rose, or under 50% and it fell. "Always guess the usual" means always guessing whichever direction happened most often.</Info></td>
                      <td>{pct0(Math.max(record.upRate, 1 - record.upRate))}*</td>
                      <td><b>{pct0(record.hitRate)}</b></td>
                      <td>{record.brier < record.brierBase - 0.003 ? <span className="tag green">Some edge</span> : <span className="tag amber">No real edge</span>}</td></tr>
                  </tbody>
                </table></div>
                <p className="hint">* Aim for higher/lower = the score from always guessing whichever direction happened most often.</p>
                {hasMood && (
                  <div className={`notice ${moodHelps ? 'ok' : 'info'} small`} style={{ marginTop: 12 }}>
                    <b>Market mood (Fear &amp; Greed):</b>{' '}
                    {!recordMood ? 'testing whether it helps…'
                      : moodHelps ? `adding it improved ${base}'s past direction calls (right ${pct0(recordMood.hitRate)} vs ${pct0(record.hitRate)} without), so it's used in "Chance it's higher" and "What happened next".`
                      : `adding it didn't improve ${base}'s past direction calls (right ${pct0(recordMood.hitRate)} with it, ${pct0(record.hitRate)} without), so it isn't used in the numbers. It's still shown below.`}
                  </div>
                )}
                <p className="hint">{record.n.toLocaleString()} past forecasts, {day(data.t[record.first])} to {day(data.t[record.last])}, one every {record.step} days. Neighbouring forecasts overlap, so treat small differences as noise.</p>
              </>
            )}
          </section>

          <section className="card">
            <div className="step-head">
              <span className="step-badge">Live log</span>
              <h2>Forecasts saved every 5 hours, graded when the time arrives</h2>
              {track && (
                <div className={`notice ${track.error ? 'warn' : 'ok'} small`}>
                  {track.error ? `Couldn't add ${base} to the log: ${track.error}`
                    : track.tracked === 'added' ? `✓ ${base} added. A forecast was saved now, and it'll be saved every 5 hours from here on.`
                    : track.tracked === 'full' ? `The log is full (50 extra coins). ${base} wasn't added.`
                    : `✓ ${base} is in the log, saved every 5 hours.`}
                </div>
              )}
              <p className="muted small">A record that can't be tuned after the fact. Every 5 hours a forecast is saved at the live price for the main coins and every coin you've opened here, and checked against the price at that exact hour once its {hLabel} are up.</p>
            </div>
            {!supabase ? <p className="muted small">Database not connected.</p>
              : !log ? <div className="empty small">Loading…</div>
              : log.error ? <div className="notice info small">The live log isn't switched on yet. It needs a one-time database step, as described in the Guide.</div>
              : log.rows.length === 0 ? <div className="notice info small">No saved forecasts for {base} yet. Opening a coin here adds it to the log automatically.</div>
              : graded && (
                <>
                  <div className="range-grid">
                    <div className="stat"><div className="stat-label">Graded so far</div><div className="stat-value">{graded.n}</div><div className="stat-sub">{graded.pending} waiting{graded.nextDue ? ` · next ${when(graded.nextDue)}` : ''}</div></div>
                    <div className="stat"><div className="stat-label">Inside 80% range</div><div className="stat-value">{graded.n ? pct0(graded.in80 / graded.n) : '–'}</div><div className="stat-sub">aim 80%</div></div>
                    <div className="stat"><div className="stat-label">Inside 50% range</div><div className="stat-value">{graded.n ? pct0(graded.in50 / graded.n) : '–'}</div><div className="stat-sub">aim 50%</div></div>
                    <div className="stat"><div className="stat-label">Direction right</div><div className="stat-value">{graded.n ? pct0(graded.dir / graded.n) : '–'}</div><div className="stat-sub">coin flip 50%</div></div>
                  </div>
                  {graded.recent.length > 0 && (
                    <div className="table-wrap"><table>
                      <thead><tr><th>Made on</th><th>Price then</th><th>80% range</th><th>Actual</th><th></th></tr></thead>
                      <tbody>{graded.recent.map(r => (
                        <tr key={r.made_at}><td>{when(Date.parse(r.made_at))}</td><td>{fmtPrice(r.price, 'USD')}</td><td>{fmtPrice(r.p10, 'USD')} – {fmtPrice(r.p90, 'USD')}</td><td>{fmtPrice(r.outcome, 'USD')}</td>
                          <td>{r.outcome >= r.p10 && r.outcome <= r.p90 ? <span className="tag green">Inside</span> : <span className="tag red">Outside</span>}</td></tr>
                      ))}</tbody>
                    </table></div>
                  )}
                  <p className="hint">Logging since {graded.since ? when(Date.parse(graded.since)) : '–'} ({log.rows.length} saved). Log prices are in USD, as recorded.</p>
                </>
              )}
          </section>

          <Chatter base={base} name={coinName} data={chatter} error={chatterErr} zones={zones} hLabel={hLabel} moodUsed={!!f.usedMood} />

          {selected.length >= 2 && (
            <div className="compare-bar">
              <span className="small"><b>{selected.length}</b> ticked</span>
              <span className="cb-dots">{selected.map(b => <i key={b} style={{ background: colorOf(b) }} title={b} />)}</span>
              <span className="spacer" />
              <button className="btn btn-primary btn-sm" onClick={() => compareRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Compare chart</button>
            </div>
          )}
          <p className="hint center">These are statistics about how {base} has moved before, not promises, and not financial advice.
            Want to know if a rule would have made money? <Link to={`/?coin=${symbol}`}>Backtest {base} →</Link></p>
        </>
      )}
    </main>
  )
}
