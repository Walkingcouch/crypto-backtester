// Smart money backtest: rates each stream of smart-money data on what prices actually did AFTER
// its signals became public (the only moment we could have acted).
//
// For every signal: buy (or avoid / short, for a sell) at the next day's open after it was
// published, hold 1, 5, 20 or 60 trading days, and measure the return beyond the market index
// (S&P 500 for US, ASX 200 for ASX, Bitcoin for crypto; a whole-market signal is measured on the
// index itself), in the signal's direction, after a round-trip trading cost.
//
// Each stream and holding period then faces four checks:
//   1. Makes money after costs (average result > 0)
//   2. Statistically solid: t-score of at least the bar for the number of tests run, with events
//      on the same day counted as one (many politicians filing the same day aren't independent)
//   3. Beats random dates: better than 95% of 200 runs using the same assets on random days
//   4. Consistent: positive in both the older and the newer half of the events
// Grade = checks passed at the best holding period: A (4) … F (0). Fewer than 30 events, or
// fewer than 15 different days, is "not enough data yet".

const DAY = 86_400_000
export const HORIZONS = [1, 5, 20, 60]
export const COST = { US: 0.002, ASX: 0.005, CRYPTO: 0.003 }
export const MIN_EVENTS = 30, MIN_DATES = 15

/** The streams: which signals belong, which way each one points, and how it's described. */
export const STREAMS = [
  { id: 'pol-us-buy', name: 'US politicians · buys', cat: 'politician_us', pick: s => s.action === 'BUY', dir: () => 1 },
  { id: 'pol-us-sell', name: 'US politicians · sells', cat: 'politician_us', pick: s => s.action === 'SELL', dir: () => -1 },
  { id: 'pol-us-cluster', name: 'US politicians · 2+ buying the same share within 10 days', cat: 'politician_us', pick: s => s.action === 'BUY' && s.cluster >= 2, dir: () => 1 },
  { id: 'pol-us-large', name: 'US politicians · buys of $50k or more', cat: 'politician_us', pick: s => s.action === 'BUY' && (s.size || 0) >= 50_000, dir: () => 1 },
  { id: 'pol-au-buy', name: 'Australian politicians · buys', cat: 'politician_au', pick: s => s.action === 'BUY', dir: () => 1 },
  { id: 'pol-au-sell', name: 'Australian politicians · sells', cat: 'politician_au', pick: s => s.action === 'SELL', dir: () => -1 },
  { id: 'insider-buy', name: 'US company insiders · buys', cat: 'insider', pick: s => s.action === 'BUY', dir: () => 1 },
  { id: 'insider-sell', name: 'US company insiders · sells', cat: 'insider', pick: s => s.action === 'SELL', dir: () => -1 },
  { id: 'asx-directors', name: 'ASX director notices (direction not read yet: tested as a buy)', cat: 'insider_au', pick: () => true, dir: () => 1 },
  { id: 'truth', name: 'Truth Social posts (positive = buy, negative = sell)', cat: 'social', pick: s => (s.sent || 0) !== 0, dir: s => Math.sign(s.sent) },
  { id: 'cb-tone', name: 'Fed and RBA statements (dovish = buy, hawkish = sell)', cat: 'central_bank', pick: s => (s.sent || 0) !== 0, dir: s => Math.sign(s.sent) },
  { id: 'crypto-funding', name: 'Crypto futures crowding (crowded longs = sell, crowded shorts = buy)', cat: 'derivatives', pick: s => (s.sent || 0) !== 0, dir: s => Math.sign(s.sent) },
]

const BENCH = { US: 'SPY', ASX: 'STW.AX', CRYPTO: 'BTC' }
export const priceKey = (market, ticker) => {
  if (ticker === 'MARKET') return `${market}|${BENCH[market]}`
  if (market === 'ASX') return `ASX|${ticker.endsWith('.AX') ? ticker : ticker + '.AX'}`
  return `${market}|${ticker}`
}
export const benchKey = market => `${market}|${BENCH[market]}`

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 } }
const mean = x => x.reduce((a, b) => a + b, 0) / (x.length || 1)
function tStat(x) {
  const n = x.length
  if (n < 2) return 0
  const m = mean(x), sd = Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1))
  return sd > 0 ? m / (sd / Math.sqrt(n)) : 0
}
/** First bar strictly after day `t` (signals published during a day are acted on next open). */
function nextBar(P, t) {
  const d = Math.floor(t / DAY) * DAY
  let lo = 0, hi = P.t.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (P.t[m] <= d) lo = m + 1; else hi = m }
  return lo < P.t.length ? lo : -1
}
/** Return from the open of bar i to the close h bars later (bar i counts as day 1). */
const legReturn = (P, i, h) => (i >= 0 && i + h - 1 < P.t.length && P.o[i] > 0 ? P.c[i + h - 1] / P.o[i] - 1 : NaN)
/** Same calendar window on the benchmark. */
function benchReturn(B, P, i, h) {
  if (!B || B === P) return 0
  const a = nextBar(B, P.t[i] - DAY), b = nextBar(B, P.t[i + h - 1] - DAY)
  if (a < 0 || b < 0 || B.o[a] <= 0) return NaN
  return B.c[b] / B.o[a] - 1
}

