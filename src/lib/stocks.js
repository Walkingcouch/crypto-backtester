// Stocks Lab: the same swing loop as the crypto Lab (lab.js), on daily bars of large US and ASX
// shares, paper-traded at Interactive Brokers' real fees (the broker picked for bots: full API,
// unattended orders, ASX + US in one account, paper account included).
import { LAB, shareRuleSet } from './lab.js'

// The S&P 100 and ASX 50 (today's members) plus the index funds used as benchmarks. A list of
// today's big companies flatters back-tests (survivorship bias: the ones that shrank or were taken
// over aren't in it). The professional fix is point-in-time index membership with delisted shares
// (e.g. Norgate Data); until then, treat results as optimistic.
export const US = ['SPY', 'QQQ', 'IWM', 'DIA',
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'BRK-B', 'AVGO', 'TSLA', 'LLY', 'JPM', 'V', 'UNH', 'XOM', 'MA', 'COST', 'HD', 'PG',
  'JNJ', 'WMT', 'ABBV', 'NFLX', 'BAC', 'CRM', 'ORCL', 'KO', 'CVX', 'MRK', 'AMD', 'PEP', 'TMO', 'ADBE', 'LIN', 'ACN', 'MCD', 'CSCO',
  'ABT', 'WFC', 'DIS', 'IBM', 'GE', 'QCOM', 'TXN', 'INTU', 'AMGN', 'PM', 'CAT', 'VZ', 'ISRG', 'NOW', 'DHR', 'GS', 'NEE', 'SPGI', 'RTX',
  'CMCSA', 'PFE', 'UNP', 'T', 'LOW', 'AMAT', 'HON', 'BKNG', 'UBER', 'AXP', 'COP', 'MS', 'BLK', 'PLD', 'SBUX', 'ELV', 'NKE', 'MDT',
  'BMY', 'LMT', 'DE', 'C', 'GILD', 'SCHW', 'MO', 'ADP', 'AMT', 'CB', 'MDLZ', 'SO', 'BA', 'INTC', 'UPS', 'DUK', 'CL', 'MMM', 'TGT',
  'USB', 'PYPL', 'CVS', 'GD', 'EMR', 'F', 'GM', 'MET', 'COF', 'BK', 'AIG', 'SPG']
export const ASX = ['IOZ', 'VAS', 'STW',
  'BHP', 'CBA', 'CSL', 'NAB', 'WBC', 'ANZ', 'WES', 'MQG', 'FMG', 'WDS', 'TLS', 'RIO', 'GMG', 'TCL', 'WOW', 'ALL', 'QBE', 'COL',
  'STO', 'REA', 'XRO', 'WTC', 'PME', 'SUN', 'IAG', 'RMD', 'BXB', 'NST', 'ORG', 'SHL', 'CPU', 'SCG', 'ASX', 'JBH', 'EVN', 'AMC',
  'S32', 'MIN', 'PLS', 'COH', 'SGP', 'VCX', 'TLC', 'QAN', 'RHC', 'TWE', 'APA', 'CAR', 'SEK', 'QUB', 'LYC'].map(s => `${s}.AX`)

// Interactive Brokers Australia, checked 17 Nov 2026 (interactivebrokers.com.au commissions page).
//  US shares, IBKR Pro tiered: US$0.0035 a share, min US$0.35, max 1% of the order, plus exchange,
//  clearing and regulatory pass-through fees (about US$0.0005 a share, included below).
//  ASX shares, tiered: 0.08% of the order, min A$5, plus GST for Australian residents (A$5.50).
export const STOCK_ACCOUNTS = [
  { id: 'ibus', owner: 'IBKR · US', broker: 'ibkr', exchange: 'Interactive Brokers · US shares', market: 'US',
    fee: 0, perShareUsd: 0.004, minFeeUsd: 0.35, maxFeePct: 0.01, feeLabel: 'US$0.0035/share + exchange fees, min US$0.35', startAud: 10000 },
  { id: 'ibasx', owner: 'IBKR · ASX', broker: 'ibkr', exchange: 'Interactive Brokers · ASX shares', market: 'ASX',
    fee: 0.00088, minFeeAud: 5.5, feeLabel: '0.08% + GST, min A$5.50 an order', startAud: 10000 },
]
// Typical gap between the best buy and sell price for these names (no free live order book).
export const SPREAD = { US: 0.0003, ASX: 0.001 }

export const STOCK = {
  ...LAB,
  accounts: STOCK_ACCOUNTS,
  margin: 0.002,          // safety margin in the cost gate (0.2%)
  slippage: 0.0005,       // per side, large caps at the close
  maxPosition: 0.2,       // bigger slices than crypto: minimum fees make small orders expensive
  maxOpen: 6,
  maxInvested: 0.8,
  refCost: 0.004,         // round trip used when choosing rules (fees, spread, slippage)
  daysPerBar: 1.4,        // 5 trading days a week: a 10-day hold is about 14 calendar days
  ruleSet: shareRuleSet,   // 19 rules built for shares (see lab.js); crypto-only rules left out
  benchmarks: { US: 'SPY', ASX: 'STW.AX' },   // every rule is judged on beating the index over the same days
  refCostBy: { US: 0.002, ASX: 0.005 },   // realistic round trips: US large caps vs ASX (min fee, wider spread)
  minTrainT: 3,           // higher bar because many rules are tried (Harvey, Liu & Zhu 2016)
  minTrain: 60, minValid: 30,
}

// The idea factory (explorer.js) on the same shares and accounts. "Bitcoin's trend" becomes the
// market's own trend: the S&P 500 fund (SPY) for US shares, the ASX 200 fund (STW) for ASX shares.
import { EXPLORE } from './explorer.js'
export const STOCK_EXPLORE = {
  ...EXPLORE,
  accounts: STOCK_ACCOUNTS,
  margin: STOCK.margin, slippage: STOCK.slippage, maxPosition: STOCK.maxPosition, maxOpen: STOCK.maxOpen,
  maxInvested: STOCK.maxInvested, refCost: STOCK.refCost, daysPerBar: STOCK.daysPerBar,
}
