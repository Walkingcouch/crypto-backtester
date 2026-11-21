// Day Trade Lab: intraday rules on hourly candles, run every hour by pg_cron.
// Full history (45 × 1000 hours ≈ 5.1 years, back to late 2021 so the whole 2022 bear market is in the test) only when the daily re-test is due; otherwise
// the latest 1000 hours are enough for signals and stops. Practice mode starts on the first run with
// no rule in charge, so that run also gets the full history.
import { DT, DAY, HOUR, stepDay } from '../src/lib/daytrade.js'
import { labHandler } from './_lib/labrun.js'

export default labHandler({
  sid: 'daytrade', universe: DT.universe, wide: true, wideMinVolUsd: 1e6, events: true, interval: '1h', minBars: 600,
  pages: (saved, now) => (!saved || !saved.rules?.some(r => r.status === 'champion') || !saved.found?.some(f => (f.rigor?.v ?? 0) >= 3) || (saved.learning?.v !== 2 && !saved.rules?.some(r => r.status === 'champion' && !r.practice)) || now - (saved.lastCoach || 0) >= DT.coachEveryDays * DAY - HOUR ? 45 : 1),
  stepFn: (s, m, now) => stepDay(s, m, now, DT),
})
