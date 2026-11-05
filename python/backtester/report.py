"""Builds a single self-contained HTML report (charts embedded)."""
from __future__ import annotations

import base64
import html
import io

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

PCT = {"total_return", "cagr", "volatility", "max_drawdown", "win_rate", "time_in_market"}
SHOW = ["total_return", "cagr", "sharpe", "sortino", "max_drawdown", "calmar",
        "trades", "win_rate", "fees_paid", "time_in_market"]


def fmt(k, v):
    if isinstance(v, float) and v != v:
        return "–"
    if k in PCT:
        return f"{v*100:.1f}%"
    if isinstance(v, float):
        return f"{v:,.2f}"
    return str(v)


def _png(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode()


def equity_chart(curves: dict, title: str):
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(9, 5.5), sharex=True,
                                 gridspec_kw={"height_ratios": [3, 1.3]})
    for name, eq in curves.items():
        a1.plot(eq.index, eq.values, label=name, lw=1.4)
        a2.plot(eq.index, (eq / eq.cummax() - 1) * 100, lw=1)
    a1.set_yscale("log"); a1.set_ylabel("Equity ($, log)"); a1.legend(frameon=False)
    a1.set_title(title, loc="left"); a1.grid(alpha=.25)
    a2.set_ylabel("Drawdown %"); a2.grid(alpha=.25)
    for a in (a1, a2):
        a.spines[["top", "right"]].set_visible(False)
    return _png(fig)


def table(rows: dict) -> str:
    head = "".join(f"<th>{html.escape(n)}</th>" for n in rows)
    body = ""
    for k in SHOW:
        body += f"<tr><td>{k.replace('_', ' ')}</td>" + "".join(
            f"<td>{fmt(k, m.get(k))}</td>" for m in rows.values()) + "</tr>"
    return f"<table><tr><th>metric</th>{head}</tr>{body}</table>"


def build(path, title, sections: list[tuple[str, str]], notes: list[str]):
    css = """body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:24px auto;
    padding:0 16px;color:#1b1f24;background:#fff}h1{font-size:22px}h2{font-size:17px;
    margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:4px}
    table{border-collapse:collapse;width:100%;font-size:14px;overflow-x:auto;display:block}
    td,th{padding:5px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap}
    td:first-child,th:first-child{text-align:left}img{max-width:100%}
    .warn{background:#fff4d6;border-left:4px solid #e0a400;padding:8px 12px;margin:8px 0}
    .note{color:#555;font-size:13px}"""
    notes_html = "".join(f"<div class='warn'>{html.escape(n)}</div>" for n in notes)
    body = "".join(f"<h2>{html.escape(h)}</h2>{c}" for h, c in sections)
    doc = (f"<!doctype html><html><head><meta charset='utf-8'>"
           f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
           f"<title>{html.escape(title)}</title><style>{css}</style></head><body>"
           f"<h1>{html.escape(title)}</h1>{notes_html}{body}"
           f"<p class='note'>Backtests are simulations on past data, not predictions. "
           f"Not financial advice.</p></body></html>")
    with open(path, "w", encoding="utf-8") as f:
        f.write(doc)


def img(b64):
    return f"<img src='data:image/png;base64,{b64}'>"


def trades_html(trades: pd.DataFrame, limit=40):
    if trades is None or not len(trades):
        return "<p>No trades.</p>"
    t = trades.tail(limit).copy()
    t["time"] = pd.to_datetime(t["time"]).dt.strftime("%Y-%m-%d %H:%M")
    return t[["time", "side", "qty", "price", "fee", "cash_after"]].to_html(
        index=False, float_format=lambda x: f"{x:,.4f}", border=0)
