// Economic news for US and Australian shares: this week's data releases (with impact ratings and
// forecasts), the next Federal Reserve (FOMC) and Reserve Bank of Australia meetings, and the
// latest Fed and RBA announcements and Fed speeches (Powell's included).
//
// Sources (all public): the Forex Factory weekly calendar feed (nfs.faireconomy.media), the Fed's
// meeting calendar and RSS feeds (federalreserve.gov), the RBA's board schedule and media-release
// feed (rba.gov.au).

const HOUR = 3_600_000, DAY = 86_400_000
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

async function get(url, ms = 9000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*' }, signal: ctl.signal })
    if (!r.ok) throw new Error(`${r.status}`)
    return await r.text()
  } finally { clearTimeout(t) }
}

/** New York's UTC offset in hours on a date (US daylight saving: 2nd Sunday of March to 1st Sunday of November). */
export function nyOffset(y, m, d) {
  const nthSunday = (mon, n) => { const first = new Date(Date.UTC(y, mon, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (n - 1) }
  const start = Date.UTC(y, 2, nthSunday(2, 2)), end = Date.UTC(y, 10, nthSunday(10, 1)), t = Date.UTC(y, m, d)
  return t >= start && t < end ? -4 : -5
}
/** Sydney's UTC offset in hours (daylight saving: 1st Sunday of October to 1st Sunday of April). */
export function sydOffset(y, m, d) {
  const firstSunday = mon => { const first = new Date(Date.UTC(y, mon, 1)).getUTCDay(); return 1 + ((7 - first) % 7) }
  const t = Date.UTC(y, m, d)
  return t < Date.UTC(y, 3, firstSunday(3)) || t >= Date.UTC(y, 9, firstSunday(9)) ? 11 : 10
}

const decode = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '').trim()

/** This week's US and Australian releases (Medium and High impact, plus bank holidays). */
export async function weekCalendar() {
  const j = JSON.parse(await get('https://nfs.faireconomy.media/ff_calendar_thisweek.json'))
  return j
    .filter(e => (e.country === 'USD' || e.country === 'AUD') && ['High', 'Medium', 'Holiday'].includes(e.impact))
    .map(e => ({
      t: Date.parse(e.date), market: e.country === 'USD' ? 'US' : 'ASX', country: e.country === 'USD' ? 'US' : 'Australia',
      title: e.title, impact: e.impact, forecast: e.forecast || null, previous: e.previous || null,
      kind: /FOMC|Federal Funds|Fed Chair|Powell/i.test(e.title) ? 'fed' : /RBA|Cash Rate/i.test(e.title) ? 'rba' : 'data',
    }))
    .sort((a, b) => a.t - b.t)
}

/** Upcoming FOMC decisions (2:00pm New York on the meeting's last day; press conference 2:30pm). */
export async function fomcMeetings() {
  const html = await get('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', 12000)
  const out = []
  const parts = html.split(/(\d{4}) FOMC Meetings/)
  for (let p = 1; p < parts.length; p += 2) {
    const y = +parts[p], chunk = parts[p + 1] || ''
    const re = /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>\s*([^<]+)</g
    let m
    while ((m = re.exec(chunk))) {
      const monTxt = m[1].toLowerCase().split('/').pop().trim(), dates = m[2].trim()
      const mon = MONTHS.indexOf(monTxt)
      const last = +(dates.match(/(\d+)\D*$/) || [])[1]
      if (mon < 0 || !last) continue
      const lastMon = m[1].includes('/') ? MONTHS.indexOf(m[1].toLowerCase().split('/').pop().trim()) : mon
      const off = nyOffset(y, lastMon, last)
      const t = Date.UTC(y, lastMon, last, 14 - off, 0)
      out.push({ t, bank: 'Federal Reserve (FOMC)', title: `Interest-rate decision${dates.includes('*') ? ' + new economic projections' : ''}, then Chair's press conference 30 minutes later`, market: 'US' })
    }
  }
  const now = Date.now()
  const seen = new Set()
  return out.filter(e => e.t > now - DAY && !seen.has(e.t) && seen.add(e.t)).sort((a, b) => a.t - b.t).slice(0, 4)
}

/** Upcoming RBA decisions (2:30pm Sydney on the meeting's second day; press conference 3:30pm). */
export async function rbaMeetings() {
  const html = await get('https://www.rba.gov.au/schedules-events/board-meeting-schedules.html', 12000)
  const text = decode(html).replace(/\s+/g, ' ')
  const out = [], now = Date.now()
  const re = /(\d{1,2})\s*(?:[–-]|and)\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/gi
  let m
  while ((m = re.exec(text))) {
    const y = +m[4], mon = MONTHS.indexOf(m[3].toLowerCase()), d = +m[2]
    const off = sydOffset(y, mon, d)
    out.push({ t: Date.UTC(y, mon, d, 14 - off, 30), bank: 'Reserve Bank of Australia', title: "Cash-rate decision, then the Governor's press conference an hour later", market: 'ASX' })
  }
  const seen = new Set()
  return out.filter(e => e.t > now - DAY && !seen.has(e.t) && seen.add(e.t)).sort((a, b) => a.t - b.t).slice(0, 4)
}

function rssItems(xml, max) {
  const out = []
  for (const it of xml.split(/<item[\s>]/).slice(1)) {
    const title = (it.match(/<title>([\s\S]*?)<\/title>/) || [])[1]
    const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1]
    const date = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || it.match(/<dc:date>([\s\S]*?)<\/dc:date>/) || [])[1]
    if (title && link) out.push({ title: decode(title), link: decode(link), t: date ? Date.parse(decode(date)) : null })
    if (out.length >= max) break
  }
  return out
}

/** Latest announcements: Fed monetary-policy releases and speeches, RBA media releases. */
export async function latestNews() {
  const [fed, speech, rba] = await Promise.all([
    get('https://www.federalreserve.gov/feeds/press_monetary.xml').then(x => rssItems(x, 5)).catch(() => []),
    get('https://www.federalreserve.gov/feeds/speeches.xml').then(x => rssItems(x, 6)).catch(() => []),
    get('https://www.rba.gov.au/rss/rss-cb-media-releases.xml').then(x => rssItems(x, 5)).catch(() => []),
  ])
  return [
    ...fed.map(n => ({ ...n, source: 'Federal Reserve', market: 'US' })),
    ...speech.map(n => ({ ...n, source: 'Fed speech', market: 'US' })),
    ...rba.map(n => ({ ...n, source: 'Reserve Bank of Australia', market: 'ASX' })),
  ].sort((a, b) => (b.t || 0) - (a.t || 0))
}

/** Everything for the calendar page, each part optional if its source is down. */
export async function econAll() {
  const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, v: [], err: String(e.message || e) }))
  const [week, fomc, rba, news] = await Promise.all([settle(weekCalendar()), settle(fomcMeetings()), settle(rbaMeetings()), settle(latestNews())])
  return { at: Date.now(), week: week.v, fomc: fomc.v, rba: rba.v, news: news.v, errors: [week, fomc, rba, news].filter(x => !x.ok).map(x => x.err) }
}

/** High-impact events for a market within ±window of time t (the day-trading guard). */
export function nearEvent(events, market, t, windowMs = HOUR) {
  return (events || []).find(e => e.market === market && e.impact === 'High' && Math.abs(e.t - t) <= windowMs) || null
}
