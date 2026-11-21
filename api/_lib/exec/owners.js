// One automation account per person. Each admin email (ADMIN_EMAILS) is an owner, named by the
// first part of the address: john.ahchee@… → 'john', mark.a.mclean@… → 'mark'.
//
// Each owner's keys and mode are separate server environment variables:
//   COINSPOT_API_KEY_MARK, COINSPOT_API_SECRET_MARK, EXECUTION_MODE_MARK (paper unless exactly 'live'),
//   PAPER_WALLET_AUD_MARK, SHARE_ORDER_WEBHOOK_URL_MARK
// John's account is the original one, so his keys may also be the unsuffixed names
// (COINSPOT_API_KEY, EXECUTION_MODE, …). Nobody else ever falls back to those: a missing key for
// Mark means Mark has no keys, never that he trades on John's.
import { DEFAULTS } from './risk.js'

export const LEGACY = 'john'
export const ownerOf = email => (String(email || '').toLowerCase().split(/[.@+_-]/)[0] || '').replace(/[^a-z0-9]/g, '').slice(0, 20)
export const keyPrefix = owner => (!owner || owner === LEGACY ? '' : `${owner}~`)

/** [{ owner, email }] from ADMIN_EMAILS, in order. */
export function ownersFrom(env) {
  const out = []
  for (const email of (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    const owner = ownerOf(email)
    if (owner && !out.some(o => o.owner === owner)) out.push({ owner, email })
  }
  return out
}

/** The environment as one owner sees it: only their own keys, mode and wallet size. */
export function envFor(env, owner) {
  const U = owner.toUpperCase(), legacy = owner === LEGACY
  const pick = name => env[`${name}_${U}`] ?? (legacy ? env[name] : undefined)
  return {
    EXECUTION_MODE: pick('EXECUTION_MODE'),
    COINSPOT_API_KEY: pick('COINSPOT_API_KEY'),
    COINSPOT_API_SECRET: pick('COINSPOT_API_SECRET'),
    PAPER_WALLET_AUD: pick('PAPER_WALLET_AUD'),
    SHARE_ORDER_WEBHOOK_URL: pick('SHARE_ORDER_WEBHOOK_URL'),
  }
}

/** Settings for an owner, falling back to the defaults until they first save their own. */
export const SETTING_DEFAULTS = {
  ...DEFAULTS, crypto_source_lab: 'daytrade', crypto_source_account: 'john', share_source_lab: 'stocks', share_order_aud: 500, share_fee_aud: 2,
}
export const settingsFor = (all, owner) => all.find(s => (s.owner || LEGACY) === owner) || { ...SETTING_DEFAULTS, owner, updated_at: null, updated_by: null }
