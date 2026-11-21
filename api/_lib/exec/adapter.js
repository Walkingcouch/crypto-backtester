// ExecutionAdapter interface (implemented by CoinSpotAdapter and SuperheroAdapter):
//
//   venue: 'coinspot' | 'superhero'
//   mode:  'paper' | 'live'
//   getWalletBalance(paperWallet?) → { aud, coins: { SYMBOL: amount } }
//   getQuote(asset, side, aud, signalPrice?) → { rate (AUD per unit), source }
//   placeOrder({ coin|ticker, market, side, aud, amount, rate, thresholdPct, source })
//        → { status: 'paper_filled'|'filled'|'pending_manual', filledRate, filledAmount, feeAud, raw, externalId? }
//   cancelOrder(id, side) → { status }
//   getOrderStatus(id?) → exchange-specific
//
// There are deliberately no deposit, withdrawal or bank functions anywhere in this interface.
import { CoinSpotAdapter } from './coinspot.js'
import { SuperheroAdapter } from './superhero.js'

/** Mode comes only from the server environment: the website can never switch to live. */
export const executionMode = env => (env.EXECUTION_MODE === 'live' ? 'live' : 'paper')

/** env: one owner's environment (owners.js envFor), never the whole server environment for anyone but John. */
export function adapters(env, settings = {}) {
  const mode = executionMode(env)
  return {
    mode,
    crypto: new CoinSpotAdapter({ mode, key: env.COINSPOT_API_KEY, secret: env.COINSPOT_API_SECRET }),
    shares: new SuperheroAdapter({ mode, feeAud: settings.share_fee_aud, webhook: env.SHARE_ORDER_WEBHOOK_URL }),
  }
}
