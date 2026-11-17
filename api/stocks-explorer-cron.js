// Shares Lab · new ideas: the idea factory (explorer.js) breeding rules on US and ASX shares.
import { step } from '../src/lib/lab.js'
import { evolve } from '../src/lib/explorer.js'
import { ASX, SPREAD, STOCK_EXPLORE, US } from '../src/lib/stocks.js'
import { sharesHandler } from './_lib/sharesrun.js'

export default sharesHandler({
  sid: 'stocks-explore', list: [...US.map(s => [s, 'US']), ...ASX.map(s => [s, 'ASX'])], accounts: STOCK_EXPLORE.accounts, spread: SPREAD,
  stepFn: (s, m, now) => step(s, m, now, STOCK_EXPLORE, { discover: evolve }),
})