/**
 * Rate every stream. events: [{ cat, action, ticker, market, t (published), tradeT?, size?, cluster?, sent? }]
 * prices: { 'US|AAPL': { t:[day ms], o:[], c:[] }, … } (daily, oldest first)
 */
export function rateStreams(events, prices, { now = Date.now(), sims = 200 } = {}) {
  const tests = STREAMS.length * HORIZONS.length
  const bar = Math.max(2, Math.sqrt(2 * Math.log(tests)))
  const out = []
  for (const S of STREAMS) {
    const evs = events.filter(e => e.cat === S.cat && S.pick(e))
    const rows = { stream: S.id, name: S.name, signals: evs.length, horizons: {} }
    for (const h of HORIZONS) {
      const legs = []
      let missing = 0, lagSum = 0, lagN = 0
      for (const e of evs) {
        const P = prices[priceKey(e.market, e.ticker)], B = e.ticker === 'MARKET' ? null : prices[benchKey(e.market)]
        if (!P) { missing++; if ((rows.missingKeys ||= []).length < 8 && !rows.missingKeys.includes(priceKey(e.market, e.ticker))) rows.missingKeys.push(priceKey(e.market, e.ticker)); continue }
        const i = nextBar(P, e.t)
        const r = legReturn(P, i, h), rb = P === B ? 0 : benchReturn(B, P, i, h)
        if (!Number.isFinite(r) || !Number.isFinite(rb)) continue
        const d = S.dir(e)
        const cost = COST[e.market] ?? 0.003
        legs.push({ day: P.t[i], g: d * (r - rb) - cost, P, B, h, d, cost })
        // what the same trade would have made on the actual trade date (shows what the delay costs)
        if (e.tradeT && e.tradeT < e.t - DAY) {
          const j = nextBar(P, e.tradeT), r0 = legReturn(P, j, h), rb0 = P === B ? 0 : benchReturn(B, P, j, h)
          if (Number.isFinite(r0) && Number.isFinite(rb0)) { lagSum += d * (r0 - rb0) - cost; lagN++ }
        }
      }
      const byDay = new Map()
      for (const l of legs) byDay.set(l.day, [...(byDay.get(l.day) || []), l.g])
      const daily = [...byDay.values()].map(mean)
      const n = legs.length, dates = byDay.size
      const avg = mean(legs.map(l => l.g)), t = tStat(daily)
      const sorted = legs.slice().sort((a, b) => a.day - b.day)
      const half = Math.floor(n / 2)
      const older = mean(sorted.slice(0, half).map(l => l.g)), newer = mean(sorted.slice(half).map(l => l.g))
      // random dates: same assets, same direction and holding period, random entry days
      let beat = 0
      if (n >= 10) {
        const rnd = rng(n * 7919 + h)
        for (let k = 0; k < sims; k++) {
          let sum = 0, cnt = 0
          for (const l of legs) {
            const span = l.P.t.length - l.h
            if (span < 2) continue
            const i = Math.floor(rnd() * span)
            const r = legReturn(l.P, i, l.h), rb = l.P === l.B ? 0 : benchReturn(l.B, l.P, i, l.h)
            if (!Number.isFinite(r) || !Number.isFinite(rb)) continue
            sum += l.d * (r - rb) - l.cost; cnt++
          }
          if (cnt && sum / cnt >= avg) beat++
        }
      }
      const randomP = n >= 10 ? beat / sims : 1
      const enough = n >= MIN_EVENTS && dates >= MIN_DATES
      const checks = { profit: avg > 0, solid: t >= bar, random: randomP <= 0.05, consistent: older > 0 && newer > 0 }
      rows.horizons[h] = {
        n, dates, missingPrices: missing, avg: +avg.toFixed(5), t: +t.toFixed(2), win: n ? +(legs.filter(l => l.g > 0).length / n).toFixed(3) : 0,
        randomP: +randomP.toFixed(3), older: +older.toFixed(5), newer: +newer.toFixed(5), enough, checks,
        score: enough ? Object.values(checks).filter(Boolean).length : null,
        ifTradeDate: lagN >= 10 ? +(lagSum / lagN).toFixed(5) : null,
      }
    }
    const scored = HORIZONS.map(h => [h, rows.horizons[h]]).filter(([, r]) => r.score != null)
    const best = scored.sort((a, b) => (b[1].score - a[1].score) || (b[1].t - a[1].t))[0]
    rows.best = best ? +best[0] : null
    rows.score = best ? best[1].score : null
    rows.grade = rows.score == null ? null : 'FDCBA'[rows.score]
    rows.verdict = rows.score == null ? (evs.length ? `Not enough data yet (${Math.max(...HORIZONS.map(h => rows.horizons[h].n))} usable signals; needs ${MIN_EVENTS} on ${MIN_DATES}+ days)` : 'No signals yet')
      : rows.score === 4 ? 'Strong: worth testing as a filter in the labs'
      : rows.score === 3 ? 'Promising: keep collecting, re-test as data grows'
      : rows.score === 2 ? 'Weak: mostly noise so far'
      : 'No edge: ignore for trading'
    out.push(rows)
  }
  return { at: now, bar: +bar.toFixed(2), tests, streams: out }
}

