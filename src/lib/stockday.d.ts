import type { LAB } from './lab'
export const HOUR: number
export const DAY: number
export const US_DAY: string[]
export const ASX_DAY: string[]
export const SDT: typeof LAB & { accounts: { id: string; market: string; startAud: number }[]; dailyLossLimit: number; practiceLossLimit: number; ddCut: number; practiceRules: number }
