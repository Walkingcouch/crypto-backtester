"""
Core backtesting engine.

Rules the engine enforces (so results can't quietly cheat):
  * A strategy returns a TARGET EXPOSURE per bar (0.0 = all cash, 1.0 = fully invested),
    computed using data up to and including that bar's close.
  * That target is executed at the NEXT bar's open, never the same bar.
  * Every fill pays slippage (worse price) and a fee (% of trade value).
  * Cash, units held, equity, and every trade are tracked explicitly.
  * Long-only, no leverage (crypto spot, like CoinSpot / most exchanges).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd

Strategy = Callable[..., pd.Series]


@dataclass
class Costs:
    fee_rate: float = 0.001        # 0.10% per trade - set to YOUR exchange's actual fee
    slippage_rate: float = 0.0005  # 0.05% worse than the open price on every fill


@dataclass
class Result:
    equity: pd.Series
    exposure: pd.Series
    trades: pd.DataFrame
    metrics: dict
    params: dict = field(default_factory=dict)


REQUIRED_COLS = ["open", "high", "low", "close", "volume"]


def validate_data(df: pd.DataFrame) -> pd.DataFrame:
    missing = [c for c in REQUIRED_COLS if c not in df.columns]
    if missing:
        raise ValueError(f"data is missing columns: {missing}")
    if not isinstance(df.index, pd.DatetimeIndex):
        raise ValueError("data index must be a DatetimeIndex (timestamps)")
    if not df.index.is_monotonic_increasing:
        df = df.sort_index()
    if df.index.has_duplicates:
        df = df[~df.index.duplicated(keep="first")]
    if df[REQUIRED_COLS].isna().any().any():
        raise ValueError("data contains NaN prices - clean it first")
    if (df[["open", "high", "low", "close"]] <= 0).any().any():
        raise ValueError("data contains non-positive prices")
    return df


def bars_per_year(index: pd.DatetimeIndex) -> float:
    step = pd.Series(index).diff().median()
    return pd.Timedelta(days=365) / step  # crypto trades 24/7


def run_backtest(
    df: pd.DataFrame,
    strategy: Strategy,
    params: dict | None = None,
    initial_cash: float = 1000.0,
    costs: Costs | None = None,
    rebalance_threshold: float = 0.05,
) -> Result:
    """Simulate a strategy bar by bar.

    rebalance_threshold: ignore target changes smaller than this (as a fraction of
    equity) so tiny adjustments don't bleed fees.
    """
    params = params or {}
    costs = costs or Costs()
    df = validate_data(df)

    target = strategy(df, **params)
    target = target.reindex(df.index).fillna(0.0).clip(0.0, 1.0).to_numpy()

    opens = df["open"].to_numpy()
    closes = df["close"].to_numpy()
    n = len(df)

    cash, units = float(initial_cash), 0.0
    equity = np.empty(n)
    exposure = np.empty(n)
    trades = []

    for i in range(n):
        if i > 0:
            want = target[i - 1]          # decided at previous close
            price = opens[i]              # executed at this open
            eq_now = cash + units * price
            held_frac = (units * price / eq_now) if eq_now > 0 else 0.0

            if abs(want - held_frac) > rebalance_threshold or (want == 0 and units > 0):
                delta_value = want * eq_now - units * price
                if delta_value > 0:  # BUY
                    fill = price * (1 + costs.slippage_rate)
                    spend = cash if want >= 1.0 else min(delta_value, cash)
                    qty = spend / (fill * (1 + costs.fee_rate))
                    fee = spend - qty * fill
                    cash -= spend
                    units += qty
                    side = "BUY"
                else:                # SELL
                    fill = price * (1 - costs.slippage_rate)
                    qty = units if want <= 0.0 else min(-delta_value / price, units)
                    gross = qty * fill
                    fee = gross * costs.fee_rate
                    cash += gross - fee
                    units -= qty
                    side = "SELL"
                if qty > 0:
                    trades.append(dict(time=df.index[i], side=side, qty=qty,
                                       price=fill, fee=fee, cash_after=cash,
                                       units_after=units))

        equity[i] = cash + units * closes[i]
        exposure[i] = units * closes[i] / equity[i] if equity[i] > 0 else 0.0

    eq = pd.Series(equity, index=df.index, name="equity")
    ex = pd.Series(exposure, index=df.index, name="exposure")
    tr = pd.DataFrame(trades, columns=["time", "side", "qty", "price", "fee",
                                       "cash_after", "units_after"])
    return Result(eq, ex, tr, compute_metrics(eq, ex, tr, initial_cash), params)


def round_trips(trades: pd.DataFrame) -> list[float]:
    """Return % P&L for each entry->full-exit cycle (net of fees)."""
    out, cost, proceeds = [], 0.0, 0.0
    for _, t in trades.iterrows():
        if t.side == "BUY":
            cost += t.qty * t.price + t.fee
        else:
            proceeds += t.qty * t.price - t.fee
            if t.units_after <= 1e-12 and cost > 0:
                out.append(proceeds / cost - 1)
                cost, proceeds = 0.0, 0.0
    return out


def compute_metrics(eq: pd.Series, ex: pd.Series, trades: pd.DataFrame,
                    initial_cash: float) -> dict:
    rets = eq.pct_change().dropna()
    bpy = bars_per_year(eq.index)
    years = max((eq.index[-1] - eq.index[0]).days / 365.0, 1e-9)
    total = eq.iloc[-1] / initial_cash - 1
    growth = eq.iloc[-1] / initial_cash
    cagr = float(np.expm1(min(np.log(growth) / years, 50))) if growth > 0 else -1.0
    vol = rets.std() * np.sqrt(bpy)
    sharpe = (rets.mean() * bpy) / vol if vol > 0 else 0.0
    downside = rets[rets < 0].std() * np.sqrt(bpy)
    sortino = (rets.mean() * bpy) / downside if downside and downside > 0 else 0.0
    dd = eq / eq.cummax() - 1
    max_dd = dd.min()
    rts = round_trips(trades)
    return {
        "final_equity": float(eq.iloc[-1]),
        "total_return": float(total),
        "cagr": float(cagr),
        "volatility": float(vol),
        "sharpe": float(sharpe),
        "sortino": float(sortino),
        "max_drawdown": float(max_dd),
        "calmar": float(cagr / abs(max_dd)) if max_dd < 0 else 0.0,
        "trades": int(len(trades)),
        "round_trips": len(rts),
        "win_rate": float(np.mean([r > 0 for r in rts])) if rts else float("nan"),
        "fees_paid": float(trades["fee"].sum()) if len(trades) else 0.0,
        "time_in_market": float((ex > 0.01).mean()),
        "years": float(years),
    }


def check_no_lookahead(df: pd.DataFrame, strategy: Strategy, params: dict | None = None,
                       checkpoints: int = 8, tol: float = 1e-9) -> None:
    """Catch strategies that peek at future bars.

    Recomputes the signal on data truncated at several points and checks that the
    signal at each cut-off bar is identical to the full-data signal. If a strategy
    uses future data (e.g. shift(-1), centred rolling windows), they will differ.
    """
    params = params or {}
    full = strategy(df, **params).reindex(df.index).fillna(0.0)
    n = len(df)
    for cut in np.linspace(n // 4, n - 2, checkpoints).astype(int):
        part = strategy(df.iloc[: cut + 1], **params).reindex(df.index[: cut + 1]).fillna(0.0)
        a, b = float(full.iloc[cut]), float(part.iloc[-1])
        if abs(a - b) > tol:
            raise AssertionError(
                f"LOOKAHEAD DETECTED at {df.index[cut]}: signal with full data={a:.4f}, "
                f"with data only up to that bar={b:.4f}. The strategy is using future prices.")
