# Crypto Backtester

Test clearly defined crypto trading strategies on past prices, with honest validation on data the strategy has never seen.
The backtest runs entirely in the browser; Supabase adds optional profiles, saved runs and a shared, append-only test ledger.

- `src/lib/engine.ts` — backtest engine (next-bar execution, fees, slippage, accounting, lookahead check)
- `src/lib/strategies.ts` — built-in strategies (trend baseline, breakout, volatility-sized trend, buy & hold)
- `src/lib/research.ts` — train/test split, settings search on train only, test evaluation
- `src/pages/Guide.tsx` — user instructions (also live at `/guide`)
- `supabase/migrations/` — database schema with row-level security
- `python/` — the same engine in Python, for writing custom strategies (downloadable from the Guide)

## Run locally

```bash
npm install
cp .env.example .env.local   # optional: add Supabase URL + publishable key to enable accounts
npm run dev
```

Without Supabase env vars the site still works; saved runs and the ledger stay in the browser.

## Deploy

Vercel (Vite preset). Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
In Supabase → Authentication → URL Configuration, set the Site URL to the deployed URL and add
`https://<your-domain>/**` to Redirect URLs so email sign-in links come back to the site.

Backtests are simulations on past data, not predictions. Not financial advice.
