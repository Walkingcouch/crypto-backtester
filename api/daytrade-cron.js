// Day Trade Lab: intraday rules on hourly candles, run every hour by pg_cron.
// Full history (8 × 1000 hours ≈ 11 months) only when the daily re-test is due; otherwise
// the latest 1000 hours are enough for signals and stops.
import { DT, DAY, HOUR, stepDay } from '../src/lib/daytrade.js'
import { labHandler } from './_lib/labrun.js'

export default labHandler({
  sid: 'daytrade', universe: DT.universe, interval: '1h', minBars: 600,
  pages: (saved, now) => (!saved || now - (saved.lastCoach || 0) >= DT.coachEveryDays * DAY - HOUR ? 8 : 1),
  stepFn: (s, m, now) => stepDay(s, m, now, DT),
})
