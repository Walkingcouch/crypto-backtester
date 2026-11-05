"""
Strategies. Each is a plain function:  f(df, **params) -> pd.Series of target exposure (0..1)

Write rules so they're COMPLETELY explicit - no discretion. The value on a bar must only
use data up to and including that bar's close (the engine checks this).

Each strategy registers a parameter grid used for in-sample optimisation.
Keep grids SMALL: the more combinations you try, the more likely the "best" one is luck.
"""
import numpy as np
import pandas as pd

REGISTRY = {}


def register(name, grid):
    def deco(fn):
        REGISTRY[name] = {"fn": fn, "grid": grid, "doc": (fn.__doc__ or "").strip()}
        return fn
    return deco


@register("buy_and_hold", grid={})
def buy_and_hold(df):
    """Benchmark. Buy on the first bar, hold forever. Every strategy must beat this
    on risk-adjusted terms (Sharpe / max drawdown), otherwise why bother."""
    return pd.Series(1.0, index=df.index)


@register("sma_cross", grid={"fast": [10, 20, 50], "slow": [100, 150, 200]})
def sma_cross(df, fast=20, slow=100):
    """BASELINE trend-following.
    Entry: close-based fast SMA crosses above slow SMA -> 100% invested.
    Exit:  fast SMA below slow SMA -> 100% cash.
    Sizing: all-in / all-out."""
    if fast >= slow:
        return pd.Series(0.0, index=df.index)
    f = df["close"].rolling(fast).mean()
    s = df["close"].rolling(slow).mean()
    return (f > s).astype(float)


@register("donchian", grid={"entry": [20, 55], "exit": [10, 20]})
def donchian(df, entry=55, exit=20):
    """Breakout trend-following (Turtle style).
    Entry: close above the highest high of the previous `entry` bars -> invested.
    Exit:  close below the lowest low of the previous `exit` bars -> cash.
    Sizing: all-in / all-out."""
    hi = df["high"].rolling(entry).max().shift(1)   # shift(1): previous bars only
    lo = df["low"].rolling(exit).min().shift(1)
    pos = np.zeros(len(df))
    state = 0.0
    c = df["close"].to_numpy()
    for i in range(len(df)):
        if state == 0 and c[i] > hi.iloc[i]:
            state = 1.0
        elif state == 1 and c[i] < lo.iloc[i]:
            state = 0.0
        pos[i] = state
    return pd.Series(pos, index=df.index)


@register("sma_cross_voltarget",
          grid={"fast": [20, 50], "slow": [100, 200], "target_vol": [0.4, 0.6]})
def sma_cross_voltarget(df, fast=20, slow=100, target_vol=0.5, vol_window=30):
    """Baseline + POSITION SIZING. Same entry/exit as sma_cross, but when invested the
    exposure is target_vol / realised annualised volatility (capped at 100%).
    Holds less when the market is wild, more when it's calm."""
    trend = sma_cross(df, fast, slow)
    step_days = pd.Series(df.index).diff().median() / pd.Timedelta(days=1)
    ann = np.sqrt(365 / step_days)
    realised = df["close"].pct_change().rolling(vol_window).std() * ann
    size = (target_vol / realised).clip(upper=1.0).fillna(0.0)
    return trend * size


# ---------------------------------------------------------------------------
# Add your own strategies below. Template:
#
# @register("my_idea", grid={"lookback": [14, 28]})
# def my_idea(df, lookback=14):
#     """Entry: ...   Exit: ...   Sizing: ..."""
#     signal = ...   # use only .rolling(), .shift(1+), .ewm() - never .shift(-1)
#     return signal.astype(float)
# ---------------------------------------------------------------------------
