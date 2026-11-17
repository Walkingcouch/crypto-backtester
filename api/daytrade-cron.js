// Day Trade Lab: intraday rules on hourly candles, run every hour by pg_cron.
// Full history (24 × 1000 hours ≈ 2.7 years, Vercel Pro time limits) only when the daily re-test is due; otherwise
// the latest 1000 hours are enough for signals and stops.
import { DT, DAY, HOUR, stepDay } from '../src/lib/daytrade.js'
import { labHandler } from './_lib/labrun.js'

export default labHandler({
  sid: 'daytrade', universe: DT.universe, interval: '1h', minBars: 600,
  pages: (saved, now) => (!saved || now - (saved.lastCoach || 0) >= DT.coachEveryDays * DAY - HOUR ? 24 : 1),
  stepFn: (s, m, now) => stepDay(s, m, now, DT),
})
