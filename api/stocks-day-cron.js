// Shares Lab · day trading: hourly bars for liquid US and ASX shares, twice an hour (Vercel cron).
// The full ~2 years of hourly bars are fetched only for the daily re-test (or while no rule is in
// charge); otherwise the last 3 months are plenty for signals and stops.
import { ASX_DAY, DAY, HOUR, SDT, stepStockDay, US_DAY } from '../src/lib/stockday.js'
import { SPREAD } from '../src/lib/stocks.js'
import { sharesHandler } from './_lib/sharesrun.js'

export default sharesHandler({
  sid: 'stocks-day', list: [...US_DAY.map(s => [s, 'US']), ...ASX_DAY.map(s => [s, 'ASX'])], accounts: SDT.accounts, spread: SPREAD, minBars: 200, events: true,
  bars: (saved, now) => {
    const full = !saved || !saved.rules?.some(r => r.status === 'champion') || (!saved.learning && !saved.rules?.some(r => r.status === 'champion' && !r.practice)) || now - (saved.lastCoach || 0) >= SDT.coachEveryDays * DAY - 2 * HOUR
    return { range: full ? '730d' : '3mo', interval: '1h', full }
  },
  stepFn: (s, m, now) => stepStockDay(s, m, now, SDT),
})
