export interface PickSettings {
  universe: number; minHistory: number; lookbacks: number[]; buyScore: number; riskPerCoin: number
  maxWeight: number; rebalanceDays: number; minTrade: number; slippage: number
}
export const SETTINGS: PickSettings
export interface CoinSeries { base: string; close: number[]; qv: number[] }
export interface PickData { days: number[]; coins: CoinSeries[] }
export interface CoinView {
  base: string; price: number; score: number; checks: number; of: number; vol: number; mom: number
  avgVolume: number; history: number; r30: number; r90: number
  verdict?: 'buy' | 'hold' | 'avoid'; weight?: number
}
export interface Picks { day: number; universe: (CoinView & { verdict: 'buy' | 'hold' | 'avoid'; weight: number })[]; cash: number }
export interface Metrics { multiple: number; cagr: number; sharpe: number; maxDrawdown: number; years: number }
export interface Run { eq: number[]; days: number[]; exposure: number[]; trades: number; feesPaid: number; metrics: Metrics | null }
export interface PickBacktest { start: number; fee: number; strategy: Run & { avgExposure: number }; btc: Run; basket: Run }
export function analyseCoin(coin: CoinSeries, i: number, S?: PickSettings): CoinView | null
export function picksAt(data: PickData, i: number, S?: PickSettings): Picks
export function backtestPicks(data: PickData, fee: number, S?: PickSettings, startIndex?: number): PickBacktest
