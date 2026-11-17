export default async function handler(req, res) {
  const r = await fetch('https://www.rba.gov.au/schedules-events/board-meeting-schedules.html', { headers: { 'user-agent': 'Mozilla/5.0' } })
  const html = await r.text()
  const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ')
  const i = text.search(/2026|2027/)
  res.json({ len: text.length, around: text.slice(Math.max(0, i - 300), i + 2500) })
}
