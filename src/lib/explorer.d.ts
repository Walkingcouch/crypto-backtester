import type { LAB } from './lab'
export const EXPLORE: typeof LAB & { population: number; randomPerRun: number; mutantsPerRun: number; crossPerRun: number; minTrades: number; complexityCost: number; graduates: number }
export function hurdle(tried: number): number
