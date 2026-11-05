"""
Research workflow: develop on the TRAIN period only, then spend the TEST period once.

The test ledger (test_ledger.json) records every time a strategy is evaluated on the
held-out test period. If you tweak a strategy after seeing its test result and look
again, the ledger warns you: that data is no longer unseen, so you need fresh data
(e.g. wait for new months of prices, or paper-trade forward).
"""
from __future__ import annotations

import hashlib
import itertools
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .engine import Costs, check_no_lookahead, run_backtest
from .strategies import REGISTRY

LEDGER = Path("test_ledger.json")


def split(df: pd.DataFrame, test_start: str | None = None, test_frac: float = 0.3):
    if test_start:
        cut = pd.Timestamp(test_start, tz=df.index.tz)
    else:
        cut = df.index[int(len(df) * (1 - test_frac))]
    return df[df.index < cut], df[df.index >= cut]


def warmup_slice(df_full: pd.DataFrame, test: pd.DataFrame, warmup_bars: int):
    """Test data plus preceding warm-up bars so indicators (e.g. a 200-bar SMA) are
    ready on day one of the test. Results are then trimmed to the test period only."""
    start = df_full.index.get_loc(test.index[0])
    return df_full.iloc[max(0, start - warmup_bars):]


def grid(params_grid: dict):
    if not params_grid:
        yield {}
        return
    keys = list(params_grid)
    for combo in itertools.product(*(params_grid[k] for k in keys)):
        yield dict(zip(keys, combo))


def optimise(train: pd.DataFrame, name: str, costs: Costs, cash: float,
             score: str = "sharpe") -> pd.DataFrame:
    spec = REGISTRY[name]
    rows = []
    for p in grid(spec["grid"]):
        r = run_backtest(train, spec["fn"], p, cash, costs)
        rows.append({**p, **r.metrics})
    return pd.DataFrame(rows).sort_values(score, ascending=False).reset_index(drop=True)


def _hash_period(test: pd.DataFrame) -> str:
    raw = f"{test.index[0]}|{test.index[-1]}|{len(test)}|{test['close'].iloc[[0, -1]].tolist()}"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _source_hash(name: str) -> str:
    import inspect
    return hashlib.sha1(inspect.getsource(REGISTRY[name]["fn"]).encode()).hexdigest()[:12]


def record_test_use(name: str, params: dict, test: pd.DataFrame, metrics: dict) -> list[str]:
    ledger = json.loads(LEDGER.read_text()) if LEDGER.exists() else []
    period = _hash_period(test)
    code = _source_hash(name)
    warnings = []
    prior = [e for e in ledger if e["period"] == period and e["strategy"] == name]
    if prior:
        changed = any(e["code"] != code or e["params"] != params for e in prior)
        warnings.append(
            f"'{name}' has been evaluated on this test period {len(prior)} time(s) before"
            + (" AND its code/params changed since - this test data is no longer unseen. "
               "Treat this result as in-sample." if changed else "."))
    ledger.append(dict(time=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                       strategy=name, params=params, code=code, period=period,
                       test_from=str(test.index[0]), test_to=str(test.index[-1]),
                       sharpe=metrics["sharpe"], total_return=metrics["total_return"]))
    LEDGER.write_text(json.dumps(ledger, indent=2, default=str))
    return warnings


def evaluate(df_full, test, name, params, costs, cash, warmup_bars=250):
    """Run on test period (with indicator warm-up), report test-period-only stats."""
    from .engine import compute_metrics
    spec = REGISTRY[name]
    data = warmup_slice(df_full, test, warmup_bars)
    check_no_lookahead(data, spec["fn"], params)
    # Simulate from the first test bar: strategy sees warm-up history for indicators,
    # but trading starts with fresh cash on the first test bar.
    sig_full = spec["fn"](data, **params)
    first = data.index.get_loc(test.index[0])
    sig = sig_full.copy()
    sig.iloc[:max(first - 1, 0)] = 0.0  # signal at bar first-1 executes at first test open
    sub = data.iloc[max(first - 1, 0):]
    r = run_backtest(sub, lambda d, **_: sig.reindex(d.index), {}, cash, costs)
    eq = r.equity.loc[test.index[0]:]
    ex = r.exposure.loc[test.index[0]:]
    tr = r.trades[r.trades["time"] >= test.index[0]] if len(r.trades) else r.trades
    r.equity, r.exposure, r.trades = eq, ex, tr
    r.metrics = compute_metrics(eq, ex, tr, cash)
    r.params = params
    return r
