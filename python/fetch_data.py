#!/usr/bin/env python3
"""
Download historical candles (OHLCV) from a public exchange API. No account or API key needed.

  pip install ccxt pandas
  python fetch_data.py --exchange binance --symbol BTC/USDT --timeframe 1d --since 2018-01-01
  python fetch_data.py --exchange kraken  --symbol BTC/AUD  --timeframe 1d

Writes data/<SYMBOL>_<TIMEFRAME>.csv. Note: some exchanges (e.g. Kraken) only return
recent candles; Binance gives full history.
"""
import argparse
import os
import time

import pandas as pd


def main():
    import ccxt
    ap = argparse.ArgumentParser()
    ap.add_argument("--exchange", default="binance")
    ap.add_argument("--symbol", default="BTC/USDT")
    ap.add_argument("--timeframe", default="1d")
    ap.add_argument("--since", default="2018-01-01")
    a = ap.parse_args()

    ex = getattr(ccxt, a.exchange)({"enableRateLimit": True})
    since = ex.parse8601(f"{a.since}T00:00:00Z")
    step = ex.parse_timeframe(a.timeframe) * 1000
    rows = []
    while True:
        batch = ex.fetch_ohlcv(a.symbol, a.timeframe, since=since, limit=1000)
        if not batch:
            break
        rows += batch
        print(f"  {len(rows)} candles, up to {ex.iso8601(batch[-1][0])}")
        since = batch[-1][0] + step
        if since > ex.milliseconds() or len(batch) < 2:
            break
        time.sleep(ex.rateLimit / 1000)

    df = pd.DataFrame(rows, columns=["timestamp", "open", "high", "low", "close", "volume"])
    df = df.drop_duplicates("timestamp").sort_values("timestamp")
    # drop the still-forming last candle
    df = df[df["timestamp"] + step <= ex.milliseconds()]
    os.makedirs("data", exist_ok=True)
    out = f"data/{a.symbol.replace('/', '_')}_{a.timeframe}.csv"
    df.to_csv(out, index=False)
    print(f"Saved {len(df)} candles to {out}")


if __name__ == "__main__":
    main()
