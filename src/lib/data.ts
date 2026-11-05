import type { Bar } from './engine'

// Binance's public market-data host: no account or key, CORS-enabled.
const HOST = 'https://data-api.binance.vision/api/v3/klines'
const STEP: Record<string, number> = { '1d': 86_400_000, '4h': 14_400_000, '1h': 3_600_000 }

const cache = new Map<string, Bar[]>()

export async function fetchCandles(
  symbol: string, interval: string, since: string, onProgress?: (n: number) => void,
): Promise<Bar[]> {
  const key = `${symbol}|${interval}|${since}`
  if (cache.has(key)) return cache.get(key)!
  let start = Date.parse(since + 'T00:00:00Z')
  const out: Bar[] = []
  const now = Date.now()
  for (let page = 0; page < 60; page++) {
    const url = `${HOST}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${start}&limit=1000`
    const res = await fetch(url)
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(res.status === 400 ? `Unknown symbol "${symbol}" on Binance.` : `Price download failed (${res.status}): ${txt.slice(0, 120)}`)
    }
    const rows: (string | number)[][] = await res.json()
    if (!rows.length) break
    for (const r of rows)
      out.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })
    onProgress?.(out.length)
    start = +rows[rows.length - 1][0] + STEP[interval]
    if (rows.length < 1000 || start > now) break
  }
  // drop the still-forming candle
  const done = out.filter(b => b.t + STEP[interval] <= now)
  cache.set(key, done)
  return done
}

/** CSV with columns timestamp(or date),open,high,low,close[,volume]. Timestamps in s/ms or ISO. */
export function parseCsv(text: string): Bar[] {
  const lines = text.trim().split(/\r?\n/)
  const head = lines[0].toLowerCase().split(',').map(s => s.trim())
  const col = (names: string[]) => head.findIndex(h => names.includes(h))
  const ti = col(['timestamp', 'time', 'date', 'datetime'])
  const [oi, hi, li, ci, vi] = ['open', 'high', 'low', 'close', 'volume'].map(n => col([n]))
  if (ti < 0 || oi < 0 || hi < 0 || li < 0 || ci < 0) throw new Error('CSV needs columns: timestamp, open, high, low, close')
  const bars = lines.slice(1).filter(Boolean).map(line => {
    const f = line.split(',')
    const rawT = f[ti].trim()
    let t = Number(rawT)
    if (Number.isFinite(t)) t = t < 1e11 ? t * 1000 : t < 1e14 ? t : t / 1000
    else t = Date.parse(rawT)
    return { t, o: +f[oi], h: +f[hi], l: +f[li], c: +f[ci], v: vi >= 0 ? +f[vi] : 0 }
  })
  if (bars.some(b => !Number.isFinite(b.t) || !(b.c > 0))) throw new Error('CSV contains bad rows (missing dates or prices).')
  bars.sort((a, b) => a.t - b.t)
  return bars.filter((b, i) => i === 0 || b.t !== bars[i - 1].t)
}
