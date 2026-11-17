import { useEffect, useMemo, useState } from 'react'
import { Disclosure, Info } from './Info'
import { supabase } from '../lib/supabase'

interface Sig {
  key: string; category: string; entity_name: string; entity_role?: string; asset_ticker: string; asset_name?: string
  market: 'US' | 'ASX' | 'CRYPTO'; action: 'BUY' | 'SELL' | 'MENTION' | 'ALERT'; trade_size_usd: number | null
  trade_date: number | null; disclosed_at: number; disclosure_delay_days: number; sentiment_score: number | null
  text: string; sources: { source: string; url?: string }[]; confidence: number; day_weight: number; swing_weight: number
  cluster_size: number; badges: string[]; blocked: string | null; urgent?: boolean; topics?: string[]; tone?: number
}
interface Feed { signals: Sig[]; status: Record<string, { ok: boolean; n?: number; note?: string }>; runs: Record<string, number>; lastRun: number }

const FILTERS: { id: string; label: string; cats: string[] }[] = [
  { id: 'all', label: 'Everything', cats: [] },
  { id: 'uspol', label: 'US politicians', cats: ['politician_us'] },
  { id: 'aupol', label: 'AU politicians', cats: ['politician_au'] },
  { id: 'social', label: 'Social catalysts', cats: ['social'] },
  { id: 'insiders', label: 'Insiders & whales', cats: ['insider', 'insider_au', 'derivatives'] },
  { id: 'banks', label: 'Central banks', cats: ['central_bank'] },
]
const SOURCE_NAMES: Record<string, string> = { truth: 'Truth Social (Trump)', okx: 'OKX derivatives', sec: 'SEC Form 4 insiders', senate: 'US Senate disclosures', house: 'US House disclosures', asx3y: 'ASX director notices', auMPs: 'AU politicians (PoliticianTrades.au)', banks: 'Fed & RBA statements' }
const when = (t: number) => new Date(t).toLocaleString('en-AU', { timeZone: 'Australia/Darwin', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const day = (t: number) => new Date(t).toLocaleDateString('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
const usd = (x: number) => (x >= 1e6 ? `US$${(x / 1e6).toFixed(1)}m` : x >= 1e3 ? `US$${Math.round(x / 1e3)}k` : `US$${x}`)
const ACTION: Record<string, [string, string]> = { BUY: ['Buy', 'green'], SELL: ['Sell', 'red'], MENTION: ['Mention', 'blue'], ALERT: ['Alert', 'gold'] }

export default function SmartMoney() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('all')
  const [market, setMarket] = useState<'all' | 'US' | 'ASX' | 'CRYPTO'>('all')
  const [strong, setStrong] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (supabase) {
          const { data } = await supabase.from('lab_state').select('data').eq('id', 'signals').maybeSingle()
          if (data?.data) { if (alive) setFeed(data.data as Feed); return }
        }
        const r = await fetch('/api/signals-cron?dry=1&full=1'); const j = await r.json()
        if (alive) setFeed({ signals: j.signals, status: j.status, runs: {}, lastRun: Date.now() })
      } catch (e) { if (alive) setError(String(e)) }
    })()
    return () => { alive = false }
  }, [])

  const rows = useMemo(() => {
    const f = FILTERS.find(x => x.id === filter)!
    return (feed?.signals ?? []).filter(s => (!f.cats.length || f.cats.includes(s.category)) && (market === 'all' || s.market === market) && (!strong || s.confidence >= 0.5 || s.badges.length > 0))
  }, [feed, filter, market, strong])
  const top = useMemo(() => (feed?.signals ?? []).filter(s => s.action === 'BUY' && s.cluster_size > 1).slice(0, 6), [feed])

  return (
    <>
      <section className="card">
        <h2>Smart money &amp; political flow</h2>
        <p className="muted" style={{ marginTop: 0 }}>Trades disclosed by US and Australian politicians and company insiders, market-moving posts, crypto derivatives positioning and central-bank tone, in one feed. Repeats of the same trade from several sources are merged and raise its confidence; several people trading the same share is flagged as a cluster.</p>
        <div className="sm-filters">
          {FILTERS.map(f => <button key={f.id} className={`chip chip-sm ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
        <div className="sm-filters">
          {(['all', 'US', 'ASX', 'CRYPTO'] as const).map(m => <button key={m} className={`chip chip-sm ${market === m ? 'on' : ''}`} onClick={() => setMarket(m)}>{m === 'all' ? 'All markets' : m === 'CRYPTO' ? 'Crypto' : m}</button>)}
          <button className={`chip chip-sm ${strong ? 'on' : ''}`} onClick={() => setStrong(s => !s)}>Strong signals only</button>
        </div>
        {top.length > 0 && filter === 'all' && <div className="sm-cluster">
          <b>Clusters:</b> {top.map(s => <span key={s.key} className="tag green">{s.asset_ticker} · {s.cluster_size} {s.category.startsWith('politician') ? 'politicians' : 'insiders'} buying</span>)}
        </div>}
      </section>

      {error && <div className="notice err">{error}</div>}
      {!feed && !error && <div className="card empty">Loading the feed…<div className="progress"><div /></div></div>}

      {feed && (
        <section className="card">
          {rows.length ? <ul className="sm-list">{rows.slice(0, 150).map(s => {
            const [label, color] = ACTION[s.action]
            return (
              <li key={s.key} className={`sm-item ${s.blocked ? 'blocked' : ''}`}>
                <div className="sm-top">
                  <span className={`tag ${color}`}>{label}</span>
                  <b className="sm-ticker">{s.asset_ticker === 'MARKET' ? 'Whole market' : s.asset_ticker}</b>
                  <span className="muted small">{s.market === 'CRYPTO' ? 'Crypto' : s.market}</span>
                  {s.badges.map(b => <span key={b} className="tag green small">{b}</span>)}
                  {s.urgent && <span className="tag red small">urgent wording</span>}
                </div>
                <div className="sm-text">{s.text}</div>
                <div className="muted small sm-meta">
                  <span>{s.entity_name}{s.entity_role ? ` · ${s.entity_role}` : ''}</span>
                  {s.trade_size_usd ? <span>size ≈ {usd(s.trade_size_usd)}</span> : null}
                  {s.trade_date ? <span>traded {day(s.trade_date)}, public {day(s.disclosed_at)} ({s.disclosure_delay_days} days later)</span> : <span>{when(s.disclosed_at)} Darwin</span>}
                  {s.sentiment_score != null && s.action === 'MENTION' && <span>tone {s.sentiment_score > 0.2 ? 'positive' : s.sentiment_score < -0.2 ? 'negative' : 'mixed'}</span>}
                </div>
                <div className="sm-scores">
                  <span>Confidence <b>{Math.round(s.confidence * 100)}%</b><span className="sm-bar"><i style={{ width: `${Math.round(s.confidence * 100)}%` }} /></span></span>
                  <span className="muted small">day-trade weight {s.day_weight.toFixed(2)} · swing weight {s.swing_weight.toFixed(2)} <Info>Day-trade weight fades within hours or days and is cut hard for late disclosures (US politicians may file up to 45 days after trading). Swing weight fades slowly, so late filings still count as confirmation of a longer move.</Info></span>
                </div>
                {s.blocked && <div className="notice warn small">Do not buy yet: {s.blocked}.</div>}
                <div className="small sm-src">{s.sources.map((x, i) => x.url ? <a key={i} href={x.url} target="_blank" rel="noreferrer">{x.source}</a> : <span key={i}>{x.source}</span>)}</div>
              </li>)
          })}</ul> : <p className="muted">Nothing matches these filters yet. Sources fill in over the first few hours.</p>}
          <p className="hint">Research only: none of these is a trade instruction. Politicians' and insiders' trades are disclosed days to weeks after they happen, and studies disagree on whether following politicians beats the market. Company insiders buying together (clusters) has the strongest research support. These signals will be tested against the market index like every other rule once enough history builds up.</p>
          <Disclosure title={<b>Sources and when they last ran</b>}>
            <ul className="lab-events">{Object.entries(SOURCE_NAMES).map(([k, name]) => {
              const st = feed.status?.[k]
              return <li key={k}><b>{name}</b>: {st ? (st.ok ? `ok, ${st.n} new item${st.n === 1 ? '' : 's'}` : st.note) : 'not run yet'}{feed.runs?.[k] ? <span className="muted small"> · {when(feed.runs[k])}</span> : null}</li>
            })}</ul>
            <p className="hint">Updated {feed.lastRun ? when(feed.lastRun) : '…'} Darwin time. The feed refreshes every 30 minutes; slower official sources run a few times a day.</p>
          </Disclosure>
        </section>
      )}
    </>
  )
}
