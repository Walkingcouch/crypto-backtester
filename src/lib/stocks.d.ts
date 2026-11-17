import type { LAB } from './lab'
export const US: string[]
export const ASX: string[]
export const SPREAD: { US: number; ASX: number }
export const STOCK_ACCOUNTS: { id: string; owner: string; broker: string; exchange: string; market: string; fee: number; feeLabel: string; startAud: number }[]
export const STOCK: typeof LAB & { accounts: typeof STOCK_ACCOUNTS; daysPerBar: number }
export const STOCK_EXPLORE: typeof STOCK & { population: number; graduates: number; minTrades: number; minGradTrades: number }
