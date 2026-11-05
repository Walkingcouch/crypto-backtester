import type { Bar, StrategyFn } from './engine'

export interface StrategyDef {
  id: string
  name: string
  friendly?: string
  tagline?: string
  version: number // bump whenever the rules change -> the test ledger treats it as a new strategy
  summary: string
  rules: { entry: string; exit: string; sizing: string }
  grid: Record<string, number[]>
  fn: StrategyFn
}

const sma = (x: number[], n: number) => {
  const out = new Array(x.length).fill(NaN)
  let s = 0
  for (let i = 0; i < x.length; i++) {
    s += x[i]
    if (i >= n) s -= x[i - n]
    if (i >= n - 1) out[i] = s / n
  }
  return out
}

const smaCross: StrategyFn = (bars, { fast, slow }) => {
  if (fast >= slow) return bars.map(() => 0)
  const c = bars.map(b => b.c), f = sma(c, fast), s = sma(c, slow)
  return c.map((_, i) => (f[i] > s[i] ? 1 : 0))
}

const donchian: StrategyFn = (bars, { entry, exit }) => {
  const out: number[] = []
  let state = 0
  for (let i = 0; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity
    if (i >= entry) for (let j = i - entry; j < i; j++) hi = Math.max(hi, bars[j].h)
    if (i >= exit) for (let j = i - exit; j < i; j++) lo = Math.min(lo, bars[j].l)
    if (state === 0 && i >= entry && bars[i].c > hi) state = 1
    else if (state === 1 && i >= exit && bars[i].c < lo) state = 0
    out.push(state)
  }
  return out
}

const volTarget: StrategyFn = (bars: Bar[], p) => {
  const trend = smaCross(bars, p)
  const w = 30
  const step = bars.length > 1 ? (bars[1].t - bars[0].t) / 86_400_000 : 1
  const ann = Math.sqrt(365 / step)
  const r = bars.map((b, i) => (i ? b.c / bars[i - 1].c - 1 : NaN))
  return bars.map((_, i) => {
    if (i < w || !trend[i]) return 0
    const win = r.slice(i - w + 1, i + 1)
    const m = win.reduce((a, b) => a + b, 0) / w
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / (w - 1)) * ann
    return sd > 0 ? Math.min(1, p.targetVol / sd) : 0
  })
}

export const STRATEGIES: StrategyDef[] = [
  {
    id: 'sma_cross', name: 'Trend baseline (SMA cross)', friendly: 'Follow the trend', tagline: 'Hold while prices trend up, sit in cash while they trend down. The baseline to beat.', version: 1,
    summary: 'The baseline every other idea must beat. Holds when the short-term average price is above the long-term average.',
    rules: {
      entry: 'Fast moving average of closes rises above the slow moving average.',
      exit: 'Fast average falls below the slow average.',
      sizing: '100% in or 100% cash.',
    },
    grid: { fast: [10, 20, 50], slow: [100, 150, 200] }, fn: smaCross,
  },
  {
    id: 'donchian', name: 'Breakout (Donchian)', friendly: 'Catch breakouts', tagline: 'Buy when price breaks to a new high, sell when it breaks to a new low.', version: 1,
    summary: 'Buys when price breaks out to a new multi-week high, exits on a new multi-week low.',
    rules: {
      entry: 'Close above the highest high of the previous `entry` bars.',
      exit: 'Close below the lowest low of the previous `exit` bars.',
      sizing: '100% in or 100% cash.',
    },
    grid: { entry: [20, 55], exit: [10, 20] }, fn: donchian,
  },
  {
    id: 'sma_cross_voltarget', name: 'Trend + volatility sizing', friendly: 'Trend, steadier ride', tagline: 'Follow the trend, but hold less when the market gets wild.', version: 1,
    summary: 'Same signal as the baseline, but holds less when the market is wild and more when it is calm.',
    rules: {
      entry: 'Fast average above slow average.',
      exit: 'Fast average below slow average.',
      sizing: 'Exposure = target volatility ÷ last-30-bar volatility, capped at 100%.',
    },
    grid: { fast: [20, 50], slow: [100, 200], targetVol: [0.4, 0.6] }, fn: volTarget,
  },
  {
    id: 'buy_and_hold', name: 'Buy & hold', friendly: 'Buy and hold', tagline: 'Buy once and never sell.', version: 1,
    summary: 'Benchmark: buy on day one and never sell.',
    rules: { entry: 'First bar.', exit: 'Never.', sizing: '100%.' },
    grid: {}, fn: bars => bars.map(() => 1),
  },
]

export const byId = (id: string) => STRATEGIES.find(s => s.id === id)!
