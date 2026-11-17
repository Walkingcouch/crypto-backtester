export default async function handler(req, res) {
  const out = {}
  const tryGet = async (k, url) => {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*' } })
      const t = await r.text()
      out[k] = { status: r.status, len: t.length, head: t.slice(0, 700) }
    } catch (e) { out[k] = { error: String(e) } }
  }
  await Promise.all([
    tryGet('ff', 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'),
    tryGet('fed', 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'),
    tryGet('rba', 'https://www.rba.gov.au/schedules-events/board-meeting-schedules.html'),
    tryGet('fedrss', 'https://www.federalreserve.gov/feeds/press_monetary.xml'),
    tryGet('rbarss', 'https://www.rba.gov.au/rss/rss-cb-media-releases.xml'),
  ])
  res.json(out)
}
