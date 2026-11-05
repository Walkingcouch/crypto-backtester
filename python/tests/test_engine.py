"""Run:  python -m pytest -q   (or: python tests/test_engine.py)"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backtester import Costs, REGISTRY, check_no_lookahead, run_backtest  # noqa: E402


def make(prices_open, prices_close=None):
    o = np.array(prices_open, float)
    c = np.array(prices_close if prices_close is not None else prices_open, float)
    idx = pd.date_range("2024-01-01", periods=len(o), freq="D", tz="UTC")
    return pd.DataFrame({"open": o, "high": np.maximum(o, c), "low": np.minimum(o, c),
                         "close": c, "volume": 1.0}, index=idx)


def random_walk(n=600, seed=1):
    r = np.random.default_rng(seed).normal(0.0005, 0.03, n)
    c = 100 * np.exp(np.cumsum(r))
    o = np.r_[100, c[:-1]]
    return make(o, c)


def test_executes_next_bar_open():
    df = make([10, 20, 30, 40], [11, 21, 31, 41])
    sig = lambda d: pd.Series([1, 1, 1, 1], index=d.index, dtype=float)
    r = run_backtest(df, sig, initial_cash=100, costs=Costs(0, 0))
    assert r.trades.iloc[0]["time"] == df.index[1]       # signal bar 0 -> trade bar 1
    assert r.trades.iloc[0]["price"] == 20               # at bar 1's OPEN, not bar 0 close
    assert abs(r.equity.iloc[-1] - 100 / 20 * 41) < 1e-9


def test_fees_and_slippage_round_trip():
    df = make([100, 100, 100, 100])
    sig = lambda d: pd.Series([1, 0, 0, 0], index=d.index, dtype=float)
    r = run_backtest(df, sig, initial_cash=1000, costs=Costs(0.01, 0.01))
    expected = 1000 / (1.01 * 1.01) * 0.99 * 0.99   # buy: slip+fee, sell: slip+fee
    assert abs(r.equity.iloc[-1] - expected) < 1e-6
    assert len(r.trades) == 2 and r.metrics["round_trips"] == 1


def test_cash_never_negative_and_no_shorting():
    df = random_walk()
    fn = REGISTRY["sma_cross_voltarget"]["fn"]
    r = run_backtest(df, fn, {"fast": 20, "slow": 100, "target_vol": 0.5})
    assert (r.trades["cash_after"] >= -1e-9).all()
    assert (r.trades["units_after"] >= -1e-12).all()
    assert r.exposure.max() <= 1 + 1e-9


def test_lookahead_is_detected():
    df = random_walk()
    cheat = lambda d: (d["close"].shift(-1) > d["close"]).astype(float)  # peeks tomorrow
    try:
        check_no_lookahead(df, cheat)
    except AssertionError as e:
        assert "LOOKAHEAD" in str(e)
    else:
        raise AssertionError("cheating strategy was not caught")
    # and the cheat would look amazing, which is exactly why the check matters
    assert run_backtest(df, cheat, costs=Costs(0, 0)).metrics["sharpe"] > 5


def test_builtin_strategies_have_no_lookahead():
    df = random_walk()
    for name, spec in REGISTRY.items():
        from backtester.research import grid
        for p in grid(spec["grid"]):
            check_no_lookahead(df, spec["fn"], p)


if __name__ == "__main__":
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            v(); print("ok", k)
