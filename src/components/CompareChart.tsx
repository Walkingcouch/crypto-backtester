import { useEffect, useRef } from 'react'
import { ColorType, createChart, LineSeries, type UTCTimestamp } from 'lightweight-charts'

export interface CompareLine { name: string; color: string; t: number[]; pct: number[] }

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

/** Lines rebased to 0% at the start of the period, so coins of any price compare fairly. */
export default function CompareChart({ lines, intraday }: { lines: CompareLine[]; intraday: boolean }) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!el.current) return
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--muted'), fontFamily: 'Inter, system-ui', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--border') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: intraday, secondsVisible: false },
      localization: { priceFormatter: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` },
      handleScroll: false, handleScale: false,
    })
    for (const l of lines) {
      const s = chart.addSeries(LineSeries, { color: l.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: l.name })
      s.setData(l.t.map((t, i) => ({ time: Math.floor(t / 1000) as UTCTimestamp, value: l.pct[i] })))
    }
    const zero = chart.addSeries(LineSeries, { color: css('--faint'), lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    if (lines[0]) zero.setData(lines[0].t.map(t => ({ time: Math.floor(t / 1000) as UTCTimestamp, value: 0 })))
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [lines, intraday])
  return <div ref={el} className="chart compare-chart" />
}
