// Strategy cards: for each family of rule, why it might make money (who is on the losing side) and
// the market that kills it. Shown next to every rule so a backtest number never stands alone.
export const CARDS = {
  // crypto and shares, daily
  breakout: { edge: 'Prices that break to new highs tend to keep going for a while: traders react slowly and late buyers chase.', fails: 'Choppy, sideways markets: breakouts fail and reverse, and every false start pays fees.' },
  dip: { edge: 'Sharp short-term drops in an uptrend are often forced or panicked selling that reverses.', fails: 'The start of a real downtrend: the "dip" keeps falling and the stop takes the loss.' },
  surge: { edge: 'Strong recent winners keep attracting buyers (momentum).', fails: 'Sharp reversals and blow-off tops, when everyone who wanted to buy already has.' },
  crash: { edge: 'Extreme falls overshoot as leveraged traders are liquidated; the bounce rewards whoever provides liquidity.', fails: 'Crashes driven by real bad news (hacks, failures) that keep going.' },
  combo: { edge: 'A combination found by the idea factory. Treat with extra suspicion: it was found by searching, not reasoned first.', fails: 'Any market unlike the one it was found in. Searched combinations are the most likely to be luck.' },
  xmom: { edge: '12-month winners keep beating losers (one of the most replicated effects in finance): investors under-react to news.', fails: 'Momentum crashes: sharp market rebounds when beaten-down shares jump (2009, 2020).' },
  xrev: { edge: 'Last month\'s biggest losers bounce as short-term selling pressure fades.', fails: 'Losers with real bad news keep falling; costs eat much of the small edge.' },
  lowvol: { edge: 'Calm shares earn about as much as wild ones with less risk: many investors overpay for excitement.', fails: 'Fast rallies led by risky shares, when calm shares lag the index.' },
  trend: { edge: 'Holding only what is above its long-term average sidesteps most of the big bear markets.', fails: 'Sharp V-shaped markets: it sells near the bottom and buys back higher.' },
  rsi2: { edge: 'Very short-term oversold readings in an uptrend tend to bounce within days.', fails: 'Widely known and heavily traded since the 2000s; the edge may be gone after costs.' },
  tom: { edge: 'Money flows into shares around month-end (pay days, fund rebalancing).', fails: 'One of the weakest effects in replication studies; easy to over-fit.' },
  hi52: { edge: 'Investors anchor on the 52-week high and are slow to push prices through it.', fails: 'Market tops, when stocks near highs are the most crowded.' },
  down3: { edge: 'Three down days in an uptrend often marks short-term exhaustion.', fails: 'Trend changes, when three down days become ten.' },
  // intraday
  imom: { edge: 'The day\'s early move predicts its last hours as slower traders and hedgers act late (documented on SPY).', fails: 'Quiet days with no early move, and any market where costs exceed the small late-day move.' },
  rev: { edge: 'An unusually hard 1-hour fall is often forced selling that partly reverses.', fails: 'News-driven falls, and market-wide sell-offs where everything keeps dropping.' },
  orb: { edge: 'A break of the opening range shows the day\'s direction has been chosen.', fails: 'Range-bound days: false breakouts reverse. Usually needs finer bars than hourly.' },
  volbo: { edge: 'Calm is followed by expansion: a big move off the open often continues for the day.', fails: 'Choppy markets with many false starts; costs per trade are high relative to the move.' },
  mr: { edge: 'In calm markets, sharp dips below the 24-hour average tend to snap back.', fails: 'When calm turns to trend: the dip is the start of a bigger move.' },
  gap: { edge: 'Large opening gaps down often partly fill as overnight panic fades.', fails: 'Gaps caused by real news (earnings, downgrades), which keep going.' },
}
export const cardFor = kind => CARDS[kind] || null
