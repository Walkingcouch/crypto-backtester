// Unified signal format, de-duplication, weighting and "do-not-buy" gating for the Smart Money &
// Political Flow feed. Every connector returns raw items in this shape:
//
// { source, sourceUrl, category, entity_name, entity_role, asset_ticker, asset_name,
//   market: 'US' | 'ASX' | 'CRYPTO', action: 'BUY' | 'SELL' | 'MENTION' | 'ALERT',
//   trade_size_usd (midpoint of a disclosed range, or null), trade_date (ms, or null),
//   disclosed_at (ms), sentiment_score (-1..1, or null), conflict_score (0..1, or null),
//   text (short summary), timestamp (ms, when we first saw it) }
//
// Weighting follows the brief: the fresher the information when it becomes public, the more it
// counts for day trading; slow disclosures (STOCK Act filings can be 45 days late) are swing or
// momentum confirmations, not day-trade triggers. Repeats of the same fact from several sources
// raise confidence instead of creating duplicates.

const HOUR = 3_600_000, DAY = 86_400_000

/** How much one signal of each kind is worth before freshness, and how fast it goes stale. */
export const CATEGORY = {
  insider:     { label: 'Company insiders',      base: 0.55, dayHalfLife: 2 * DAY,  swingHalfLife: 30 * DAY },
  insider_au:  { label: 'Company directors (ASX)', base: 0.45, dayHalfLife: 2 * DAY,  swingHalfLife: 30 * DAY },
  politician_us: { label: 'US politicians',      base: 0.35, dayHalfLife: 3 * DAY,  swingHalfLife: 45 * DAY },
  politician_au: { label: 'AU politicians',      base: 0.30, dayHalfLife: 3 * DAY,  swingHalfLife: 60 * DAY },
  social:      { label: 'Social catalysts',      base: 0.30, dayHalfLife: 6 * HOUR, swingHalfLife: 3 * DAY },
  central_bank:{ label: 'Central banks',         base: 0.50, dayHalfLife: 12 * HOUR, swingHalfLife: 10 * DAY },
  derivatives: { label: 'Crypto derivatives',    base: 0.40, dayHalfLife: 8 * HOUR, swingHalfLife: 3 * DAY },
}

/** Same fact = same person, same asset, same direction, same trade day (or same post). */
export const dedupeKey = s => [s.category.split('_')[0], s.entity_name?.toLowerCase().replace(/[^a-z]/g, ''), s.market, s.asset_ticker, s.action,
  s.trade_date ? new Date(s.trade_date).toISOString().slice(0, 10) : s.post_id || new Date(s.disclosed_at).toISOString().slice(0, 13)].join('|')

/** Merge new raw items into the stored list: duplicates add their source instead of a new row. */
export function merge(stored, incoming, now) {
  const byKey = new Map(stored.map(s => [s.key, s]))
  let added = 0
  for (const raw of incoming) {
    const key = dedupeKey(raw)
    const have = byKey.get(key)
    if (have) {
      if (!have.sources.some(x => x.source === raw.source)) have.sources.push({ source: raw.source, url: raw.sourceUrl })
      continue
    }
    const s = { ...raw, key, timestamp: now, sources: [{ source: raw.source, url: raw.sourceUrl }] }
    delete s.source; delete s.sourceUrl
    byKey.set(key, s); added++
  }
  return { list: [...byKey.values()], added }
}

/**
 * Score every signal now:
 *  - lag: days from the trade to its public disclosure (STOCK Act filings are often 30–45 days late)
 *  - day weight: base × freshness since disclosure × penalty for disclosure lag (stale news is priced in)
 *  - swing weight: base × slower freshness (late filings still confirm a longer trend)
 *  - confidence: 1 − Π(1 − weight) over every independent source and every other insider/politician
 *    doing the same thing in the same asset within 10 days (cluster buying is the strongest evidence)
 *  - blocked: do-not-buy guard from the economic calendar and crypto derivatives
 */
