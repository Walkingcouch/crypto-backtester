// Connectors for the Smart Money & Political Flow feed. Each returns raw signals in the format
// described in schema.js. All sources are official or free and were checked for automated-access
// terms (17 Nov 2026):
//  - US Senate eFD (efdsearch.senate.gov): Periodic Transaction Reports. Use is lawful except for
//    commercial purposes (5 U.S.C. app. § 105(c)); this is a personal, non-commercial research site.
//  - US House Clerk (disclosures-clerk.house.gov): yearly filing index + PTR PDFs (electronic only).
//  - SEC EDGAR Form 4 (sec.gov): insider open-market buys and sales. The SEC requires a contact email
//    in the User-Agent: read from the SEC_CONTACT setting; skipped until it's set.
//  - ASX announcements (asx.api.markitdigital.com): Appendix 3Y "Change of Director's Interest" notices.
//  - PoliticianTrades.au: Australian MPs' disclosed share trades (robots.txt allows; read once a day).
//  - Trump's Truth (trumpstruth.org/feed): archive RSS of Truth Social posts, offered for research.
//  - OKX public API: perpetual funding rates and open interest (Binance and Bybit block US servers).
//  - Federal Reserve and RBA: statements scored hawkish / dovish.
import { unzipSync, strFromU8 } from 'fflate'
import { rangeLoHi, rangeMid } from './schema.js'

const HOUR = 3_600_000, DAY = 86_400_000
const UA = 'Mozilla/5.0 (compatible; personal market research)'

