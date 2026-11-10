// Shared by /api/chatter and the daily forecast job.
// Sources are official RSS feeds and free public APIs only (no page scraping):
//   news RSS, Reddit's public JSON/RSS, CoinGecko trending, alternative.me Fear & Greed.

export const NEWS_FEEDS = [
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { id: 'decrypt', name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { id: 'bitcoinmagazine', name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/' },
  { id: 'cryptoslate', name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/' },
  { id: 'theblock', name: 'The Block', url: 'https://www.theblock.co/rss.xml' },
]
export const SUBREDDITS = ['CryptoCurrency', 'Bitcoin', 'ethereum', 'solana', 'CryptoMarkets']

const UA = 'Mozilla/5.0 (compatible; crypto-backtester/1.0; personal dashboard)'

async function get(url, { json = false, ms = 7000 } = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*' }, signal: ctl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return json ? await r.json() : await r.text()
  } finally { clearTimeout(t) }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#8217': '’', '#8216': '‘', '#8220': '“', '#8221': '”', '#8211': '–', '#8212': '—', hellip: '…' }
function clean(s = '') {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? (e.startsWith('#') ? String.fromCharCode(parseInt(e.slice(1).replace(/^x/, '0x'))) : m))
    .replace(/\s+/g, ' ').trim()
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1] : '' }

export function parseFeed(xml) {
  const items = []
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []
  for (const b of blocks) {
    const title = clean(tag(b, 'title'))
    let link = clean(tag(b, 'link'))
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); if (m) link = m[1] }
    const date = clean(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'))
    const summary = clean(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 280)
    const t = Date.parse(date)
    if (title && link) items.push({ title, link, summary, time: Number.isFinite(t) ? t : null })
  }
  return items
}

// --- tone: a small crypto-news word list (transparent and checkable, not a black box)
const POS = ['surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'gain', 'gains', 'jump', 'jumps', 'bullish', 'record high', 'all-time high', 'ath', 'approve', 'approves', 'approved', 'approval', 'adoption', 'partnership', 'upgrade', 'breakout', 'rebound', 'rebounds', 'recover', 'recovers', 'recovery', 'inflow', 'inflows', 'accumulate', 'accumulation', 'boost', 'rise', 'rises', 'climb', 'climbs', 'outperform', 'strong', 'milestone', 'launches', 'wins', 'buy']
const NEG = ['crash', 'crashes', 'plunge', 'plunges', 'drop', 'drops', 'fall', 'falls', 'slump', 'slumps', 'bearish', 'hack', 'hacked', 'exploit', 'lawsuit', 'sue', 'sues', 'ban', 'bans', 'fraud', 'scam', 'liquidation', 'liquidations', 'outflow', 'outflows', 'sell-off', 'selloff', 'fear', 'warning', 'warns', 'probe', 'investigation', 'delist', 'delisting', 'collapse', 'loss', 'losses', 'dump', 'decline', 'declines', 'tumble', 'tumbles', 'sink', 'sinks', 'fine', 'fined', 'charges', 'charged', 'bankrupt', 'bankruptcy', 'weak', 'slides', 'slide', 'risk']
const words = (s) => ` ${s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')} `
export function tone(text) {
  const w = words(text)
  let p = 0, n = 0
  for (const k of POS) if (w.includes(` ${k} `)) p++
  for (const k of NEG) if (w.includes(` ${k} `)) n++
  return p === n ? 0 : (p - n) / (p + n)   // -1 … +1
}

export async function collect() {
  const out = { updated: new Date().toISOString(), news: [], social: [], trending: [], fng: null, sources: {} }

  const news = await Promise.all(NEWS_FEEDS.map(async f => {
    try { const items = parseFeed(await get(f.url)); out.sources[f.id] = { ok: true, n: items.length }; return items.map(i => ({ ...i, source: f.name })) }
    catch (e) { out.sources[f.id] = { ok: false, error: String(e.message || e) }; return [] }
  }))
  out.news = news.flat().map(i => ({ ...i, tone: tone(`${i.title} ${i.summary}`) }))

  // Reddit rate-limits bursts, so ask one community at a time with a short pause
  const social = []
  for (const sub of SUBREDDITS) { social.push(await redditSub(sub)); await new Promise(r => setTimeout(r, 400)) }
  async function redditSub(sub) {
    try {
      const j = await get(`https://www.reddit.com/r/${sub}/hot.json?limit=40&raw_json=1`, { json: true })
      const items = (j?.data?.children || []).map(c => c.data).filter(d => d && !d.stickied).map(d => ({
        title: d.title, link: `https://www.reddit.com${d.permalink}`, summary: (d.selftext || '').slice(0, 200),
        time: d.created_utc * 1000, score: d.score, comments: d.num_comments, source: `r/${sub}`,
      }))
      out.sources[`r/${sub}`] = { ok: true, n: items.length }
      return items
    } catch (e) {
      try { // fallback: the subreddit's RSS
        const items = parseFeed(await get(`https://www.reddit.com/r/${sub}/hot/.rss?limit=40`)).map(i => ({ ...i, source: `r/${sub}` }))
        out.sources[`r/${sub}`] = { ok: true, n: items.length, via: 'rss' }
        return items
      } catch (e2) { out.sources[`r/${sub}`] = { ok: false, error: String(e2.message || e2) }; return [] }
    }
  }
  out.social = social.flat().map(i => ({ ...i, tone: tone(`${i.title} ${i.summary}`) }))

  try {
    const j = await get('https://api.coingecko.com/api/v3/search/trending', { json: true })
    out.trending = (j?.coins || []).map(c => ({ symbol: String(c.item.symbol).toUpperCase(), name: c.item.name, rank: c.item.market_cap_rank }))
    out.sources.coingecko = { ok: true, n: out.trending.length }
  } catch (e) { out.sources.coingecko = { ok: false, error: String(e.message || e) } }

  try {
    const j = await get('https://api.alternative.me/fng/?limit=0&format=json', { json: true, ms: 9000 })
    const hist = (j?.data || []).map(d => [Number(d.timestamp) * 1000, Number(d.value)]).filter(([t, v]) => t > 0 && v >= 0).sort((a, b) => a[0] - b[0])
    const last = hist[hist.length - 1]
    out.fng = last ? { value: last[1], label: (j.data[0] || {}).value_classification, time: last[0], history: hist } : null
    out.sources.feargreed = { ok: !!last, n: hist.length }
  } catch (e) { out.sources.feargreed = { ok: false, error: String(e.message || e) } }

  return out
}

// --- matching a coin in text
const ALIASES = {
  BTC: ['bitcoin', 'btc'], ETH: ['ethereum', 'ether', 'eth'], SOL: ['solana', 'sol'], XRP: ['xrp', 'ripple'],
  ADA: ['cardano', 'ada'], DOGE: ['dogecoin', 'doge'], LINK: ['chainlink'], AVAX: ['avalanche', 'avax'],
  DOT: ['polkadot'], LTC: ['litecoin', 'ltc'], BNB: ['bnb', 'binance coin'], TRX: ['tron', 'trx'], TON: ['toncoin'],
  SHIB: ['shiba inu', 'shib'], PEPE: ['pepe'], SUI: ['sui'], NEAR: ['near protocol'], XLM: ['stellar', 'xlm'],
}
export function mentions(text, base, name) {
  const w = words(text)
  const terms = new Set([...(ALIASES[base] || []), ...(base.length >= 3 ? [base.toLowerCase()] : []), ...(name && name.length >= 4 ? [name.toLowerCase()] : [])])
  for (const k of terms) if (w.includes(` ${k} `)) return true
  return false
}