export function score(list, now, ctx = {}) {
  const groups = new Map()
  for (const s of list) {
    const c = CATEGORY[s.category] || CATEGORY.social
    s.disclosure_delay_days = s.trade_date ? Math.max(0, Math.round((s.disclosed_at - s.trade_date) / DAY)) : 0
    const age = Math.max(0, now - s.disclosed_at)
    const lagPenalty = Math.exp(-s.disclosure_delay_days / 10)
    s.day_weight = +(c.base * Math.pow(0.5, age / c.dayHalfLife) * lagPenalty).toFixed(3)
    s.swing_weight = +(c.base * Math.pow(0.5, age / c.swingHalfLife)).toFixed(3)
    if ((s.action === 'BUY' || s.action === 'SELL') && s.asset_ticker) {
      const g = `${s.market}|${s.asset_ticker}|${s.action}`
      groups.set(g, [...(groups.get(g) || []), s])
    }
  }
  for (const s of list) {
    let miss = 1 - Math.min(0.95, s.swing_weight * (1 + 0.5 * (s.sources.length - 1)))
    const peers = (s.action === 'BUY' || s.action === 'SELL') && s.asset_ticker ? groups.get(`${s.market}|${s.asset_ticker}|${s.action}`) || [] : []
    const cluster = peers.filter(p => p !== s && p.entity_name !== s.entity_name && Math.abs((p.trade_date || p.disclosed_at) - (s.trade_date || s.disclosed_at)) <= 10 * DAY)
    for (const p of cluster) miss *= 1 - Math.min(0.9, p.swing_weight)
    s.cluster_size = cluster.length + 1
    s.confidence = +(1 - miss).toFixed(3)
    const badges = []
    if (s.sources.length > 1) badges.push(`${s.sources.length} sources`)
    if (cluster.length) badges.push(`${cluster.length + 1} ${s.category.startsWith('politician') ? 'politicians' : 'insiders'} ${s.action === 'BUY' ? 'buying' : 'selling'}`)
    if (s.action === 'BUY' && ctx.breakout?.[`${s.market}|${s.asset_ticker}`]) badges.push('+ technical breakout')
    if (s.category === 'social' && s.reach >= 500_000) badges.push('high-reach catalyst')
    if (s.category.startsWith('politician') && s.action === 'BUY' && ctx.breakout?.[`${s.market}|${s.asset_ticker}`]) badges.push('politician buy + breakout')
    s.badges = badges
    s.blocked = s.action === 'BUY' ? blockReason(s, now, ctx) : null
  }
  return list.sort((a, b) => b.disclosed_at - a.disclosed_at)
}

/** Do-not-buy: a high-impact release or central-bank decision for that market within 24 hours, or crowded crypto longs. */
function blockReason(s, now, ctx) {
  const ev = (ctx.events || []).find(e => e.market === (s.market === 'CRYPTO' ? 'US' : s.market) && e.impact === 'High' && e.t > now - 2 * HOUR && e.t < now + DAY)
  if (ev) return `${ev.title} in ${Math.max(0, Math.round((ev.t - now) / HOUR))} h`
  if (s.market === 'CRYPTO') {
    const d = ctx.derivatives?.[s.asset_ticker]
    if (d && d.funding > 0.0005) return `crowded longs (funding ${(d.funding * 100).toFixed(3)}% per 8 h)`
  }
  return null
}

/** Range text like "$1,001 - $15,000" → midpoint in USD. */
export function rangeMid(txt) {
  const n = (txt || '').replace(/,/g, '').match(/\$?(\d+(?:\.\d+)?)\s*-\s*\$?(\d+(?:\.\d+)?)/)
  if (n) return Math.round((+n[1] + +n[2]) / 2)
  const over = (txt || '').replace(/,/g, '').match(/over \$?(\d+)/i)
  return over ? +over[1] : null
}
