# Crypto Backtester

A small, honest backtesting engine for testing clearly defined crypto strategies before
risking money. It does **not** place trades — it tells you whether an idea would have
survived on past data, without fooling yourself.

## What it enforces

| Rule | How |
|---|---|
| Explicit entry/exit rules | A strategy is a Python function returning target exposure (0 = cash, 1 = all-in) per bar |
| Position sizing | Exposure can be fractional, e.g. volatility targeting (`sma_cross_voltarget`) |
| Realistic execution | Signal at bar close → filled at **next bar's open**, plus slippage and fee on every fill |
| Portfolio accounting | Cash, units, equity per bar, full trade log, fees paid. Long-only, no leverage |
| No peeking at the future | `check_no_lookahead` re-runs the strategy on truncated data and fails if signals change |
| Truly unseen test data | Params are optimised on the train period only. The test period is locked until you pass `--evaluate-test`, and every look is logged in `test_ledger.json` — re-testing after edits is flagged |
| A benchmark to beat | Every report compares against buy & hold |

## Quick start

```bash
pip install pandas numpy matplotlib ccxt

# 1. Get real data (public API, no account needed)
python fetch_data.py --exchange binance --symbol BTC/USDT --timeframe 1d --since 2018-01-01

# 2. Develop on the train period (run as often as you like)
python run.py --data data/BTC_USDT_1d.csv --strategy sma_cross --cash 200 --fee 0.001

# 3. When finished tweaking, spend the unseen test period ONCE
python run.py --data data/BTC_USDT_1d.csv --strategy sma_cross --evaluate-test

# Open report.html for charts, metrics, parameter grid and trade log
```

No internet? `python make_sample_data.py` makes synthetic prices to check everything runs
(results on synthetic data mean nothing).

Options: `--test-start 2025-01-01` (default: last 30% of data), `--slippage 0.0005`,
`--score sharpe|calmar|total_return`, `--out file.html`.

**Set `--fee` to your exchange's real fee.** Instant-buy / broker-style fees on retail
apps are often far higher than exchange "market" order fees, and that alone can turn a
winning backtest into a losing one.

## Built-in strategies (`backtester/strategies.py`)

- `buy_and_hold` — benchmark
- `sma_cross` — **the baseline**: fast SMA above slow SMA → in, else out
- `donchian` — breakout: buy N-bar highs, exit on M-bar lows
- `sma_cross_voltarget` — baseline with volatility-based position sizing

## Adding an idea (including AI-generated ones)

Add a function with `@register("name", grid={...})` at the bottom of `strategies.py`.
The rule for anything new: **it must beat `sma_cross` on the unseen test period**, not just
on train. Keep parameter grids small — trying 500 combinations guarantees one looks great
by luck. If you change a strategy after seeing its test result, that test data is spent;
validate on newer data (wait for more months, or paper-trade forward).

## Tests

```bash
python tests/test_engine.py
```

Checks next-bar execution, exact fee/slippage math, no negative cash or shorting,
that a cheating (future-peeking) strategy gets caught, and that built-ins are clean.

## Next steps (not built yet)

- Paper trading: run the chosen strategy live on new candles without real orders
- Live execution: needs an exchange with a trading API (ccxt supports many). Use API keys
  with **trade-only permission, withdrawals disabled**, and start with the $100–200 you
  were planning.

*Backtests are simulations on past data, not predictions. Not financial advice.*
