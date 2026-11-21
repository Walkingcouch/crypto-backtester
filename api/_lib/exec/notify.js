// Phone alerts through a Telegram bot. Off until these server variables exist:
//   TELEGRAM_BOT_TOKEN            the bot's token from @BotFather (one bot for everyone)
//   TELEGRAM_CHAT_ID_JOHN, _MARK  each person's own chat with the bot (John may also use TELEGRAM_CHAT_ID)
// Each person only ever gets alerts about their own account. Alerts are for REAL money only:
// fills, failures, stop-loss sells by the watchdog and kill-switch changes (blocked signals happen
// all day and would just be noise).
const aud = x => `A$${(+x).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const px = x => (+x >= 100 ? (+x).toFixed(2) : (+x).toPrecision(4))

export function chatFor(env, owner) {
  return env[`TELEGRAM_CHAT_ID_${String(owner).toUpperCase()}`] ?? (owner === 'john' ? env.TELEGRAM_CHAT_ID : undefined)
}
export const alertsReady = (env, owner) => !!(env.TELEGRAM_BOT_TOKEN && chatFor(env, owner))

export async function notify(owner, text, env = process.env, fetcher = globalThis.fetch) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = chatFor(env, owner)
  if (!token || !chat) return { ok: false, why: !token ? 'TELEGRAM_BOT_TOKEN is not set in Vercel' : `TELEGRAM_CHAT_ID_${String(owner).toUpperCase()} is not set in Vercel` }
  try {
    const r = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    })
    const j = await r.json().catch(() => ({}))
    return r.ok && j.ok !== false ? { ok: true } : { ok: false, why: `Telegram said: ${j.description || r.status}` }
  } catch (e) { return { ok: false, why: String(e.message || e) } }
}

/** Message for an order row that just changed, or null if it isn't worth a ping. */
export function orderAlert(owner, row, before = {}, buyOf = () => null) {
  const o = { ...before, ...row }
  if (o.mode !== 'live' || o.venue === 'superhero') return null
  const who = owner.charAt(0).toUpperCase() + owner.slice(1)
  if (row.status === 'filled' && o.side === 'BUY')
    return `✅ ${who}: bought ${aud(o.requested_aud)} of ${o.asset} on CoinSpot at A$${px(o.filled_rate)}.${o.stop_usd ? ` Stop-loss US$${px(o.stop_usd)}.` : ''}\n${o.source || ''}`
  if (row.status === 'filled' && o.side === 'SELL') {
    const b = buyOf(o.parent_idem)
    const res = b?.filled_rate && o.filled_rate ? ` (${((o.filled_rate / b.filled_rate - 1) * 100).toFixed(1)}% vs the buy price, before fees)` : ''
    return `💰 ${who}: sold ${(+o.filled_amount || +o.requested_amount || 0).toPrecision(6)} ${o.asset} at A$${px(o.filled_rate)}${res}.${o.reason ? `\n${o.reason}` : ''}`
  }
  if (row.status === 'failed') return `⚠️ ${who}: ${o.side} ${o.asset} FAILED on CoinSpot: ${o.reason || 'no reason given'}`
  return null
}