async function get(url, { ms = 12000, headers = {}, binary = false } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*', ...headers }, signal: ctl.signal })
    if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`)
    return binary ? new Uint8Array(await r.arrayBuffer()) : await r.text()
  } finally { clearTimeout(t) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const decode = s => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&#8217;/g, "'").replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;|&#160;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const usDate = s => { const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : null }

// ------------------------------------------------------------------ US Senate (eFD)
/** A signed-in session (the site asks visitors to accept its terms of use before searching). */
export async function senateSession() {
  const base = 'https://efdsearch.senate.gov'
  const jar = {}
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
  const keep = r => { for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1) } }
  const req = async (path, init = {}) => {
    const r = await fetch(base + path, { ...init, redirect: 'manual', headers: { 'user-agent': UA, referer: base + '/search/home/', cookie: cookie(), ...(init.headers || {}) } })
    keep(r); return r
  }
  const home = await (await req('/search/home/')).text()
  const token = (home.match(/name="csrfmiddlewaretoken" value="([^"]+)"/) || [])[1]
  if (!token) throw new Error('senate: no form token')
  await req('/search/home/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `prohibition_agreement=1&csrfmiddlewaretoken=${token}` })
  const fmt = d => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()} 00:00:00`
  /** Electronic PTR filings since a date, optionally for one senator. */
  const search = async ({ since, first = '', last = '', max = 25 }) => {
    const body = new URLSearchParams({ start: '0', length: String(max), report_types: '[11]', filer_types: '[]', submitted_start_date: fmt(new Date(since)), submitted_end_date: '', candidate_state: '', senator_state: '', office_id: '', first_name: first, last_name: last, csrfmiddlewaretoken: jar.csrftoken || token })
    const data = await (await req('/search/report/data/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrftoken': jar.csrftoken || token }, body })).json()
    return (data.data || []).map(([f, l, , linkHtml, filed]) => ({ first: decode(f), last: decode(l), href: (linkHtml.match(/href="([^"]+)"/) || [])[1], filed: usDate(filed) }))
      .filter(r => r.href && r.href.includes('/ptr/'))         // paper (scanned) filings can't be read
  }
  /** Every stock / fund transaction in one filing. */
  const parse = async row => {
    const html = await (await req(row.href)).text()
    const name = `Sen. ${row.first} ${row.last}`
    const out = []
    for (const tr of html.split(/<tr[\s>]/).slice(2)) {
      const td = tr.split(/<td[^>]*>/).slice(1).map(x => decode(x.split('</td>')[0]))
      if (td.length < 8) continue
      const [, date, owner, ticker, asset, assetType, type, amount] = td
      if (!/Stock|Fund|ETF/i.test(assetType) || !ticker || ticker === '--') continue
      const action = /Purchase/i.test(type) ? 'BUY' : /Sale/i.test(type) ? 'SELL' : null
      if (!action) continue
      out.push({ source: 'US Senate eFD', sourceUrl: base + row.href, category: 'politician_us', entity_name: name, entity_role: `Senator (${owner || 'self'})`,
        asset_ticker: ticker.replace(/[^A-Z.]/g, ''), asset_name: asset, market: 'US', action, partial: /partial/i.test(type),
        trade_size_usd: rangeMid(amount), trade_size_range: rangeLoHi(amount), amount_text: amount, trade_date: usDate(date), disclosed_at: row.filed || Date.now(),
        sentiment_score: action === 'BUY' ? 1 : -1, conflict_score: null, text: `${name} ${action === 'BUY' ? 'bought' : /partial/i.test(type) ? 'partly sold' : 'sold'} ${asset} (${amount})` })
    }
    return out
  }
  return { search, parse }
}

export async function senatePTRs({ days = 30, max = 25 } = {}) {
  const S = await senateSession()
  const out = []
  for (const row of await S.search({ since: Date.now() - days * DAY, max })) { out.push(...await S.parse(row)); await sleep(300) }
  return out
}

// ------------------------------------------------------------------ US House (Clerk PTR PDFs)
/** The Clerk's yearly filing index: PTRs filed electronically (document IDs starting with 2). */
export async function houseIndex(years) {
  const rows = []
  for (const year of years) {
    const zip = unzipSync(await get(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`, { binary: true }))
    const txt = strFromU8(zip[`${year}FD.txt`] || Object.values(zip)[0])
    for (const c of txt.split(/\r?\n/).slice(1).map(l => l.split('\t'))) {
      if (c[4] !== 'P' || !/^2\d{7}$/.test(c[8] || '')) continue
      rows.push({ name: `Rep. ${c[2]} ${c[1]}`.replace(/\s+/g, ' ').trim(), last: c[1], first: c[2], district: c[5], filed: usDate(c[7]), doc: c[8], year })
    }
  }
  return rows
}

/** Every transaction in one electronic House PTR. */
export async function houseParse(r, pdfText) {
  const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${r.year}/${r.doc}.pdf`
  const text = await pdfText(await get(url, { binary: true }))
  // Layout: asset name on its own line(s), "(TICK) [ST]", then "P|S|S (partial)|E <trade date>
  // <notification date> $a - $b", then labelled lines ("Filing status: New", "Subholding of: …") that
  // belong to that trade. Section headings come out as letters followed by NUL characters.
  const clean = text.replace(/[A-Za-z]\u0000+/g, m => m[0]).replace(/\u0000/g, '')
  const re = /\(([A-Z][A-Z.]{0,6})\)\s*\[(ST|EF|OP)\]\s*(P|S \(partial\)|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\$[\d,]+\s*-\s*\$[\d,]+|Over \$[\d,]+)/g
  const out = []
  let m, prevEnd = clean.search(/\$200\?/) + 5
  while ((m = re.exec(clean))) {
    const before = clean.slice(Math.max(prevEnd, 0), m.index)
    prevEnd = m.index + m[0].length
    const name = before.split(/\n/).map(l => l.trim()).filter(l => l && !l.includes(':') && !/^(ID|Owner|Asset|Transaction|Type|Date|Notification|Amount|Cap\.|Gains|\$200\?|\*)/.test(l))
      .join(' ').replace(/^(SP|JT|DC)\s+/, '').replace(/\s+/g, ' ').trim() || m[1]
    const action = m[3].startsWith('P') ? 'BUY' : m[3].startsWith('S') ? 'SELL' : null
    if (!action) continue
    const amount = m[6].replace(/\s+/g, ' ')
    out.push({ source: 'US House Clerk', sourceUrl: url, category: 'politician_us', entity_name: r.name, entity_role: `Representative (${r.district})`,
      asset_ticker: m[1], asset_name: name, market: 'US', action, partial: m[3] === 'S (partial)',
      trade_size_usd: rangeMid(amount), trade_size_range: rangeLoHi(amount), amount_text: amount, trade_date: usDate(m[4]), disclosed_at: r.filed,
      sentiment_score: action === 'BUY' ? 1 : -1, conflict_score: null, text: `${r.name} ${action === 'BUY' ? 'bought' : m[3] === 'S (partial)' ? 'partly sold' : 'sold'} ${name} (${amount})` })
  }
  return out
}

export async function housePTRs({ days = 30, max = 12, pdfText } = {}) {
  const rows = (await houseIndex([new Date().getUTCFullYear()]))
    .filter(r => r.filed && r.filed > Date.now() - days * DAY).sort((a, b) => b.filed - a.filed).slice(0, max)
  const out = []
  for (const r of rows) {
    try { out.push(...await houseParse(r, pdfText)) } catch { /* skip unreadable filing */ }
    await sleep(250)
  }
  return out
}

// ------------------------------------------------------------------ SEC Form 4 (company insiders)
export async function secForm4({ contact, max = 40 } = {}) {
  if (!contact) return { skipped: 'SEC_CONTACT not set' }
  const headers = { 'user-agent': `crypto-backtester-au personal research ${contact}`, 'accept-encoding': 'gzip, deflate' }
  const atom = await get(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=${max}&output=atom`, { headers })
  const links = [...new Set([...atom.matchAll(/<link[^>]+href="([^"]+-index\.htm)"/g)].map(m => m[1]))].slice(0, max)
  const out = []
  for (const idx of links) {
    await sleep(150)                                       // SEC fair access: at most 10 requests a second
    let xmlUrl
    try {
      const page = await get(idx, { headers })
      const rel = (page.match(/href="([^"]+\.xml)"/) || [])[1]
      if (!rel) continue
      xmlUrl = new URL(rel.replace(/\/xslF345X\d+\//, '/'), 'https://www.sec.gov').toString()
    } catch { continue }
    await sleep(150)
    let x
    try { x = await get(xmlUrl, { headers }) } catch { continue }
    const tag = (s, t) => decode((s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1])
    const ticker = tag(x, 'issuerTradingSymbol').toUpperCase(), issuer = tag(x, 'issuerName'), owner = tag(x, 'rptOwnerName')
    const role = [tag(x, 'officerTitle'), /<isDirector>(1|true)/.test(x) ? 'Director' : '', /<isTenPercentOwner>(1|true)/.test(x) ? '10% owner' : ''].filter(Boolean).join(', ')
    const filed = Date.parse(tag(x, 'periodOfReport')) || Date.now()
    for (const t of x.split('<nonDerivativeTransaction>').slice(1)) {
      const code = tag(t, 'transactionCode')
      if (code !== 'P' && code !== 'S') continue          // open-market buys and sales only (not grants or option exercises)
      const shares = +tag(t, 'value') || +(t.match(/<transactionShares>\s*<value>([\d.]+)/) || [])[1] || 0
      const price = +(t.match(/<transactionPricePerShare>\s*<value>([\d.]+)/) || [])[1] || 0
      const date = Date.parse((t.match(/<transactionDate>\s*<value>([\d-]+)/) || [])[1]) || filed
      const action = code === 'P' ? 'BUY' : 'SELL'
      out.push({ source: 'SEC Form 4', sourceUrl: idx, category: 'insider', entity_name: owner, entity_role: role || 'Insider',
        asset_ticker: ticker, asset_name: issuer, market: 'US', action, trade_size_usd: shares && price ? Math.round(shares * price) : null, trade_date: date, disclosed_at: Date.now(),
        sentiment_score: action === 'BUY' ? 1 : -0.3, conflict_score: null, text: `${owner} (${role || 'insider'}) ${action === 'BUY' ? 'bought' : 'sold'} ${Math.round(shares).toLocaleString('en-US')} ${ticker} shares${price ? ` at $${price.toFixed(2)}` : ''}` })
    }
  }
  return out
}

// ------------------------------------------------------------------ ASX Appendix 3Y (director interests)
export async function asx3Y({ codes, days = 14 } = {}) {
  const out = []
  for (let i = 0; i < codes.length; i += 6) {
    const got = await Promise.all(codes.slice(i, i + 6).map(code => get(`https://asx.api.markitdigital.com/asx-research/1.0/companies/${code.toLowerCase()}/announcements`).then(t => [code, JSON.parse(t)]).catch(() => [code, null])))
    for (const [code, j] of got) {
      for (const a of j?.data?.items || []) {
        if (!/Director'?s Interest/i.test(a.headline)) continue
        const t = Date.parse(a.date)
        if (t < Date.now() - days * DAY) continue
        out.push({ source: 'ASX announcements', sourceUrl: `https://www.asx.com.au/markets/trade-our-cash-market/announcements.${code.toLowerCase()}`, category: 'insider_au',
          entity_name: `${j.data.displayName} director`, entity_role: 'Director', asset_ticker: code, asset_name: j.data.displayName, market: 'ASX', action: 'ALERT',
          trade_size_usd: null, trade_date: null, disclosed_at: t, sentiment_score: null, conflict_score: null, post_id: a.documentKey,
          text: `${j.data.displayName}: Change of Director's Interest Notice (Appendix 3Y). Open the notice to see whether it was a buy or a sale.` })
      }
    }
    await sleep(200)
  }
  return out
}

// ------------------------------------------------------------------ Australian MPs (PoliticianTrades.au)
export async function auPoliticians() {
  const html = await get('https://politiciantrades.au/')
  const text = decode(html)
  const out = []
  const re = /([A-Z][a-zA-Z'’-]+(?: [A-Z][a-zA-Z'’-]+){1,3}) (MP|Senator) ([A-Z]{2,5}) (.{3,120}?) ASX:([A-Z0-9]{3,5}) (Bought|Sold) (Self|Spouse|Family|Child|Partner)(?: ownership)? Reported date (\d{1,2} \w{3,9} \d{4})/g
  let m
  while ((m = re.exec(text))) {
    const t = Date.parse(m[8]) || Date.now()
    const action = m[6] === 'Bought' ? 'BUY' : 'SELL'
    const who = m[1].replace(/^(?:Source|Original filing|Record date)\s+/, '')
    out.push({ source: 'PoliticianTrades.au', sourceUrl: 'https://politiciantrades.au/', category: 'politician_au', entity_name: `${who} ${m[2]} (${m[3]})`, entity_role: `${m[2]} · ${m[7]}`,
      asset_ticker: m[5], asset_name: m[4].trim(), market: 'ASX', action, trade_size_usd: null, trade_date: null, disclosed_at: t,
      sentiment_score: action === 'BUY' ? 1 : -1, conflict_score: null, text: `${who} ${m[2]} (${m[3]}) ${action === 'BUY' ? 'bought' : 'sold'} ${m[4].trim()} (ASX:${m[5]}), ${m[7].toLowerCase()} holding` })
  }
  return out
}

// ------------------------------------------------------------------ Truth Social (Trump), via the Trump's Truth archive
const TOPICS = [
  [/tariff|trade deal|import tax|duties/i, 'tariffs', 'MARKET', 'US'],
  [/bitcoin|crypto|BTC|stablecoin|digital asset/i, 'crypto', 'BTC', 'CRYPTO'],
  [/\bfed\b|federal reserve|interest rate|rate cut|powell|warsh/i, 'the Fed and rates', 'MARKET', 'US'],
  [/oil|drill|energy|gas price|OPEC/i, 'energy', 'XLE', 'US'],
  [/\bdefen[cs]e (?:spending|contract|budget)|\bmilitary\b|\bmissiles?\b|\bpentagon\b|\bwar\b/i, 'defence', 'ITA', 'US'],
  [/china|beijing|xi jinping/i, 'China', 'MARKET', 'US'],
  [/australia|albanese/i, 'Australia', 'MARKET', 'ASX'],
]
const COMPANIES = { apple: 'AAPL', microsoft: 'MSFT', nvidia: 'NVDA', amazon: 'AMZN', google: 'GOOGL', meta: 'META', facebook: 'META', tesla: 'TSLA', intel: 'INTC', boeing: 'BA', 'general motors': 'GM', ford: 'F', walmart: 'WMT', 'jpmorgan': 'JPM', 'u.s. steel': 'X', exxon: 'XOM', chevron: 'CVX', lockheed: 'LMT', pfizer: 'PFE', disney: 'DIS', netflix: 'NFLX', 'harley': 'HOG', 'coinbase': 'COIN' }
const POS = /\b(great|tremendous|record|deal|agreement|win|winning|boom|historic|strong|incredible|lower (rates|prices)|cut rates|approved)\b/gi
const NEG = /\b(tariffs?|sanctions?|ban|terrible|war|attack|retaliat\w*|penalt\w*|investigat\w*|fraud|disaster|crash|weak|failing|threat)\b/gi
const URGENT = /\b(effective immediately|today|tonight|right now|immediately|announc\w*|executive order|signed)\b/i

export async function truthSocial({ limit = 40 } = {}) {
  const xml = await get(`https://www.trumpstruth.org/feed?limit=${limit}`)
  const out = []
  for (const it of xml.split('<item>').slice(1)) {
    const link = decode((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1])
    const body = decode((it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || (it.match(/<title>([\s\S]*?)<\/title>/) || [])[1])
    const t = Date.parse(decode((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1])) || Date.now()
    if (!body || body.length < 20) continue
    const tickers = [...new Set([...(body.match(/\$[A-Z]{1,5}\b/g) || []).map(x => x.slice(1)), ...Object.entries(COMPANIES).filter(([k]) => new RegExp(`\\b${k}\\b`, 'i').test(body)).map(([, v]) => v)])]
    const topics = TOPICS.filter(([re]) => re.test(body))
    if (!tickers.length && !topics.length) continue           // only market-relevant posts
    const pos = (body.match(POS) || []).length, neg = (body.match(NEG) || []).length
    const sentiment = pos + neg ? +((pos - neg) / (pos + neg)).toFixed(2) : 0
    const targets = tickers.length ? tickers.map(x => [x, x === 'BTC' ? 'CRYPTO' : 'US']) : topics.map(([, , tk, m]) => [tk, m])
    for (const [tk, mkt] of [...new Map(targets.map(x => [x.join('|'), x])).values()]) {
      out.push({ source: 'Truth Social (Trump)', sourceUrl: link, category: 'social', entity_name: 'Donald Trump', entity_role: 'US President · Truth Social', reach: 10_000_000,
        asset_ticker: tk, asset_name: tk === 'MARKET' ? 'Whole market' : tk, market: mkt, action: 'MENTION', trade_size_usd: null, trade_date: null, disclosed_at: t, post_id: link,
        sentiment_score: sentiment, urgent: URGENT.test(body), conflict_score: null, topics: topics.map(x => x[1]),
        text: body.length > 280 ? body.slice(0, 277) + '…' : body })
    }
  }
  return out
}

// ------------------------------------------------------------------ Crypto derivatives (OKX public data)
export async function cryptoDerivatives({ coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'], prevOI = {} } = {}) {
  const out = [], snapshot = {}
  for (const c of coins) {
    try {
      const [f, oi] = await Promise.all([
        get(`https://www.okx.com/api/v5/public/funding-rate?instId=${c}-USDT-SWAP`).then(JSON.parse),
        get(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${c}-USDT-SWAP`).then(JSON.parse),
      ])
      const funding = +f.data?.[0]?.fundingRate, oiUsd = +oi.data?.[0]?.oiUsd
      snapshot[c] = { funding, oiUsd, t: Date.now() }
      const prev = prevOI[c]
      const oiChange = prev?.oiUsd && Date.now() - prev.t < 30 * HOUR ? oiUsd / prev.oiUsd - 1 : null
      const notes = []
      if (funding > 0.0005) notes.push(`funding ${(funding * 100).toFixed(3)}% per 8 h: longs are crowded and paying heavily (do-not-buy; long squeeze risk)`)
      if (funding < -0.0003) notes.push(`funding ${(funding * 100).toFixed(3)}% per 8 h: shorts are crowded (short-squeeze potential)`)
      if (oiChange != null && Math.abs(oiChange) > 0.1) notes.push(`open interest ${oiChange > 0 ? 'up' : 'down'} ${(Math.abs(oiChange) * 100).toFixed(0)}% since the last check (${oiChange > 0 ? 'leverage building' : 'positions unwinding'})`)
      if (notes.length) out.push({ source: 'OKX derivatives', sourceUrl: `https://www.okx.com/trade-swap/${c.toLowerCase()}-usdt-swap`, category: 'derivatives', entity_name: 'Perpetual futures market', entity_role: 'OKX',
        asset_ticker: c, asset_name: c, market: 'CRYPTO', action: 'ALERT', trade_size_usd: oiUsd || null, trade_date: null, disclosed_at: Date.now(), post_id: `${c}-${new Date().toISOString().slice(0, 13)}`,
        sentiment_score: funding > 0.0005 ? -0.5 : funding < -0.0003 ? 0.5 : 0, conflict_score: null, text: `${c}: ${notes.join('; ')}.` })
    } catch { /* one coin failing doesn't stop the others */ }
  }
  return { signals: out, snapshot }
}

// ------------------------------------------------------------------ Central banks: hawkish / dovish
const HAWK = /\b(inflation (?:remains|is) (?:elevated|high|above)|upside risks? to inflation|further (?:tightening|increases)|raise[sd]? (?:the )?(?:target|cash rate|interest rate)|increase[sd]? (?:the )?(?:target|cash rate)|restrictive|firming|vigilant|persistent inflation|hike[sd]?)\b/gi
const DOVE = /\b(lower(?:ed|ing)? (?:the )?(?:target|cash rate|interest rate)|reduce[sd]? (?:the )?(?:target|cash rate)|cut|easing|ease|accommodative|downside risks|labou?r market (?:has )?(?:softened|cooled|weakened)|inflation (?:has )?(?:moderated|eased|declined)|unemployment (?:has )?(?:risen|moved up))\b/gi
export async function centralBanks({ seen = [] } = {}) {
  const items = []
  const fed = await get('https://www.federalreserve.gov/feeds/press_monetary.xml').catch(() => '')
  for (const it of fed.split('<item>').slice(1, 6)) {
    const title = decode((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1]), link = decode((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1])
    if (/FOMC statement/i.test(title)) items.push({ bank: 'Federal Reserve', market: 'US', title, link, t: Date.parse(decode((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1])) })
  }
  const rba = await get('https://www.rba.gov.au/rss/rss-cb-media-releases.xml').catch(() => '')
  for (const it of rba.split(/<item[\s>]/).slice(1, 10)) {
    const title = decode((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1]), link = decode((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1])
    if (/Monetary Policy Decision|Statement by the (?:Reserve Bank|Monetary Policy) Board/i.test(title)) items.push({ bank: 'Reserve Bank of Australia', market: 'ASX', title, link, t: Date.parse(decode((it.match(/<dc:date>([\s\S]*?)<\/dc:date>/) || [])[1])) })
  }
  const out = []
  for (const s of items.slice(0, 4)) {
    if (seen.includes(s.link)) continue
    const page = decode(await get(s.link).catch(() => ''))
    const h = (page.match(HAWK) || []).length, d = (page.match(DOVE) || []).length
    const tone = h + d ? (h - d) / (h + d) : 0
    out.push({ source: s.bank, sourceUrl: s.link, category: 'central_bank', entity_name: s.bank, entity_role: 'Central bank', asset_ticker: 'MARKET', asset_name: 'Whole market', market: s.market,
      action: 'ALERT', trade_size_usd: null, trade_date: null, disclosed_at: s.t || Date.now(), post_id: s.link, sentiment_score: +(-tone).toFixed(2), conflict_score: null, tone: +tone.toFixed(2),
      text: `${s.title}: ${tone > 0.2 ? 'hawkish' : tone < -0.2 ? 'dovish' : 'balanced'} tone (${h} hawkish vs ${d} dovish phrases).` })
  }
  return out
}

