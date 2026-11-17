// temporary: read terms pages and test endpoints from the server
const strip = h => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ')
export default async function handler(req, res) {
  const out = {}
  const t = async (k, url, n = 1500, find) => {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*' } })
      const raw = await r.text(), txt = /json/.test(r.headers.get('content-type') || '') ? raw : strip(raw)
      const i = find ? Math.max(0, txt.search(find)) : 0
      out[k] = { status: r.status, text: txt.slice(i, i + n) }
    } catch (e) { out[k] = { error: String(e).slice(0, 200) } }
  }
  await Promise.all([
    t('ptRobots', 'https://politiciantrades.au/robots.txt', 600),
    t('ptTerms', 'https://politiciantrades.au/terms', 2500),
    t('ptHome', 'https://politiciantrades.au/', 2500, /trade|Trade/),
    t('ttRobots', 'https://www.trumpstruth.org/robots.txt', 600),
    t('ttAbout', 'https://www.trumpstruth.org/about', 2000),
    t('efdHome', 'https://efdsearch.senate.gov/search/home/', 2500, /agree|Prohibit|prohibit/),
    t('asxCo', 'https://asx.api.markitdigital.com/asx-research/1.0/companies/bhp/announcements', 1500),
    t('asxCo2', 'https://www.asx.com.au/asx/1/company/BHP/announcements?count=20&market_sensitive=false', 1500),
    t('openPol', 'https://openpolitics.com.au/', 1500, /trade|share/i),
  ])
  res.json(out)
}
