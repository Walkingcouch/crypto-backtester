// Browser port of the Python engine (python/backtester/engine.py). Same rules:
//  - strategy returns target exposure 0..1 per bar using data up to that bar's close
//  - executed at NEXT bar's open, with slippage + fee on every fill
//  - long-only, no leverage, explicit cash/units/equity/trade accounting

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }
export interface Costs { fee: number; slippage: number }
export interface Trade {
  t: number; side: 'BUY' | 'SELL'; qty: number; price: number; fee: number; cashAfter: number; unitsAfter: number
}
export interface Metrics {
  finalEquity: number; totalReturn: number; cagr: number; volatility: number; sharpe: number
  sortino: number; maxDrawdown: number; calmar: number; trades: number; roundTrips: number
  winRate: number; feesPaid: number; timeInMarket: number; years: number
}
export interface Result {
  t: number[]; equity: number[]; exposure: number[]; trades: Trade[]; metrics: Metrics
  params: Record<string, number>
}
export type StrategyFn = (bars: Bar[], p: Record<string, number>) => number[]

const DAY = 86_400_000

export function barsPerYear(bars: { t: number }[]): number {
  const d: number[] = []
  for (let i = 1; i < bars.length; i++) d.push(bars[i].t - bars[i - 1].t)
  d.sort((a, b) => a - b)
  const step = d[Math.floor(d.length / 2)] || DAY
  return (365 * DAY) / step
}

export function runBacktest(
  bars: Bar[], strategy: StrategyFn, params: Record<string, number>, cash0: number, costs: Costs,
  opts: { threshold?: number; signal?: number[]; startIndex?: number } = {},
): Result {
  const threshold = opts.threshold ?? 0.05
  const raw = opts.signal ?? strategy(bars, params)
  const target = raw.map(x => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0))
  const start = opts.startIndex ?? 0
  let cash = cash0, units = 0
  const t: number[] = [], equity: number[] = [], exposure: number[] = [], trades: Trade[] = []

  for (let i = start; i < bars.length; i++) {
    if (i > start) {
      const want = target[i - 1]
      const price = bars[i].o
      const eq = cash + units * price
      const held = eq > 0 ? (units * price) / eq : 0
      if (Math.abs(want - held) > threshold || (want === 0 && units > 0)) {
        const delta = want * eq - units * price
        if (delta > 0) {
          const fill = price * (1 + costs.slippage)
          const spend = want >= 1 ? cash : Math.min(delta, cash)
          const qty = spend / (fill * (1 + costs.fee))
          if (qty > 0) {
            cash -= spend; units += qty
            trades.push({ t: bars[i].t, side: 'BUY', qty, price: fill, fee: spend - qty * fill, cashAfter: cash, unitsAfter: units })
          }
        } else {
          const fill = price * (1 - costs.slippage)
          const qty = want <= 0 ? units : Math.min(-delta / price, units)
          if (qty > 0) {
            const gross = qty * fill, fee = gross * costs.fee
            cash += gross - fee; units -= qty
            if (want <= 0) units = 0
            trades.push({ t: bars[i].t, side: 'SELL', qty, price: fill, fee, cashAfter: cash, unitsAfter: units })
          }
        }
      }
    }
    const e = cash + units * bars[i].c
    t.push(bars[i].t); equity.push(e); exposure.push(e > 0 ? (units * bars[i].c) / e : 0)
  }
  return { t, equity, exposure, trades, params, metrics: computeMetrics(t, equity, exposure, trades, cash0) }
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1)
const std = (a: number[]) => {
  if (a.length < 2) return 0
  const m = mean(a)
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1))
}

export function roundTrips(trades: Trade[]): number[] {
  const out: number[] = []
  let cost = 0, proceeds = 0
  for (const tr of trades) {
    if (tr.side === 'BUY') cost += tr.qty * tr.price + tr.fee
    else {
      proceeds += tr.qty * tr.price - tr.fee
      if (tr.unitsAfter <= 1e-12 && cost > 0) { out.push(proceeds / cost - 1); cost = 0; proceeds = 0 }
    }
  }
  return out
}

export function computeMetrics(t: number[], eq: number[], ex: number[], trades: Trade[], cash0: number): Metrics {
  const rets: number[] = []
  for (let i = 1; i < eq.length; i++) rets.push(eq[i] / eq[i - 1] - 1)
  const bpy = barsPerYear(t.map(x => ({ t: x })))
  const years = Math.max((t[t.length - 1] - t[0]) / (365 * DAY), 1e-9)
  const growth = eq[eq.length - 1] / cash0
  const cagr = growth > 0 ? Math.expm1(Math.min(Math.log(growth) / years, 50)) : -1
  const vol = std(rets) * Math.sqrt(bpy)
  const sharpe = vol > 0 ? (mean(rets) * bpy) / vol : 0
  const dn = std(rets.filter(r => r < 0)) * Math.sqrt(bpy)
  const sortino = dn > 0 ? (mean(rets) * bpy) / dn : 0
  let peak = -Infinity, mdd = 0
  for (const e of eq) { peak = Math.max(peak, e); mdd = Math.min(mdd, e / peak - 1) }
  const rts = roundTrips(trades)
  return {
    finalEquity: eq[eq.length - 1], totalReturn: growth - 1, cagr, volatility: vol, sharpe, sortino,
    maxDrawdown: mdd, calmar: mdd < 0 ? cagr / Math.abs(mdd) : 0, trades: trades.length,
    roundTrips: rts.length, winRate: rts.length ? rts.filter(r => r > 0).length / rts.length : NaN,
    feesPaid: trades.reduce((s, x) => s + x.fee, 0), timeInMarket: ex.filter(x => x > 0.01).length / (ex.length || 1),
    years,
  }
}

export function drawdown(eq: number[]): number[] {
  let peak = -Infinity
  return eq.map(e => { peak = Math.max(peak, e); return e / peak - 1 })
}

/** Throws if a strategy's signal at bar i changes when future bars are removed. */
export function checkNoLookahead(bars: Bar[], fn: StrategyFn, p: Record<string, number>, checkpoints = 8) {
  const full = fn(bars, p)
  const n = bars.length
  for (let k = 0; k < checkpoints; k++) {
    const cut = Math.floor(n / 4 + (k * (n - 2 - n / 4)) / (checkpoints - 1))
    const part = fn(bars.slice(0, cut + 1), p)
    const a = full[cut] || 0, b = part[cut] || 0
    if (Math.abs(a - b) > 1e-9)
      throw new Error(`Lookahead detected at ${new Date(bars[cut].t).toISOString().slice(0, 10)}: the strategy uses future prices.`)
  }
}

export function* paramGrid(grid: Record<string, number[]>): Generator<Record<string, number>> {
  const keys = Object.keys(grid)
  if (!keys.length) { yield {}; return }
  const idx = keys.map(() => 0)
  while (true) {
    yield Object.fromEntries(keys.map((k, i) => [k, grid[k][idx[i]]]))
    let j = keys.length - 1
    while (j >= 0 && ++idx[j] >= grid[keys[j]].length) { idx[j] = 0; j-- }
    if (j < 0) return
  }
}