/** Turn stored signals, the politician ledger and the archive into backtest events. */
export function buildEvents({ signals = [], ledger = { trades: [] }, archive = [] }) {
  const DAYS10 = 10 * DAY
  const norm = s => (s || '').toLowerCase().replace(/^(sen|rep)\.\s*/, '').replace(/[^a-z]/g, '')
  // median delay from trade to public filing, for ledger rows that never stored their filing date
  const lags = signals.filter(s => s.category === 'politician_us' && s.trade_date && s.disclosed_at).map(s => s.disclosed_at - s.trade_date).sort((a, b) => a - b)
  const lag = lags.length ? lags[Math.floor(lags.length / 2)] : 30 * DAY
  const disc = new Map(signals.filter(s => s.category === 'politician_us' && s.trade_date).map(s => [`${norm(s.entity_name)}|${s.asset_ticker}|${s.action}|${s.trade_date}`, s.disclosed_at]))
  const ev = new Map()
  const add = e => { if (e.ticker && e.t > 0) ev.set(`${e.cat}|${e.who}|${e.ticker}|${e.action}|${Math.floor((e.tradeT || e.t) / DAY)}|${e.post || ''}`, e) }
  for (const t of ledger.trades || []) {
    if (t.action !== 'BUY' && t.action !== 'SELL') continue
    const d = t.disclosed_at || disc.get(`${norm(t.entity_name)}|${t.asset_ticker}|${t.action}|${t.trade_date}`)
    add({ cat: 'politician_us', who: norm(t.entity_name), action: t.action, ticker: t.asset_ticker, market: 'US', tradeT: t.trade_date, t: d || t.trade_date + lag, lagEstimated: !d, size: t.trade_size_usd })
  }
  for (const s of [...archive, ...signals]) {
    if (!s.asset_ticker) continue
    add({ cat: s.category, who: norm(s.entity_name), action: s.action, ticker: s.asset_ticker, market: s.market, tradeT: s.trade_date || null, t: s.disclosed_at, size: s.trade_size_usd, sent: s.sentiment_score, post: s.post_id || '' })
  }
  const list = [...ev.values()]
  // cluster: other politicians buying the same share within 10 days of the trade
  const buys = list.filter(e => e.cat === 'politician_us' && e.action === 'BUY')
  const byTk = new Map()
  for (const b of buys) byTk.set(b.ticker, [...(byTk.get(b.ticker) || []), b])
  for (const b of buys) b.cluster = new Set(byTk.get(b.ticker).filter(o => Math.abs((o.tradeT || o.t) - (b.tradeT || b.t)) <= DAYS10).map(o => o.who)).size
  return { events: list, lagDays: Math.round(lag / DAY) }
}

/** Compact copy of a signal for the permanent archive (so streams build history past 90 days). */
export const archiveRow = s => ({ category: s.category, entity_name: s.entity_name, asset_ticker: s.asset_ticker, market: s.market, action: s.action,
  trade_date: s.trade_date || null, disclosed_at: s.disclosed_at, trade_size_usd: s.trade_size_usd || null, sentiment_score: s.sentiment_score ?? null, post_id: s.post_id || null })
