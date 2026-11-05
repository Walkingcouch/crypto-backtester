#!/usr/bin/env python3
"""Synthetic BTC-like daily prices (bull/bear regimes) for testing the engine offline.
NOT real data - use fetch_data.py for anything you'll make decisions on."""
import os

import numpy as np
import pandas as pd

rng = np.random.default_rng(42)
n = 2500
regime_drift = np.repeat(rng.choice([0.004, -0.003, 0.0005], size=n // 125 + 1,
                                    p=[0.4, 0.3, 0.3]), 125)[:n]
r = regime_drift + rng.standard_t(4, n) * 0.025
close = 10000 * np.exp(np.cumsum(r))
open_ = np.r_[close[0], close[:-1]] * (1 + rng.normal(0, 0.002, n))
high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.015, n)))
low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.015, n)))
idx = pd.date_range("2019-01-01", periods=n, freq="D", tz="UTC")
os.makedirs("data", exist_ok=True)
pd.DataFrame({"timestamp": ((idx - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(milliseconds=1)), "open": open_, "high": high, "low": low,
              "close": close, "volume": rng.uniform(1e3, 5e3, n)}).to_csv(
    "data/SAMPLE_synthetic_1d.csv", index=False)
print("wrote data/SAMPLE_synthetic_1d.csv")
