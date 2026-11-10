import { useEffect, useRef, useState } from 'react'

export interface ForecastLine {
  base: string; color: string
  t: number[]; pct: number[]          // past, as % change versus today's price
  target: number; lo: number; hi: number   // forecast end points as % change (typical, 80% range)
}

/** Several coins on one chart: past moves rebased to today = 0%, plus each forecast. */
export default function CompareForecastChart({ lines, h, focus, onFocus }: { lines: ForecastLine[]; h: number; focus?: string; onFocus?: (b: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [cw, setCw] = useState(900)
  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver(e => setCw(Math.max(280, Math.round(e[0].contentRect.width))))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])
  if (!lines.length) return null
  const DAY = 86_400_000
  const W = cw, H = cw < 500 ? 300 : 360, padL = 4, padR = cw < 500 ? 52 : 92, padT = 14, padB = 28
  const tNow = Math.max(...lines.map(l => l.t[l.t.length - 1]))
  const t0 = Math.min(...lines.map(l => l.t[0])), tEnd = tNow + h * DAY
  const vals = lines.flatMap(l => [...l.pct, l.lo, l.hi, l.target])
  let lo = Math.min(...vals, -5), hi = Math.max(...vals, 5)
  const span = hi - lo; lo -= span * 0.04; hi += span * 0.04
  const x = (ms: number) => padL + ((ms - t0) / (tEnd - t0)) * (W - padL - padR)
  const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * (H - padT - padB)
  const step = [5, 10, 20, 25, 50, 100, 200, 500].find(s => (hi - lo) / s <= 6) ?? 1000
  const grid: number[] = []
  for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) grid.push(g)
  const ticks: number[] = []
  const d = new Date(t0); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0)
  while (d.getTime() < tEnd) { d.setUTCMonth(d.getUTCMonth() + 1); if (d.getTime() > t0 && d.getTime() < tEnd) ticks.push(d.getTime()) }
  const every = Math.ceil(ticks.length / (cw < 500 ? 4 : 7))
  // spread end labels so they don't overlap
  const ends = lines.map(l => ({ base: l.base, color: l.color, y: y(l.target), v: l.target })).sort((a, b) => a.y - b.y)
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15
  const fmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`
  return (
    <div ref={box} style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', maxWidth: '100%' }} role="img" aria-label="Forecasts for the selected coins">
        {grid.map(g => (
          <g key={g}>
            <line x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} stroke={g === 0 ? 'var(--faint)' : 'var(--border)'} strokeDasharray={g === 0 ? '3 3' : undefined} />
          </g>
        ))}
        {ticks.filter((_, i) => i % every === 0).map(ms => (
          <text key={ms} x={x(ms)} y={H - 8} fontSize="12" fill="var(--muted)" textAnchor="middle">{new Date(ms).toLocaleDateString(undefined, { month: 'short' })}</text>
        ))}
        <rect x={x(tNow)} y={padT} width={x(tEnd) - x(tNow)} height={H - padT - padB} fill="var(--surface-2)" opacity="0.7" />
        <line x1={x(tNow)} x2={x(tNow)} y1={padT} y2={H - padB} stroke="var(--faint)" strokeDasharray="3 3" />
        <text x={x(tNow) - 6} y={padT + 12} fontSize="12" fill="var(--muted)" textAnchor="end">today</text>
        {lines.map(l => {
          const dim = focus && l.base !== focus ? 0.45 : 1
          const path = l.pct.map((p, i) => `${i ? 'L' : 'M'}${x(l.t[i]).toFixed(1)},${y(p).toFixed(1)}`).join('')
          return (
            <g key={l.base} opacity={dim} style={{ cursor: onFocus ? 'pointer' : undefined }} onClick={() => onFocus?.(l.base)}>
              <path d={path} fill="none" stroke={l.color} strokeWidth="1.6" />
              <line x1={x(tNow)} y1={y(0)} x2={x(tEnd)} y2={y(l.hi)} stroke={l.color} strokeDasharray="4 4" strokeWidth="1.1" />
              <line x1={x(tNow)} y1={y(0)} x2={x(tEnd)} y2={y(l.lo)} stroke={l.color} strokeDasharray="4 4" strokeWidth="1.1" />
              <line x1={x(tNow)} y1={y(0)} x2={x(tEnd)} y2={y(l.target)} stroke={l.color} strokeWidth="4.5" strokeLinecap="round" />
              <circle cx={x(tEnd)} cy={y(l.target)} r="5" fill={l.color} stroke="var(--surface)" strokeWidth="2" />
            </g>
          )
        })}
        {ends.map(e => <text key={e.base} x={W - padR + 6} y={e.y + 4} fontSize="12" fontWeight={700} fill={e.color}>{cw < 500 ? e.base : `${e.base} ${fmt(e.v)}`}</text>)}
        {grid.map(g => <text key={'l' + g} x={padL + 2} y={y(g) - 3} fontSize="11" fill="var(--faint)">{fmt(g)}</text>)}
      </svg>
    </div>
  )
}
