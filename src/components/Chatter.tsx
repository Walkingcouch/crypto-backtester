import { useMemo, useState } from 'react'
import { Info } from './Info'
import type { MoodZone } from '../lib/forecast'

export interface ChatterItem { title: string; link: string; summary: string; time: number | null; source: string; tone: number; score?: number; comments?: number }
export interface ChatterData {
  updated: string
  news: ChatterItem[]
  social: ChatterItem[]
  trending: { symbol: string; name: string; rank: number | null }[]
  fng: { value: number; label: string; time: number; history: [number, number][] } | null
  sources: Record<string, { ok: boolean; n?: number; error?: string; via?: string }>
}

const ALIASES: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc'], ETH: ['ethereum', 'ether', 'eth'], SOL: ['solana', 'sol'], XRP: ['xrp', 'ripple'],
  ADA: ['cardano', 'ada'], DOGE: ['dogecoin', 'doge'], LINK: ['chainlink'], AVAX: ['avalanche', 'avax'],
  DOT: ['polkadot'], LTC: ['litecoin', 'ltc'], BNB: ['bnb', 'binance coin'], TRX: ['tron', 'trx'], TON: ['toncoin'],
  SHIB: ['shiba inu', 'shib'], PEPE: ['pepe'], SUI: ['sui'], NEAR: ['near protocol'], XLM: ['stellar', 'xlm'],
}
const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')} `
export function mentions(text: string, base: string, name?: string) {
  const w = words(text)
  const terms = new Set([...(ALIASES[base] || []), ...(base.length >= 3 ? [base.toLowerCase()] : []), ...(name && name.length >= 4 ? [name.toLowerCase()] : [])])
  for (const k of terms) if (w.includes(` ${k} `)) return true
  return false
}
const ago = (t: number | null) => {
  if (!t) return ''
  const m = Math.round((Date.now() - t) / 60000)
  return m < 60 ? `${Math.max(1, m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}
const toneLabel = (x: number) => (x > 0.15 ? { t: 'Positive', c: 'green' } : x < -0.15 ? { t: 'Negative', c: 'red' } : { t: 'Mixed', c: '' })
const pct0 = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–')
const pct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%` : '–')

function stats(items: ChatterItem[]) {
  const now = Date.now()
  const timed = items.filter(i => i.time)
  const day = timed.filter(i => now - (i.time as number) < 86_400_000).length
  const oldest = timed.length ? Math.min(...timed.map(i => i.time as number)) : now
  const spanDays = Math.max(1, (now - oldest) / 86_400_000)
  const perDay = timed.length / spanDays
  const recentTone = items.slice(0, 30)
  const tone = recentTone.length ? recentTone.reduce((s, i) => s + i.tone, 0) / recentTone.length : 0
  return { day, perDay, tone, n: items.length }
}

