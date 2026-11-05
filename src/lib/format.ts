export const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '–')
export const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–')
export const money = (x: number) =>
  Number.isFinite(x) ? x.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }) : '–'
export const day = (t: number | string) => new Date(t).toISOString().slice(0, 10)
export const sign = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '')
export const paramStr = (p: Record<string, number>) =>
  Object.keys(p).length ? Object.entries(p).map(([k, v]) => `${k}=${v}`).join(', ') : 'none'
export const money0 = (x: number) =>
  Number.isFinite(x) ? x.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '–'
