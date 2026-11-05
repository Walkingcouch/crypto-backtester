import { Link } from 'react-router-dom'

export default function Guide() {
  return (
    <main className="page">
      <div className="doc">
        <div className="page-head">
          <h1>Guide</h1>
          <p>How to use the backtester, how to read the results, and the rules that keep you from fooling yourself.</p>
          <div className="toc">
            <a href="#what">What it is</a><a href="#quick">Quick start</a><a href="#read">Reading results</a>
            <a href="#rules">The rules</a><a href="#unseen">Unseen test</a><a href="#accounts">Accounts</a>
            <a href="#own">Your own strategies</a><a href="#next">Next steps</a><a href="#faq">FAQ</a>
          </div>
        </div>

        <h2 id="what">What it is</h2>
        <p>A tool for testing clearly defined crypto trading strategies on past prices before risking real money. It does
          not trade, connect to your exchange, or need any API keys. Everything runs in your browser.</p>
        <p>The idea: start with a simple trend-following baseline, then require every new feature (including AI-generated ideas)
          to beat it on data it has <b>never seen</b>. Weak ideas get rejected before they cost you anything.</p>

        <h2 id="quick">Quick start</h2>
        <ol className="steps">
          <li><b>Open <Link to="/">Backtest</Link>.</b> Leave the market as <code>BTCUSDT</code>, candles on 1 day, history from 2018.</li>
          <li><b>Choose a strategy.</b> Start with <i>Trend baseline (SMA cross)</i>. Its exact entry, exit and sizing rules are shown under the picker.</li>
          <li><b>Set your costs.</b> Start cash (e.g. $200), your exchange's real fee per trade, and slippage (how much worse than the quoted price you fill — 0.05% is reasonable for big coins).</li>
          <li><b>Press Run backtest.</b> Prices download, the oldest ~70% become the <i>training period</i>, and every combination of the strategy's settings is tried on it. The best one is shown against buy &amp; hold.</li>
          <li><b>Look at the settings table.</b> Do the neighbours of the winner also do well? If only one exact setting works, it's probably luck.</li>
          <li><b>When you're done tweaking, reveal the unseen test.</b> The winning settings run on the most recent ~30% of prices they have never seen. That result is the one that counts, and it's recorded in the <Link to="/ledger">test ledger</Link>.</li>
          <li><b>Save the run</b> if you want to come back to it or show your partner.</li>
        </ol>

        <h2 id="read">Reading results</h2>
        <ul>
          <li><b>Total return</b> — how much $1 became. Easy to understand, easy to be fooled by.</li>
          <li><b>Sharpe</b> — return per unit of volatility, per year. Above 1 is good for a simple strategy; buy &amp; hold crypto is often around 0.5–1.2. This is the main score.</li>
          <li><b>Max drawdown</b> — the worst peak-to-bottom fall. Ask: could I actually sit through this without panicking?</li>
          <li><b>Calmar</b> — yearly return divided by max drawdown.</li>
          <li><b>Trades / fees</b> — more trades means more fees. A strategy that only wins before fees doesn't win.</li>
          <li><b>Win rate</b> — share of complete buy→sell cycles that made money. Trend strategies often win under 40% of trades but make it back on a few big runs.</li>
          <li><b>Time in market</b> — how often you're holding. Lower exposure with similar return means less risk.</li>
          <li><b>The chart</b> — log scale, so a steady line means steady % growth. The bottom panel is drawdown.</li>
        </ul>
        <p>Beating buy &amp; hold on <i>total return</i> is rare in a bull market. A trend strategy usually earns its keep by
          cutting the drawdowns — similar or slightly lower return with much smaller falls.</p>

        <h2 id="rules">The rules the engine enforces</h2>
        <ul>
          <li><b>Explicit rules only.</b> Every strategy is a fixed formula: when to buy, when to sell, how much. No judgement calls.</li>
          <li><b>No same-bar trading.</b> A decision made from today's closing price fills at <i>tomorrow's open</i>, with slippage and fee on every fill.</li>
          <li><b>No peeking.</b> Before every result the engine re-runs the strategy with future prices removed. If any signal changes, the run is rejected with "lookahead detected".</li>
          <li><b>Real accounting.</b> Cash, coins held, every trade and every fee are tracked. Long only, no leverage, no borrowing.</li>
          <li><b>Always a benchmark.</b> Every result is shown next to simply buying and holding.</li>
        </ul>

        <h2 id="unseen">The unseen test (why it's locked)</h2>
        <p>If you tweak a strategy after seeing its test result and then test again, the test period has quietly become
          part of your development. Do that ten times and you'll eventually find something that "works" on it by chance.</p>
        <p>So the test period stays locked until you click <b>Reveal</b>. Every reveal is written to the ledger with the strategy,
          its settings, fee and period. If the same strategy is revealed again on the same period with different settings,
          you get a warning that the result should be treated as in-sample. The ledger is append-only — reveals can't be edited or deleted.</p>
        <p>Once a period is spent, get fresh data: wait a few months for new prices, test a different coin, or paper-trade forward.</p>

        <h2 id="accounts">Accounts and sharing</h2>
        <p>You can use everything without an account; saved runs and the ledger then live in this browser only.</p>
        <p><Link to="/account">Sign in</Link> with your email (no password — you get a sign-in link) to:</p>
        <ul>
          <li>Keep saved runs across devices.</li>
          <li>Share one test ledger with your partner, so neither of you can quietly re-test until something looks good.</li>
          <li>See each other's saved runs (everyone signed in can read them; only the author can delete).</li>
        </ul>

        <h2 id="own">Testing your own strategies</h2>
        <p>The website has the built-in strategies. To write your own rules (including ones an AI suggests), use the Python
          version, which runs the identical engine on your computer:</p>
        <ol>
          <li><a href="/crypto-backtester-python.zip" download>Download the Python version</a> and unzip it.</li>
          <li>Install: <code>pip install pandas numpy matplotlib ccxt</code></li>
          <li>Get data: <code>python fetch_data.py --symbol BTC/USDT --timeframe 1d --since 2018-01-01</code></li>
          <li>Add a function at the bottom of <code>backtester/strategies.py</code> (template included).</li>
          <li>Develop: <code>python run.py --data data/BTC_USDT_1d.csv --strategy my_idea</code></li>
          <li>When finished: add <code>--evaluate-test</code> once. Open <code>report.html</code>.</li>
        </ol>
        <pre><code>{`@register("my_idea", grid={"lookback": [14, 28]})
def my_idea(df, lookback=14):
    """Entry: ...  Exit: ...  Sizing: ..."""
    momentum = df["close"].pct_change(lookback)
    return (momentum > 0).astype(float)   # 1 = hold, 0 = cash`}</code></pre>
        <p>Rule for new ideas: it must beat the trend baseline on the unseen test, not just on training. Keep the list of
          settings small — trying hundreds of combinations guarantees one looks great by luck.</p>

        <h2 id="next">Next steps</h2>
        <ol>
          <li><b>Baseline first.</b> Run the trend baseline on BTC and ETH and record the test results.</li>
          <li><b>One change at a time.</b> Volatility sizing, a different exit, an AI filter — each must improve the unseen result.</li>
          <li><b>Paper trade.</b> Run the winner forward on new candles without real money for a few months.</li>
          <li><b>Only then automate</b>, with a small amount ($100–200), on an exchange with a trading API.
            Use API keys with trading permission only and <b>withdrawals disabled</b>.</li>
        </ol>

        <h2 id="faq">FAQ</h2>
        <p><b>Where do prices come from?</b> Binance's public market-data API (USDT pairs). Type any Binance symbol, e.g. <code>LINKUSDT</code>.
          For other exchanges or AUD pairs, upload a CSV with columns <code>timestamp, open, high, low, close, volume</code>.</p>
        <p><b>Why is my result different from a friend's?</b> Different start date, fee, slippage or test split all change results. Saved runs record every setting.</p>
        <p><b>Does a good backtest mean it'll make money?</b> No. It means the idea wasn't obviously broken on past data. Markets change.
          Nothing here is financial advice.</p>
      </div>
    </main>
  )
}