export default function Chatter({ base, name, data, error, zones, hLabel, moodUsed }: {
  base: string; name: string; data: ChatterData | null; error: string | null; zones: MoodZone[]; hLabel: string; moodUsed: boolean
}) {
  const [tab, setTab] = useState<'news' | 'social'>('news')
  const coin = useMemo(() => {
    if (!data) return null
    const sort = (a: ChatterItem[]) => a.slice().sort((x, y) => (y.time ?? 0) - (x.time ?? 0))
    const news = sort(data.news.filter(i => mentions(`${i.title} ${i.summary}`, base, name)))
    const social = sort(data.social.filter(i => mentions(`${i.title} ${i.summary}`, base, name)))
    return { news, social, newsAll: sort(data.news), socialAll: sort(data.social), sNews: stats(news), sSocial: stats(social) }
  }, [data, base, name])

  if (error) return <section className="card"><h2>News &amp; chatter</h2><div className="notice info small">{error}</div></section>
  if (!data || !coin) return <section className="card"><h2>News &amp; chatter</h2><div className="empty small">Gathering headlines and chatter…</div></section>

  const fng = data.fng
  const zoneNow = fng ? zones.find(z => fng.value >= z.lo && fng.value < z.hi) : undefined
  const trending = data.trending.find(t => t.symbol === base)
  const list = tab === 'news' ? (coin.news.length ? coin.news : coin.newsAll) : (coin.social.length ? coin.social : coin.socialAll)
  const filtered = tab === 'news' ? coin.news.length > 0 : coin.social.length > 0
  const okSources = Object.entries(data.sources).filter(([, v]) => v.ok).length
  const failed = Object.entries(data.sources).filter(([, v]) => !v.ok).map(([k]) => k)
  const buzz = (s: ReturnType<typeof stats>) => s.perDay > 0 ? s.day / s.perDay : NaN

  return (
    <section className="card">
      <div className="step-head">
        <span className="step-badge">News &amp; chatter</span>
        <h2>What people are saying about {name}</h2>
        <p className="muted small">Headlines from crypto news sites, Reddit posts, trending coins and the market's Fear &amp; Greed mood.</p>
      </div>

      <div className="range-grid">
        <div className="stat">
          <div className="stat-label">Market mood <Info>The Crypto Fear &amp; Greed Index (alternative.me), 0 = extreme fear, 100 = extreme greed. Covers the whole market, mostly driven by Bitcoin.</Info></div>
          <div className="stat-value">{fng ? fng.value : '–'} <span className={`tag ${fng && fng.value >= 55 ? 'green' : fng && fng.value < 46 ? 'red' : ''}`}>{fng?.label ?? 'n/a'}</span></div>
          <div className="stat-sub">{moodUsed ? 'used in the forecast above' : 'shown only (didn’t improve past forecasts)'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">News mentions (24h) <Info>Headlines naming {name} in the last 24 hours, compared with the usual daily rate in the feeds. Higher than usual = more attention.</Info></div>
          <div className="stat-value">{coin.sNews.day}</div>
          <div className="stat-sub">{Number.isFinite(buzz(coin.sNews)) ? `${buzz(coin.sNews) >= 1.5 ? 'busier' : buzz(coin.sNews) <= 0.5 ? 'quieter' : 'about normal'} (usual ~${coin.sNews.perDay.toFixed(1)}/day)` : 'no recent mentions'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Headline tone <Info>A simple word count of positive words (surge, rally, approval…) vs negative ones (crash, hack, lawsuit…) in recent {name} headlines. Not yet used in the forecast numbers: it's logged daily so it can be tested against what happens next.</Info></div>
          <div className="stat-value">{coin.sNews.n ? <span className={`tag ${toneLabel(coin.sNews.tone).c}`}>{toneLabel(coin.sNews.tone).t}</span> : '–'}</div>
          <div className="stat-sub">{coin.sNews.n} headlines · Reddit: {coin.sSocial.n ? toneLabel(coin.sSocial.tone).t.toLowerCase() : 'n/a'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Trending <Info>CoinGecko's most-searched coins right now. Attention, not quality: trending coins are often the most volatile.</Info></div>
          <div className="stat-value small-v">{trending ? <span className="tag green">Trending now</span> : <span className="muted">Not trending</span>}</div>
          <div className="stat-sub">{data.trending.slice(0, 5).map(t => t.symbol).join(' · ')}</div>
        </div>
      </div>

      {zones.length > 0 && fng && (
        <>
          <h3 style={{ margin: '18px 0 8px' }}>When the mood was like this, {base} {hLabel} later…</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Mood</th><th>Days</th><th>Higher</th><th>Typical</th></tr></thead>
            <tbody>{zones.filter(z => z.n > 0).map(z => (
              <tr key={z.name} className={z === zoneNow ? 'hl' : ''}><td>{z.name}{z === zoneNow ? ' (now)' : ''}</td><td>{z.n}</td><td>{pct0(z.up)}</td><td className={z.median >= 0 ? 'pos' : 'neg'}>{pct(z.median)}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="hint">Every day since 2018 grouped by that day's mood. Days next to each other overlap, so the real sample is smaller than it looks.</p>
        </>
      )}

      <div className="seg" style={{ maxWidth: 320, margin: '16px 0 10px' }}>
        <button className={tab === 'news' ? 'on' : ''} onClick={() => setTab('news')}>News ({coin.news.length})</button>
        <button className={tab === 'social' ? 'on' : ''} onClick={() => setTab('social')}>Reddit ({coin.social.length})</button>
      </div>
      {!filtered && <p className="hint">Nothing mentioning {name} right now. Showing the latest overall.</p>}
      <div className="feed">
        {list.slice(0, 10).map(i => {
          const tl = toneLabel(i.tone)
          return (
            <a key={i.link} className="feed-item" href={i.link} target="_blank" rel="noreferrer noopener">
              <span className={`dot ${tl.c}`} title={`Tone: ${tl.t}`} />
              <span className="feed-body">
                <span className="feed-title">{i.title}</span>
                <span className="feed-meta">{i.source} · {ago(i.time)}{i.score != null ? ` · ${i.score.toLocaleString()} upvotes · ${i.comments ?? 0} comments` : ''}</span>
              </span>
            </a>
          )
        })}
        {list.length === 0 && <div className="empty small">{tab === 'social' ? 'Reddit isn’t answering our server right now.' : 'No headlines available right now.'}</div>}
      </div>
      <p className="hint">{okSources} sources live{failed.length ? ` · unavailable now: ${failed.join(', ')}` : ''} · updated {ago(Date.parse(data.updated))} · Fear &amp; Greed from alternative.me · Trending from CoinGecko. Headlines link to the original sites.</p>
    </section>
  )
}
