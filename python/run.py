#!/usr/bin/env python3
"""
Backtest runner.

  1) Develop (train period only - safe to run as often as you like):
       python run.py --data data/BTC_USDT_1d.csv --strategy sma_cross

  2) When you're DONE tweaking, spend the unseen test period once:
       python run.py --data data/BTC_USDT_1d.csv --strategy sma_cross --evaluate-test

Every --evaluate-test run is written to test_ledger.json so repeated peeking is flagged.
"""
import argparse

import pandas as pd

from backtester import Costs, REGISTRY, check_no_lookahead, run_backtest
from backtester import report
from backtester.research import evaluate, optimise, record_test_use, split


def load_csv(path):
    df = pd.read_csv(path)
    tcol = next(c for c in df.columns if c.lower() in ("timestamp", "time", "date", "datetime"))
    ts = df[tcol]
    if pd.api.types.is_numeric_dtype(ts):
        big = float(ts.abs().max())  # guess epoch unit from magnitude
        unit = "s" if big < 1e11 else "ms" if big < 1e14 else "us" if big < 1e17 else "ns"
        df.index = pd.to_datetime(ts, unit=unit, utc=True)
    else:
        df.index = pd.to_datetime(ts, utc=True)
    df.columns = [c.lower() for c in df.columns]
    return df[["open", "high", "low", "close", "volume"]].astype(float)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="CSV with timestamp,open,high,low,close,volume")
    ap.add_argument("--strategy", default="sma_cross", choices=sorted(REGISTRY))
    ap.add_argument("--cash", type=float, default=200.0)
    ap.add_argument("--fee", type=float, default=0.001, help="fee per trade, 0.001 = 0.1%%")
    ap.add_argument("--slippage", type=float, default=0.0005)
    ap.add_argument("--test-start", help="e.g. 2025-01-01 (default: last 30%% of data)")
    ap.add_argument("--score", default="sharpe", help="metric used to pick params on train")
    ap.add_argument("--evaluate-test", action="store_true",
                    help="run the chosen params on the held-out test period (logged)")
    ap.add_argument("--out", default="report.html")
    a = ap.parse_args()

    df = load_csv(a.data)
    costs = Costs(a.fee, a.slippage)
    train, test = split(df, a.test_start)
    name, spec = a.strategy, REGISTRY[a.strategy]
    bh = REGISTRY["buy_and_hold"]["fn"]

    print(f"Data {df.index[0].date()} -> {df.index[-1].date()}  ({len(df)} bars)")
    print(f"Train {train.index[0].date()} -> {train.index[-1].date()} | "
          f"Test {test.index[0].date()} -> {test.index[-1].date()} (locked)")

    # --- 1. in-sample: optimise on train only
    grid = optimise(train, name, costs, a.cash, a.score)
    best = {k: (int(v) if float(v).is_integer() else float(v))
            for k, v in grid.iloc[0][list(spec["grid"])].items()} if spec["grid"] else {}
    check_no_lookahead(train, spec["fn"], best)
    tr_res = run_backtest(train, spec["fn"], best, a.cash, costs)
    tr_bh = run_backtest(train, bh, {}, a.cash, costs)
    print(f"\nBest train params ({a.score}): {best}")
    for k in ("total_return", "sharpe", "max_drawdown", "trades"):
        print(f"  {k:>14}: strategy {report.fmt(k, tr_res.metrics[k]):>9} | "
              f"buy&hold {report.fmt(k, tr_bh.metrics[k]):>9}")

    notes = [f"Combinations tried on train: {len(grid)}. More combinations = higher "
             f"chance the winner is luck. Check that neighbouring params also do well."]
    sections = [
        ("Setup", f"<p>Strategy <b>{name}</b> — {spec['doc']}</p>"
                  f"<p>Start cash ${a.cash:,.0f}. Fee {a.fee*100:.2f}%, slippage "
                  f"{a.slippage*100:.2f}% per fill. Signals at bar close, filled next open.</p>"
                  f"<p>Train {train.index[0].date()} → {train.index[-1].date()}; "
                  f"Test {test.index[0].date()} → {test.index[-1].date()}.</p>"),
        ("Train (in-sample) — best params " + str(best),
         report.img(report.equity_chart({name: tr_res.equity, "buy & hold": tr_bh.equity},
                                        "Train period"))
         + report.table({name: tr_res.metrics, "buy & hold": tr_bh.metrics})),
    ]
    if spec["grid"]:
        cols = list(spec["grid"]) + ["sharpe", "total_return", "max_drawdown", "trades"]
        sections.append(("Parameter grid (train only)",
                         grid[cols].to_html(index=False, border=0, float_format=lambda x: f"{x:.3f}")))

    # --- 2. out-of-sample: only when explicitly requested
    if a.evaluate_test:
        te = evaluate(df, test, name, best, costs, a.cash)
        te_bh = evaluate(df, test, "buy_and_hold", {}, costs, a.cash)
        notes += record_test_use(name, best, test, te.metrics)
        print("\nTEST (unseen) results:")
        for k in ("total_return", "sharpe", "max_drawdown", "trades"):
            print(f"  {k:>14}: strategy {report.fmt(k, te.metrics[k]):>9} | "
                  f"buy&hold {report.fmt(k, te_bh.metrics[k]):>9}")
        decay = te.metrics["sharpe"] - tr_res.metrics["sharpe"]
        sections.append(("Test (unseen) — the result that counts",
                         f"<p>Sharpe change train→test: {decay:+.2f}</p>"
                         + report.img(report.equity_chart(
                             {name: te.equity, "buy & hold": te_bh.equity}, "Test period"))
                         + report.table({name: te.metrics, "buy & hold": te_bh.metrics})))
        sections.append(("Test trades (last 40)", report.trades_html(te.trades)))
    else:
        notes.append("Test period not evaluated yet (locked). Finish developing on train, "
                     "then re-run with --evaluate-test.")
        sections.append(("Train trades (last 40)", report.trades_html(tr_res.trades)))

    for n in notes:
        print("NOTE:", n)
    report.build(a.out, f"Backtest — {name}", sections, notes)
    print(f"\nReport written to {a.out}")


if __name__ == "__main__":
    main()
