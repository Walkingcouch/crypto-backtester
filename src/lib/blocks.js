// Building blocks for strategies the Explorer invents. A "combo" rule is 1–3 conditions
// that must all be true at a day's close, plus how long to hold and how wide the stop is.
// Every block uses only data up to and including day i (no lookahead).

export const BLOCKS = {
  breakout: { params: { n: [10, 20, 55, 100] }, kind: 'coin' },
  aboveSma: { params: { n: [20, 50, 100, 200] }, kind: 'coin' },
  belowSma: { params: { n: [20, 50, 100, 200] }, kind: 'coin' },
  mom: { params: { n: [5, 10, 20, 60], k: [0.5, 1, 2] }, kind: 'coin' },
  dip: { params: { n: [3, 5, 10, 20], k: [1, 1.5, 2.5] }, kind: 'coin' },
  volSpike: { params: { k: [1.5, 2, 3] }, kind: 'coin' },
  quiet: { params: {}, kind: 'regime' },
  loud: { params: {}, kind: 'regime' },
  btcUp: { params: { n: [50, 100, 200] }, kind: 'market' },
  btcDown: { params: { n: [50, 100, 200] }, kind: 'market' },
}
export const HOLDS = [3, 5, 10, 20]
export const STOPS = [1.5, 2.5, 3.5]

const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)]

export function randomCond(rnd) {
  const p = pick(Object.keys(BLOCKS), rnd)
  const c = { p }
  for (const [k, vals] of Object.entries(BLOCKS[p].params)) c[k] = pick(vals, rnd)
  return c
}

/** Canonical id so the same idea is never tested twice. */
export function comboId(spec) {
  const conds = spec.conds.map(c => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(',')).sort()
  return `combo:${conds.join('&')}:H${spec.H}:S${spec.stopM}`
}

/** Conditions that contradict each other or repeat a block make no sense together. */
export function validCombo(spec) {
  const ps = spec.conds.map(c => c.p)
  if (new Set(ps).size !== ps.length) return false
  const has = p => ps.includes(p)
  if (has('quiet') && has('loud')) return false
  if (has('btcUp') && has('btcDown')) return false
  if (has('aboveSma') && has('belowSma')) {
    const a = spec.conds.find(c => c.p === 'aboveSma').n, b = spec.conds.find(c => c.p === 'belowSma').n
    if (a === b) return false
  }
  if (has('mom') && has('dip')) return false
  return spec.conds.length >= 1 && spec.conds.length <= 3
}

const ADJ = k => (k <= 0.5 ? 'a little' : k <= 1.5 ? 'sharply' : k <= 2 ? 'strongly' : 'very sharply')
function condText(c) {
  switch (c.p) {
    case 'breakout': return `closes at a new ${c.n}-day high`
    case 'aboveSma': return `is above its ${c.n}-day average`
    case 'belowSma': return `is below its ${c.n}-day average`
    case 'mom': return `has risen ${ADJ(c.k)} over ${c.n} days`
    case 'dip': return `has fallen ${ADJ(c.k)} over ${c.n} days`
    case 'volSpike': return `trades ${c.k}× its usual daily volume`
    case 'quiet': return 'after a quiet fortnight'
    case 'loud': return 'after a wild fortnight'
    case 'btcUp': return `while Bitcoin is above its ${c.n}-day average`
    case 'btcDown': return `while Bitcoin is below its ${c.n}-day average`
    default: return c.p
  }
}
export function describeCombo(spec) {
  const coin = spec.conds.filter(c => BLOCKS[c.p]?.kind === 'coin').map(condText)
  const ctx = spec.conds.filter(c => BLOCKS[c.p]?.kind !== 'coin').map(condText)
  const head = coin.length ? `Buy when a coin ${coin.join(' and ')}` : 'Buy any of the top coins'
  return `${head}${ctx.length ? ' ' + ctx.join(' ') : ''}. Hold up to ${spec.H} days; stop about ${spec.stopM}× its usual move.`
}

// ---------- lazily cached per-coin series ----------
function series(coin, key, make) {
  coin.cache ||= {}
  return coin.cache[key] || (coin.cache[key] = make())
}
const sma = (coin, n) => series(coin, `sma${n}`, () => {
  const c = coin.c, out = new Float64Array(c.length).fill(NaN)
  let s = 0
  for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= n) s -= c[i - n]; if (i >= n - 1) out[i] = s / n }
  return out
})
const hiPrev = (coin, n) => series(coin, `hi${n}`, () => {
  const c = coin.c, out = new Float64Array(c.length).fill(NaN)
  for (let i = n; i < c.length; i++) { let m = -Infinity; for (let k = i - n; k < i; k++) if (c[k] > m) m = c[k]; out[i] = m }
  return out
})
const volAvg = coin => series(coin, 'vavg20', () => {
  const v = coin.v || [], out = new Float64Array(coin.c.length).fill(NaN)
  let s = 0
  for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= 20) s -= v[i - 20]; if (i >= 20) out[i] = (s - v[i]) / 19 }
  return out
})

/** The market leader each asset is judged against: Bitcoin for crypto, the index fund for shares. */
export const LEADERS = { '': 'BTC', US: 'SPY', ASX: 'STW.AX' }

/** Leader lookup by timestamp, built once per dataset and market. */
export function btcContext(data, market = '') {
  data.leaderCtx ||= {}
  if (data.leaderCtx[market]) return data.leaderCtx[market]
  const btc = data.coins.find(c => c.base === LEADERS[market])
  const idx = new Map(btc ? btc.t.map((t, i) => [t, i]) : [])
  return (data.leaderCtx[market] = { btc, idx })
}

/** F = features(coin) from lab.js (dvol, ratio). */
export function comboSignal(spec, coin, F, i, data) {
  if (i < 200 || !Number.isFinite(F.dvol[i])) return false
  const c = coin.c, dv = F.dvol[i]
  for (const k of spec.conds) {
    switch (k.p) {
      case 'breakout': if (!(c[i] > hiPrev(coin, k.n)[i])) return false; break
      case 'aboveSma': if (!(c[i] > sma(coin, k.n)[i])) return false; break
      case 'belowSma': if (!(c[i] < sma(coin, k.n)[i])) return false; break
      case 'mom': if (!(c[i] / c[i - k.n] - 1 > k.k * dv * Math.sqrt(k.n))) return false; break
      case 'dip': if (!(c[i] / c[i - k.n] - 1 < -k.k * dv * Math.sqrt(k.n))) return false; break
      case 'volSpike': { const v = coin.v?.[i]; if (!(v > k.k * volAvg(coin)[i])) return false; break }
      case 'quiet': if (!(F.ratio[i] < 0.8)) return false; break
      case 'loud': if (!(F.ratio[i] > 1.25)) return false; break
      case 'btcUp': case 'btcDown': {
        const { btc, idx } = btcContext(data, coin.market || '')
        const j = btc ? idx.get(coin.t[i]) : undefined
        if (j == null) return false
        const up = btc.c[j] > sma(btc, k.n)[j]
        if (k.p === 'btcUp' ? !up : up) return false
        break
      }
      default: return false
    }
  }
  return true
}
