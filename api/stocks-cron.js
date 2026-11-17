// Shares Lab · swing rules: the crypto Lab's 39 rules on ~5 years of daily US and ASX prices.
// Vercel cron runs it after each close (06:30 UTC ASX, 21:30 UTC US).
import { step } from '../src/lib/lab.js'
import { ASX, SPREAD, STOCK, US } from '../src/lib/stocks.js'
import { sharesHandler } from './_lib/sharesrun.js'

export default sharesHandler({
  sid: 'stocks', list: [...US.map(s => [s, 'US']), ...ASX.map(s => [s, 'ASX'])], accounts: STOCK.accounts, spread: SPREAD,
  stepFn: (s, m, now) => step(s, m, now, STOCK),
})
