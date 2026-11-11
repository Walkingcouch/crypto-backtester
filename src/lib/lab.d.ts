export interface Stats { n: number; mean: number; se: number; t: number; win: number }
export interface RuleSpec { kind: string; n?: number; k?: number; regime: string; H: number }
export interface LabRule {
  v: number; id: string; spec: RuleSpec; text: string; status: 'champion' | 'challenger' | 'retired'
  since: number; reason?: string; wasChampion?: boolean; train: Stats; valid: Stats; all: Stats; pass: boolean
  live?: { trades: { t: number; base: string; g: number }[] }
}
export interface Found { id: string; text: string; H: number; pass: boolean; train: Stats; valid: Stats; all: Stats }
export interface Position { base: string; v: number; units: number; entryPx: number; fillPx: number; costUsd: number; t: number; stop: number; exitT: number; spread: number; est: number; cost: number }
export interface Closed extends Position { exitPx: number; net: number; gross: number; why: 'stop' | 'time' }
export interface Account {
  id: string; owner: string; broker: string; exchange: string; fee: number; feeLabel: string; startAud: number
  startUsd: number; cashUsd: number; valueUsd?: number; valueAud?: number
  positions: Position[]; closed: Closed[]; stats: { n: number; wins: number; sumNet: number }
  blocked: { cost: number; quote: number; limits: number }; lastBlocked: { t: number; base: string; v: number; why: string }[]
}
export interface LabEvent { t: number; kind: string; text: string }
export interface LabState {
  version: number; created: number; lastRun: number | null; lastSignalDay: number; lastCoach: number; nextV: number
  rules: LabRule[]; shadow: { v: number; base: string; entry: number; t: number; stop: number; exitT: number }[]
  events: LabEvent[]; history: ({ t: number } & Record<string, number>)[]
  accounts: Record<string, Account>; found?: Found[]; coinsScanned?: string[]; audPerUsd?: number
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
