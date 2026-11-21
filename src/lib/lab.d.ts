export interface Stats { n: number; mean: number; se: number; t: number; win: number }
export interface RuleSpec { kind: string; n?: number; k?: number; regime: string; H: number }
export interface LabRule {
  v: number; id: string; spec: RuleSpec; text: string; status: 'champion' | 'challenger' | 'retired'
  since: number; reason?: string; wasChampion?: boolean; practice?: boolean; explorer?: boolean; score?: number; rigor?: Rigor; vsIndex?: Stats; train: Stats; valid: Stats; all: Stats; pass: boolean
  live?: { trades: { t: number; base: string; g: number }[] }
}
export interface Rigor {
  days: number; sharpe: number; meanNet: number; annual: number; maxDD: number; shuffleDD: number; randomP: number; randomMean: number
  neighbours: { n: number; up: number }; dsr: number; trials: number; years: Record<string, { n: number; mean: number }>
  checks: { random: boolean; doubleFee: boolean; neighbours: boolean; deflated: boolean; index?: boolean; portfolio?: boolean; sealed?: boolean }; passedAll: boolean
  portfolio?: { taken: number; available: number; total: number; annual: number; maxDD: number; maxOpen: number; slot: number }
  exam?: { n: number; mean: number; t: number; at: number; window: [number, number]; passed: boolean }; examRequired?: boolean
  v?: number; edgeVsRandom?: number; vsIndex?: number; regime?: RegimeProfile | null
}
export type RegimeVerdict = 'suits' | 'struggles' | 'leans better' | 'leans worse' | 'same' | 'too few'
export interface RegimeProfile {
  n: number; mean: number; summary: string
  cells: { trend: Record<'up' | 'mixed' | 'down', { n: number; mean: number; z?: number }>; vol: Record<'calm' | 'normal' | 'wild', { n: number; mean: number; z?: number }> }
  verdicts: { trend: Record<'up' | 'mixed' | 'down', RegimeVerdict>; vol: Record<'calm' | 'normal' | 'wild', RegimeVerdict> }
  weights: { trend: Record<'up' | 'mixed' | 'down', number>; vol: Record<'calm' | 'normal' | 'wild', number> }
}
export interface Found { id: string; text: string; H: number; pass: boolean; train: Stats; valid: Stats; all: Stats }
export interface Position { base: string; v: number; units: number; entryPx: number; fillPx: number; costUsd: number; t: number; stop: number; exitT: number; spread: number; est: number; cost: number; estimated?: boolean }
export interface Closed extends Position { exitPx: number; net: number; gross: number; why: 'stop' | 'time'; rMult?: number | null; expected?: number | null }
export interface Account {
  market?: string; perShareUsd?: number; minFeeUsd?: number; minFeeAud?: number; maxFeePct?: number
  id: string; owner: string; broker: string; exchange: string; fee: number; feeLabel: string; startAud: number
  startUsd: number; cashAud: number; valueUsd?: number; valueAud?: number
  positions: Position[]; closed: Closed[]; stats: { n: number; wins: number; sumNet: number }
  blocked: { cost: number; quote: number; limits: number }; lastBlocked: { t: number; base: string; v: number; why: string }[]
}
export interface LabEvent { t: number; kind: string; text: string }
export interface LabState {
  learning?: { v?: number; since: number; active: number; eligible: number; benched: number; minHoldDays?: number; failAfter?: number }
  version: number; created: number; lastRun: number | null; lastSignalDay: number; lastCoach: number; nextV: number
  venueCosts?: Record<string, { exchange: string; cost: number; fee: number; gap: number }>; selectCost?: { account: string; exchange: string; cost: number }
  regimeNow?: Record<string, { trend: "up" | "mixed" | "down"; vol: "calm" | "normal" | "wild" }>
  rules: LabRule[]; shadow: { v: number; base: string; entry: number; t: number; stop: number; exitT: number }[]
  events: LabEvent[]; history: ({ t: number } & Record<string, number>)[]
  accounts: Record<string, Account>; prices?: Record<string, number>; found?: Found[]; coinsScanned?: string[]; audPerUsd?: number
}
export const DAY: number
export const LAB: {
  universe: number; margin: number; slippage: number; maxPosition: number; riskPerTrade: number; maxOpen: number; maxInvested: number
  validDays: number; refCost: number; minTrain: number; minTrainT: number; minValid: number; maxChallengers: number
  promoteAfter: number; promoteBy: number; coachEveryDays: number
}
export const ACCOUNTS: { id: string; owner: string; broker: string; exchange: string; fee: number; feeLabel: string; startAud: number }[]
export function estimate(all: Stats): number
export function describe(r: RuleSpec): string
export function feeFrac(a: Account, valueUsd: number, px: number, rate: number): number
