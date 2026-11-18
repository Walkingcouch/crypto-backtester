// Daily brief: one look at every lab. Health (did each lab run on time?), money (each paper
// account today and since start), trades in the last 24 hours, what's being tested, whether any
// rule has passed every professional check, today's big economic releases, and anything that
// needs a decision.
import { sb } from './_lib/forecaster.js'
import { weekCalendar } from './_lib/econ.js'

const HOUR = 3_600_000, DAY = 86_400_000
const LABS = [
  { id: 'main', name: 'Crypto swing', path: '/lab', every: 2 * HOUR },
  { id: 'explorer', name: 'Crypto Explorer', path: '/lab/explore', every: 2 * HOUR },
  { id: 'daytrade', name: 'Crypto day', path: '/lab/daytrade', every: HOUR },
  { id: 'stocks', name: 'Shares swing', path: '/shares', every: 12 * HOUR, weekdays: true },
  { id: 'stocks-explore', name: 'Shares Explorer', path: '/shares/explore', every: 12 * HOUR, weekdays: true },
  { id: 'stocks-day', name: 'Shares day', path: '/shares/daytrade', every: 30 * 60_000, sessions: true },
  { id: 'signals', name: 'Smart money feed', path: '/markets?view=flow', every: 30 * 60_000 },
]

// Is a market session open now? (US 9:30–16:00 New York, ASX 10:00–16:00 Sydney, weekdays)
function inSession(now) {
  const part = (tz) => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now))
    const g = k => f.find(p => p.type === k)?.value
    return { wd: g('weekday'), m: +g('hour') * 60 + +g('minute') }
  }
  const us = part('America/New_York'), au = part('Australia/Sydney')
  const wk = d => !['Sat', 'Sun'].includes(d)
  return (wk(us.wd) && us.m >= 570 && us.m < 960) || (wk(au.wd) && au.m >= 600 && au.m < 960)
}

function lateBy(lab, updated, now) {
  const age = now - updated
  if (lab.sessions) return inSession(now) && age > 3 * lab.every ? age : 0
  const grace = lab.weekdays ? 3 * DAY + lab.every : 2 * lab.every + 15 * 60_000
  return age > grace ? age : 0
}

export default async function handler(req, res) {
  const now = Date.now()
  try {
    const [rows, events] = await Promise.all([
      sb('/rest/v1/lab_state?select=id,updated_at,data&order=id').then(r => r.json()),
      weekCalendar().catch(() => []),
    ])
    const byId = Object.fromEntries((rows || []).map(r => [r.id, r]))
    const labs = [], alerts = [], decisions = []
    for (const L of LABS) {
      const row = byId[L.id]
      if (!row) { alerts.push(`${L.name} has no saved record.`); continue }
      const updated = Date.parse(row.updated_at)
      const late = lateBy(L, updated, now)
      if (late) alerts.push(`${L.name} hasn't run for ${Math.round(late / HOUR)} hours.`)
      if (L.id === 'signals') {
        const d = row.data || {}
        const off = Object.entries(d.status || {}).filter(([, s]) => s && s.ok === false).map(([k]) => k)
        labs.push({ id: L.id, name: L.name, path: L.path, updated, late: !!late, signals: (d.list || d.signals || []).length, sourcesDown: off })
        continue
      }
      const S = row.data || {}
      const accts = Object.values(S.accounts || {}).map(a => {
        const ago = (S.history || []).filter(h => h.t <= now - DAY).pop()
        const value = a.valueAud ?? a.startAud
        const recent = (a.closed || []).filter(c => (c.exitT || 0) >= now - DAY)
        return {
          name: a.exchange, value: +value.toFixed(2), start: a.startAud,
          sinceStart: value / a.startAud - 1, today: ago && ago[a.id] ? value / ago[a.id] - 1 : null,
          open: (a.positions || []).length, trades24h: recent.length,
          net24h: recent.reduce((s, c) => s + (c.net || 0), 0),
          closed: a.stats?.n || 0, winRate: a.stats?.n ? a.stats.wins / a.stats.n : null,
          recent: recent.slice(-5).map(c => ({ base: c.base, net: c.net, r: c.rMult ?? null, rule: c.v, at: c.exitT })),
        }
      })
      const active = (S.rules || []).filter(r => r.status !== 'retired')
      const proven = active.filter(r => !r.practice && r.rigor?.passedAll)
      const passing = (S.found || []).filter(f => f.rigor?.passedAll).length
      const best = (S.found || []).filter(f => f.rigor).sort((a, b) => (b.rigor.dsr - a.rigor.dsr) || (b.rigor.sharpe - a.rigor.sharpe))[0]
      if (proven.length) decisions.push(`${L.name}: rule v${proven[0].v} has passed every check. Keep paper trading it for at least 30 trades and 3 months before thinking about real money.`)
      labs.push({
        id: L.id, name: L.name, path: L.path, updated, late: !!late, accounts: accts,
        mode: active.some(r => r.practice) ? 'learning' : !active.length ? 'cash' : proven.length ? 'proven rules' : 'trading rules that have not passed the new checks',
        active: active.map(r => ({ v: r.v, text: r.text, status: r.status, explorer: !!r.explorer, checks: r.rigor ? Object.values(r.rigor.checks).filter(Boolean).length : null })),
        tested: (S.found || []).length, passingAll: passing, trials: S.trials || S.explore?.tried || null,
        best: best ? { text: best.text, checks: Object.values(best.rigor.checks).filter(Boolean).length, sharpe: best.rigor.sharpe, dsr: best.rigor.dsr } : null,
      })
    }
    const today = events.filter(e => e.impact === 'High' && e.t >= now - 2 * HOUR && e.t <= now + DAY).sort((a, b) => a.t - b.t)
      .map(e => ({ t: e.t, market: e.market, title: e.title, forecast: e.forecast ?? null, previous: e.previous ?? null }))
    if (!process.env.SEC_CONTACT) decisions.push('Insider filings (SEC Form 4) are switched off until SEC_CONTACT is added in Vercel.')
    res.setHeader('cache-control', 'public, s-maxage=120, stale-while-revalidate=600')
    res.status(200).json({ at: now, labs, alerts, decisions, events: today })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
