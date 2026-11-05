import { checkNoLookahead, computeMetrics, paramGrid, runBacktest, type Bar, type Costs, type Metrics, type Result } from './engine'
import { byId, type StrategyDef } from './strategies'

export interface Split { train: Bar[]; testStartIndex: number }

export function splitBars(bars: Bar[], testFrac: number): Split {
  const idx = Math.max(250, Math.floor(bars.length * (1 - testFrac)))
  if (idx >= bars.length - 30) throw new Error('Not enough data for a test period. Pick an earlier start date.')
  return { train: bars.slice(0, idx), testStartIndex: idx }
}

export interface GridRow { params: Record<string, number>; metrics: Metrics }

export interface TrainOutcome {
  strategy: StrategyDef
  best: Result
  benchmark: Result
  grid: GridRow[]
}

export type Score = 'sharpe' | 'calmar' | 'totalReturn'

export function optimiseOnTrain(train: Bar[], s: StrategyDef, cash: number, costs: Costs, score: Score): TrainOutcome {
  const grid: GridRow[] = []
  for (const p of paramGrid(s.grid)) grid.push({ params: p, metrics: runBacktest(train, s.fn, p, cash, costs).metrics })
  grid.sort((a, b) => (b.metrics[score] as number) - (a.metrics[score] as number))
  const bestParams = grid[0].params
  checkNoLookahead(train, s.fn, bestParams)
  return {
    strategy: s,
    best: runBacktest(train, s.fn, bestParams, cash, costs),
    benchmark: runBacktest(train, byId('buy_and_hold').fn, {}, cash, costs),
    grid,
  }
}

/** Run on the held-out period. Indicators may use earlier bars (warm-up), but trading
 *  starts with fresh cash at the first test bar and only test-period stats are reported. */
export function evaluateTest(bars: Bar[], testStartIndex: number, s: StrategyDef, params: Record<string, number>, cash: number, costs: Costs): Result {
  checkNoLookahead(bars, s.fn, params)
  const signal = s.fn(bars, params)
  const r = runBacktest(bars, s.fn, params, cash, costs, { signal, startIndex: testStartIndex - 1 })
  // drop the single pre-test bar (it only carries the decision executed at the first test open)
  r.t = r.t.slice(1); r.equity = r.equity.slice(1); r.exposure = r.exposure.slice(1)
  r.metrics = computeMetrics(r.t, r.equity, r.exposure, r.trades, cash)
  return r
}

export function periodKey(symbol: string, interval: string, bars: Bar[], testStartIndex: number) {
  return `${symbol}|${interval}|${bars[testStartIndex].t}|${bars[bars.length - 1].t}`
}
