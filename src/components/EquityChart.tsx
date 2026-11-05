import { useEffect, useRef } from 'react'
import { AreaSeries, ColorType, createChart, LineSeries, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import { drawdown } from '../lib/engine'

interface Line { name: string; t: number[]; values: number[]; color: string }

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

function baseChart(el: HTMLDivElement, log: boolean): IChartApi {
  return createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--muted'), fontFamily: 'Inter, system-ui', fontSize: 11, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: css('--border') } },
    rightPriceScale: { borderVisible: false, mode: log ? 1 : 0 },
    timeScale: { borderVisible: false },
    crosshair: { horzLine: { labelBackgroundColor: css('--text') }, vertLine: { labelBackgroundColor: css('--text') } },
    handleScroll: false, handleScale: false,
  })
}

const toData = (t: number[], v: number[]) =>
  t.map((x, i) => ({ time: Math.floor(x / 1000) as UTCTimestamp, value: v[i] }))

export default function EquityChart({ lines }: { lines: Line[] }) {
  const top = useRef<HTMLDivElement>(null)
  const bot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!top.current || !bot.current) return
    const c1 = baseChart(top.current, true)
    const c2 = baseChart(bot.current, false)
    for (const l of lines) {
      const s = c1.addSeries(LineSeries, { color: l.color, lineWidth: l.name.includes('hold') ? 1 : 2, priceLineVisible: false, lastValueVisible: false })
      s.setData(toData(l.t, l.values))
      const dd = drawdown(l.values).map(x => x * 100)
      const s2 = l.name.includes('hold')
        ? c2.addSeries(LineSeries, { color: l.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
        : c2.addSeries(AreaSeries, { lineColor: l.color, topColor: 'transparent', bottomColor: l.color + '44', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, invertFilledArea: true })
      s2.setData(toData(l.t, dd))
    }
    c1.timeScale().applyOptions({ visible: false })
    c1.timeScale().fitContent(); c2.timeScale().fitContent()
    c2.priceScale('right').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 } })
    return () => { c1.remove(); c2.remove() }
  }, [lines])

  return (
    <div>
      <div className="legend">
        {lines.map(l => <span key={l.name}><i style={{ background: l.color }} />{l.name}</span>)}
        <span className="spacer" /><span>log scale · lower panel: drawdown %</span>
      </div>
      <div ref={top} className="chart" />
      <div ref={bot} className="chart-dd" />
    </div>
  )
}
