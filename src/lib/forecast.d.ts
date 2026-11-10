export interface Prepared {
  n: number; c: Float64Array; r: Float64Array; ew: Float64Array; lr: Float64Array; trend: Int8Array
  cache: Map<string, Float64Array>; mood?: Float64Array
}
export interface Levels { p5: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number }
export interface Forecast {
  t: number; h: number; price: number; sd: number; levels: Levels; pUp: number; baseUp: number; usedMood: boolean; mood: number | null
  analog: { n: number; up: number; idx: number[]; p10: number; median: number; p90: number; worst: number; best: number; outcomes: number[] }
  situation: { r7: number; r30: number; trend: number; volPct: number; dailyVol: number }
}
export interface TrackRecord {
  n: number; h: number; step: number; first: number; last: number
  cover50: number; cover80: number; cover90: number
  hitRate: number; upRate: number; brier: number; brierBase: number; brierCoin: number
  bins: { n: number; predicted: number; actual: number }[]
}
export const HORIZONS: { days: number; label: string }[]
export function prepare(closes: ArrayLike<number>): Prepared
export function horizonSd(P: Prepared, i: number, h: number): number
export function forecastAt(P: Prepared, t: number, h: number, opts?: { mood?: boolean }): Forecast | null
export function trackRecord(P: Prepared, h: number, step?: number, from?: number, opts?: { mood?: boolean }): TrackRecord
export function attachMood(P: Prepared, dayTimes: number[], history: [number, number][]): Prepared
export interface MoodZone { name: string; lo: number; hi: number; n: number; up: number; median: number }
export function moodZones(P: Prepared, h: number): MoodZone[]
