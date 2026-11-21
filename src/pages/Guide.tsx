import { Link } from 'react-router-dom'

export default function Guide() {
  return (
    <main className="page">
      <div className="doc">
        <div className="page-head">
          <h1>How it works</h1>
          <p>How to use the backtester, how to read the results, and the rules that keep you from fooling yourself.</p>
          <div className="toc">
            <a href="#what">What it is</a><a href="#quick">Quick start</a><a href="#exchange">Your exchange</a><a href="#markets">Markets</a><a href="#predict">Predictions</a><a href="#picks">Picks</a><a href="#lab">Crypto lab</a><a href="#shares">Shares lab</a><a href="#read">Reading results</a>
            <a href="#rules">The rules</a><a href="#unseen">Final check</a><a href="#accounts">Accounts</a>
            <a href="#own">Your own strategies</a><a href="#next">Next steps</a><a href="#faq">FAQ</a>
          </div>
        </div>

        <h2 id="what">What it is</h2>
        <p>A personal research site for crypto and shares: live market rankings, honest price-range forecasts with their own track record, and labs that paper-trade with pretend money to see which rules actually hold up after fees. It never places real orders, connects to your exchange, or needs API keys.</p>
        <p>The idea: every rule has to prove itself on data it has <b>never seen</b>, and after real costs, before it's trusted. Weak ideas get rejected before they cost you anything.</p>

        <h2 id="quick">Quick start</h2>
        <ol className="steps">
          <li><b>Browse <Link to="/markets">Markets</Link>.</b> Rank coins by return, risk or volume and compare up to 8 on one chart.</li>
          <li><b>Check a coin on <Link to="/predict">Predict</Link>.</b> See the realistic price range for the next week to 3 months, and how often the method has been right.</li>
          <li><b>See today's <Link to="/picks">Picks</Link>.</b> Coins whose past signals have held up, with a suggested stop-loss.</li>
          <li><b>Watch the labs.</b> The <Link to="/lab">Crypto lab</Link> and the <Link to="/shares">Shares lab</Link> each paper-trade three ways (swing rules, new ideas, day trading) and show exactly what they did and why.</li>
          <li><b>Tap the refresh button</b> (top right) for the latest numbers, handy when the site is saved to your phone's home screen.</li>
        </ol>

        <h2 id="exchange">Your exchange (e.g. CoinSpot) and currency</h2>
        <p>Pick where you actually trade, so the numbers match what you'd really pay: on Markets it's the <b>Your exchange</b> dropdown. Your choice is remembered.</p>
        <ul>
          <li><b>CoinSpot:</b> <i>Market / limit order</i> 0.1% per trade, or <i>Instant buy / sell</i> 1% (the quick Buy button). Markets shows CoinSpot's own live AUD prices and, by default, only coins listed on CoinSpot.</li>
          <li><b>Swyftx</b> 0.6% · <b>Independent Reserve</b> 0.5% · <b>BTC Markets</b> 0.85% (AUD markets, lowest tier) · <b>Kraken Pro</b> 0.80% market / 0.40% limit (lowest tier) · <b>Coinbase Advanced</b> 0.6% market / 0.4% limit (lowest tier) · <b>Binance</b> 0.1%.</li>
          <li>These are the published fees at the lowest volume tier, checked November 2026. Exchanges change fees, so type your own under "Other" if yours differs.</li>
        </ul>
        <p><b>Currency:</b> use the <b>AUD / USD</b> dropdown at the top of every page. In AUD:</p>
        <ul>
          <li>Today's prices use the live USDT→AUD rate (CoinGecko), or CoinSpot's own price when CoinSpot is your exchange.</li>
          <li>Backtests, returns and comparison charts convert each day at that day's official ECB USD→AUD rate. AUD results therefore include exchange-rate moves, just as your real AUD balance would.</li>
        </ul>
        <p className="muted">Price history comes from Binance, the world's deepest crypto market, because most Australian exchanges (including CoinSpot) don't publish full price history. Prices across big exchanges track each other closely.</p>

        <h2 id="markets">Markets: ranking and comparing coins</h2>
        <p>The <Link to="/markets">Markets</Link> page lists every actively traded coin on Binance (USDT pairs) and ranks them.</p>
        <ul>
          <li><b>Pick a period</b> (24h, 7 days, 30 days, 90 days, 1 year) to rank by how much each coin moved.</li>
          <li><b>Rank by</b> return, return ÷ risk (reward per unit of bumpiness), 24h volume, or volatility. Flip the order to see the worst performers.</li>
          <li><b>Trend</b> shows Up when the price is above its 50-day average and the 50-day is above the 200-day, Down for the opposite, Mixed otherwise.</li>
          <li><b>Price range</b>: enter a Min price and a Max price to only see coins priced between them. Leave either box empty for no limit.</li>
          <li><b>Filter</b> by minimum daily volume to hide tiny, illiquid coins (the default hides coins trading under $1M a day), or show only uptrends or downtrends.</li>
          <li><b>Tap coins</b> (up to 8) to compare them on one chart. Every line starts at 0% so a $0.001 coin and a $60,000 coin compare fairly.</li>
          <li><b>Predict</b> on any row opens that coin's price-range forecast.</li>
        </ul>
        <p>Stablecoins and leveraged tokens are left out. Coins listed recently show "new" for periods longer than their history.
          A coin topping the list recently says nothing reliable about the next month. The labs show which rules have actually held up.</p>

        <h3>Smart money &amp; political flow</h3>
        <p>The second tab on <Link to="/markets?view=flow">Markets</Link> gathers, every 30 minutes: share trades disclosed by US senators and representatives (official Senate and House filings) and Australian MPs (PoliticianTrades.au); company insiders' open-market buys and sales (SEC Form 4) and ASX directors' interest notices (Appendix 3Y); market-relevant Truth Social posts by Donald Trump (via the Trump's Truth archive); crypto futures funding and open interest (OKX); and the hawkish or dovish tone of Fed and RBA statements.</p>
        <ul>
          <li><b>One row per fact.</b> The same trade from two sources is merged and gains confidence. Several politicians or insiders trading the same share within 10 days is flagged as a cluster, the pattern with the strongest research support (company insiders buying together).</li>
          <li><b>Freshness matters.</b> Each signal has a day-trade weight that fades within hours or days and is cut hard when the disclosure came late (US politicians can file 45 days after trading), and a swing weight that fades slowly.</li>
          <li><b>Do-not-buy.</b> Buys are flagged "do not buy yet" ahead of a high-impact release or central-bank decision for that market, and crypto buys when futures longs are crowded.</li>
          <li><b>Research only.</b> Nothing here places orders. These signals will be tested against the market index like every other rule once enough history builds up.</li>
        </ul>

        <h2 id="predict">Predictions</h2>
        <p>Pick a coin from the quick buttons or the full coin list (the same ranking, filters, price range and where-to-buy badges as Markets). The <Link to="/predict">Predict</Link> page then estimates where a coin's price could be in <b>7 days, 14 days, 1 month or 3 months</b> (pick from the dropdown). It never claims to know the direction. It tells you how wide the realistic range is, and shows its own track record so you can judge how far to trust it.</p>
        <ul>
          <li><b>Likely range (80%)</b>: the price ended inside this range about 8 times in 10 when we tested the same method on past days. The 50% and 90% ranges work the same way. They're based on how wild the coin is right now, blended with its long-term behaviour, and they're centred on today's price.</li>
          <li><b>Chance it's higher</b>: from similar past moments, blended with how often the coin rose over that period in general. For every coin we've tested, direction is close to a coin flip, and the page says so.</li>
          <li><b>What happened next</b>: up to 40 past days when the coin looked like today (similar 7- and 30-day move allowing for volatility, same trend), and where it was afterwards: how often higher, typical result, worst and best.</li>
          <li><b>Track record</b>: the forecast re-made on hundreds of past days, using only prices known at the time, and checked against what actually happened. "Reliable" means the range caught the price about as often as it should.</li>
          <li><b>Live log</b>: every 5 hours, forecasts are saved at the live price for BTC, ETH, SOL, XRP, ADA, DOGE, LINK, AVAX, DOT, LTC and <b>any coin you open on the Predict page</b> (it's added automatically, up to 50 extra), along with that moment's news buzz, headline tone and Fear &amp; Greed. Each one is graded automatically against the price at that exact hour once its time is up. Nobody can tune these after the fact.</li>
        </ul>
        <p><b>Comparing several coins:</b> tick coins in the list (up to 6) to see their forecasts on one chart. Past moves are shown relative to today's price (0%), each with its heavy forecast line and dashed likely range. Tap a line or "Details" to see that coin's full prediction below.</p>
        <h3>News &amp; chatter</h3>
        <ul>
          <li><b>Headlines</b> from CoinDesk, Cointelegraph, Decrypt, Bitcoin Magazine, CryptoSlate and The Block (their official feeds), plus <b>Reddit</b> crypto communities when Reddit allows it. X/Twitter isn't included: its API is paid and scraping it breaks its rules.</li>
          <li><b>Headline tone</b> is a simple, transparent count of positive words (surge, rally, approval…) against negative ones (crash, hack, lawsuit…). <b>Buzz</b> compares today's mentions with the usual daily rate.</li>
          <li><b>Market mood</b> is the Crypto Fear &amp; Greed Index (alternative.me). Because it has history back to 2018, it's fed into the predictions, but only for coins where adding it improved past forecasts. The page tells you whether it was used.</li>
          <li>Tone and buzz have no history yet, so they're shown and saved daily but not used in the numbers. Once enough days are logged, they can be tested the same way.</li>
        </ul>

        <h2 id="picks">Picks (recommendations)</h2>
        <p>The <Link to="/picks">Picks</Link> page suggests which coins to hold right now and how much of each for your budget, using rules taken from published research rather than tuned to past data:</p>
        <ul>
          <li><b>Only the 20 most-traded coins.</b> Research finds the "bargains" in tiny coins are mostly untradeable (Fieberg, Liedtke &amp; Zaremba, 2024).</li>
          <li><b>Trend checks:</b> is the price higher than 20, 40, 80 and 160 days ago, and above its average over each? A coin needs 6 of 8 to be a buy. Trend/momentum is the best-supported signal in crypto (Liu &amp; Tsyvinski, 2021; Zarattini, Pagani &amp; Barbon, 2025).</li>
          <li><b>Size by wildness:</b> calmer coins get bigger shares, wild ones smaller, never more than 20% (Kaya &amp; Mostowfi, 2022). Whatever isn't needed stays in cash, so in a falling market most of the budget sits out.</li>
          <li><b>Weekly review,</b> skipping tiny changes to save fees. No one-day signals, because one-day jumps in small coins tend to reverse (Zaremba et al., 2021).</li>
        </ul>
        <p><b>Selling and stop-losses:</b> Picks has no fixed stop-loss. Its exit is the weekly check: when a coin's trend breaks it leaves the list and you sell it. Each pick shows an optional stop-loss level (about 2.5 typical weekly moves below today's price) you can set yourself; the track record doesn't use it.</p>
        <p>The page shows the suggested mix for your budget, what changed since last week, coins to watch or avoid, and a <b>track record</b>: following the picks week by week since 2019, with your exchange's fee, compared with just holding Bitcoin and with a top-10 basket. That history only includes coins that still trade today, so it flatters every strategy. Coins that collapsed and were delisted are missing ("survivorship bias"). These are rules-based suggestions for your own research, not personal financial advice.</p>

        <h2 id="lab">Lab (self-improving paper trading)</h2>
        <p>The <Link to="/lab">Lab</Link> is a bot that trades pretend money by itself every 5 hours, with three A$1,000 accounts, one per exchange: CoinSpot (1% instant buy/sell, which the live bot uses so every coin is available), Coinbase Advanced (0.6% taker at the lowest tier) and Binance (0.1%). It places no real orders.</p>
        <ul>
          <li><b>It finds its own rules.</b> Each week it tests 39 candidate rules (for example "buy a new 20-day high after a quiet fortnight") on the 20 most-traded coins. A rule must make money after costs on older data <i>and</i> on the last 180 days, which it was never chosen on.</li>
          <li><b>Cost gate.</b> It only buys when a cautious estimate of the gain (every past signal of that rule, losers included, minus a margin for luck) beats the fees, the exchange's live buy/sell spread, slippage and a 0.3% safety margin. Stop-losses always run, even at a loss. With no live quote from the exchange, it skips, except on CoinSpot, whose public price feed leaves out many coins it lists; there it assumes a cautious 1% spread and labels the trade.</li>
          <li><b>Challengers and rollback.</b> Up to three other rules trade "in the shadow". One replaces the current rule only when its own live record is better over at least 12 trades. The old rule stays in the shadow, so if the new one does worse it's rolled back automatically. One losing trade never changes anything: that's mostly luck.</li>
          <li><b>Fixed risk limits</b> the bot can't change: at most 10% of an account per coin, a stop-loss costs at most about 1% of the account, at most 8 open positions, and at least 40% in cash.</li>
          <li><b>Stop-losses:</b> every trade gets one when it's bought, about 2.5 times the coin's typical move over the holding period, between 5% and 25% below the buy price. It's never moved. It's checked every 5 hours, so in a crash the sale can land a little below it. If it isn't hit, the coin is sold when the rule's holding period ends.</li>
          <li><b>Morning summary</b> at the top of the page: both balances, win rates and the latest rule changes.</li>
        </ul>
        <p>Expect the Coinbase account to trade far less: at 1.2% each way the gate blocks most signals. That's the point of the gate. Judge the Lab on months of results, not days.</p>

        <h3>Lab: new ideas</h3>
        <p>A second lab, under <Link to="/lab/explore">Lab → New ideas</Link>, invents strategies rather than picking from a fixed menu. It combines building blocks (new highs, moving averages, momentum, dips, volume spikes, calm or wild markets, Bitcoin's own trend) into rules of one to three conditions, keeps the best 40, and each run breeds about 40 more: random new ones, small changes to the best, and mixes of two good ones. Ideas are ranked on older data only. Because trying thousands of ideas guarantees some look great by luck, the bar an idea must clear rises with the number tried, and each idea gets a single look at the held-back last 180 days. Ideas that pass trade on paper exactly like the main Lab.</p>
        <h3>Lab: day trading</h3>
        <p><Link to="/lab/daytrade">Lab → Day trading</Link> tests 42 intraday rules on 1-hour candles for the 10 most-traded coins, all closed by 00:00 UTC (9:30am Darwin): intraday momentum (Shen, Urquhart &amp; Wang, 2022), overreaction reversal (Wen, Bouri, Xu &amp; Zhao, 2022), opening-range and volatility breakouts, and calm-market mean reversion, each with and without a daily-trend filter. On top of the main Lab's checks it runs a walk-forward test: each month it picks the rule that looked best over the previous 120 days and records what that rule actually earned the next month. Stops are checked on every hourly candle, at most 0.5% of an account is at risk per trade, and a 2% fall in a day stops new trades until the next day. Costs decide almost everything here: Coinbase Advanced at 0.6% each way needs more than 1.2% a trade just to break even.</p>

        <h2 id="shares">Shares lab (US &amp; ASX)</h2>
        <p>The <Link to="/shares">Shares lab</Link> runs the same three paper-trading labs on shares, at Interactive Brokers' real fees: the broker picked for running a bot from Australia (a full trading API that can place orders unattended, US and ASX shares in one account, and a free paper-trading account). It places no real orders.</p>
        <ul>
          <li><b>Swing rules</b>: tested the way professional equity quants do, on the S&amp;P 100 and ASX 50 with about 5 years of daily prices. 19 rules built for shares: factor portfolios that rank every share against the others (12-month momentum skipping the last month, 1-month reversal, low volatility, each with and without a market-trend filter), 200-day trend following, the turn-of-the-month effect, closeness to the 52-week high, RSI(2) and 3-down-day pullbacks in an uptrend, and 20/55-day breakouts. A rule only counts if it <b>beats the market index</b> (S&amp;P 500 or ASX 200 fund) over the same days after realistic costs (about 0.2% a round trip for US shares, 0.5% for ASX shares), with a t-score of 3 or more on older data (the higher bar used when many ideas are tested) and still ahead on the last 180 days. Ranked rules buy their best-ranked shares first. It runs on weekdays after each close (4:00pm Darwin for the ASX, 7:00am Darwin for the US).</li>
          <li><b>New ideas</b>: the idea factory on the same shares. "Bitcoin's trend" becomes the market's own trend: the S&amp;P 500 for US shares, the ASX 200 for ASX shares.</li>
          <li><b>Day trading</b>: 34 rules on hourly bars (intraday momentum, gap-down fill, opening-range and volatility breakouts, overreaction reversal), every position sold by that market's close. It checks every half hour while the ASX or US market is open (weekdays only), and practises on paper while no rule passes.</li>
          <li><b>Fees</b>: US shares US$0.0035 a share (minimum US$0.35 an order) plus exchange fees; ASX shares 0.08% plus GST (minimum A$5.50 an order). Minimums make small orders expensive, so share accounts start at A$10,000, and the US day-trading account at A$40,000 because US brokers limit accounts under US$25,000 to 3 day trades in 5 days.</li>
          <li><b>Economic calendar</b>: this week's US and Australian releases with impact ratings and forecasts, the next Fed and RBA decisions, and the latest Fed and RBA announcements and Fed speeches, all in Darwin time. The day-trading lab makes no new trades within an hour of a high-impact release for that market, and keeps a log of every release so event days can be tested once enough history builds up.</li>
          <li><b>Caveats</b>: prices are Yahoo Finance's (daily prices adjusted for splits and dividends), the share lists are today's index members, which flatters past results (survivorship bias: the professional fix is point-in-time index membership with delisted shares, e.g. Norgate Data, about A$53 a month for the ASX and US$53 a month for the US), and currency conversion fees aren't counted.</li>
        </ul>

        <h2 id="read">Reading results</h2>
        <ul>
          <li><b>Total return</b> — how much $1 became. Easy to understand, easy to be fooled by.</li>
          <li><b>Risk-adjusted score (Sharpe)</b> — return per unit of bumpiness, per year. Above 1 is good for a simple strategy; buy &amp; hold crypto is often around 0.5–1.2. This is the main score.</li>
          <li><b>Worst drop (max drawdown)</b> — the worst peak-to-bottom fall. Ask: could I actually sit through this without panicking?</li>
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

        <h2 id="unseen">The final check (why it's locked)</h2>
        <p>If you tweak a strategy after seeing its test result and then test again, the test period has quietly become
          part of your development. Do that ten times and you'll eventually find something that "works" on it by chance.</p>
        <p>So the recent prices stay locked until you press <b>Run final check</b>. Every final check is written to History with the strategy,
          its settings, fee and period. If the same strategy is revealed again on the same period with different settings,
          you get a warning that it's no longer a fair test. The record is permanent — checks can't be edited or deleted.</p>
        <p>Once a period is spent, get fresh data: wait a few months for new prices, test a different coin, or paper-trade forward.</p>

        <h2 id="accounts">Accounts and sharing</h2>
        <p>You can use everything without an account; saved runs and the ledger then live in this browser only.</p>
        <p><Link to="/account">Sign in</Link> with your email (no password — you get a sign-in link) to:</p>
        <ul>
          <li>Keep saved runs across devices.</li>
          <li>Share one record of final checks with your partner, so neither of you can quietly re-test until something looks good.</li>
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
