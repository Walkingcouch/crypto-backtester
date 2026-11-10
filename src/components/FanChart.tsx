import { useEffect, useRef, useState } from 'react'
import type { Levels } from '../lib/forecast'

/** Past prices plus a forecast "fan" (50/80/90% ranges) drawn as SVG on a log scale. */
export default function FanChart({ t, prices, levels, h, fmt }: {
  t: number[]; prices: number[]; levels: Levels; h: number; fmt: (x: number) => string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [cw, setCw] = useState(900)
  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver(e => setCw(Math.max(280, Math.round(e[0].contentRect.width))))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])
  const W = cw, H = cw < 500 ? 280 : 340, padL = 4, padR = cw < 500 ? 78 : 92, padT = 16, padB = 30
  const DAY = 86_400_000
  const t0 = t[0], tNow = t[t.length - 1], tEnd = tNow + h * DAY
  const all = [...prices, levels.p5, levels.p95]
  const lo = Math.log(Math.min(...all) * 0.97), hi = Math.log(Math.max(...all) * 1.03)
  const x = (ms: number) => padL + ((ms - t0) / (tEnd - t0)) * (W - padL - padR)
  const y = (p: number) => padT + (1 - (Math.log(p) - lo) / (hi - lo)) * (H - padT - padB)
  const path = prices.map((p, i) => `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(p).toFixed(1)}`).join('')
  const last = prices[prices.length - 1]
  const band = (a: number, b: number) =>
    `M${x(tNow)},${y(last)} L${x(tEnd)},${y(b)} L${x(tEnd)},${y(a)} Z`
  // time ticks: month starts
  const ticks: number[] = []
  const d = new Date(t0); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0)
  while (d.getTime() < tEnd) { d.setUTCMonth(d.getUTCMonth() + 1); if (d.getTime() > t0 && d.getTime() < tEnd) ticks.push(d.getTime()) }
  const every = Math.ceil(ticks.length / (cw < 500 ? 4 : 7))
  const label = (txt: string, p: number, strong = false) => (
    <text x={W - padR + 8} y={y(p) + 4} fontSize="12" fill={strong ? 'var(--text)' : 'var(--muted)'} fontWeight={strong ? 600 : 400}>{txt}</text>
  )
  return (
    <div ref={box} style={{ width: '100%' }}>
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', maxWidth: '100%' }} role="img" aria-label="Price history and forecast range">
      {ticks.filter((_, i) => i % every === 0).map(ms => (
        <g key={ms}>
          <line x1={x(ms)} x2={x(ms)} y1={padT} y2={H - padB} stroke="var(--border)" />
          <text x={x(ms)} y={H - 12} fontSize="12" fill="var(--muted)" textAnchor="middle">
            {new Date(ms).toLocaleDateString(undefined, { month: 'short', ...(new Date(ms).getUTCMonth() === 0 ? { year: '2-digit' } : {}) })}
          </text>
        </g>
      ))}
      <rect x={x(tNow)} y={padT} width={x(tEnd) - x(tNow)} height={H - padT - padB} fill="var(--surface-2)" />
      <path d={band(levels.p5, levels.p95)} fill="var(--accent)" opacity="0.12" />
      <path d={band(levels.p10, levels.p90)} fill="var(--accent)" opacity="0.18" />
      <path d={band(levels.p25, levels.p75)} fill="var(--accent)" opacity="0.28" />
      <line x1={x(tNow)} y1={y(last)} x2={x(tEnd)} y2={y(last)} stroke="var(--accent)" strokeDasharray="5 4" strokeWidth="1.5" />
      <path d={path} fill="none" stroke="var(--text)" strokeWidth="1.8" />
      <circle cx={x(tNow)} cy={y(last)} r="4" fill="var(--text)" />
      <line x1={x(tNow)} x2={x(tNow)} y1={padT} y2={H - padB} stroke="var(--faint)" strokeDasharray="3 3" />
      <text x={x(tNow) - 6} y={padT + 12} fontSize="12" fill="var(--muted)" textAnchor="end">today</text>
      {label(fmt(levels.p90), levels.p90)}
      {label(fmt(levels.p75), levels.p75)}
      {label(fmt(last), last, true)}
      {label(fmt(levels.p25), levels.p25)}
      {label(fmt(levels.p10), levels.p10)}
    </svg>
    </div>
  )
}

/** Small histogram of outcomes (fractions), zero line marked. */
export function OutcomeBars({ outcomes }: { outcomes: number[] }) {
  if (!outcomes.length) return null
  const W = 600, H = 120, pad = 22
  const lo = Math.min(...outcomes, -0.05), hi = Math.max(...outcomes, 0.05)
  const bins = 16, size = (hi - lo) / bins
  const counts = new Array(bins).fill(0)
  for (const o of outcomes) counts[Math.min(bins - 1, Math.floor((o - lo) / size))]++
  const max = Math.max(...counts)
  const bw = (W - 2 * pad) / bins
  const x0 = pad + ((0 - lo) / (hi - lo)) * (W - 2 * pad)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="How similar past moments turned out">
      {counts.map((n, i) => {
        const mid = lo + (i + 0.5) * size, bh = max ? (n / max) * (H - pad - 10) : 0
        return <rect key={i} x={pad + i * bw + 1} y={H - pad - bh} width={bw - 2} height={bh} rx="2" fill={mid >= 0 ? 'var(--accent)' : 'var(--neg)'} opacity="0.75" />
      })}
      <line x1={x0} x2={x0} y1={6} y2={H - pad} stroke="var(--text)" strokeDasharray="3 3" />
      <text x={x0} y={H - 6} fontSize="12" fill="var(--muted)" textAnchor="middle">0%</text>
      <text x={pad} y={H - 6} fontSize="12" fill="var(--muted)">{(lo * 100).toFixed(0)}%</text>
      <text x={W - pad} y={H - 6} fontSize="12" fill="var(--muted)" textAnchor="end">+{(hi * 100).toFixed(0)}%</text>
    </svg>
  )
}
