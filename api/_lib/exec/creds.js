// One owner's keys and mode, wherever they were set: the Connections page (encrypted in the
// database, migration 0013) first, then Vercel environment variables (owners.js). Nobody ever gets
// another person's keys: lookups are by owner, and John's unsuffixed variables are John's alone.
import { rpc } from '../forecaster.js'
import { envFor } from './owners.js'
import { open, vaultReady } from './vault.js'

/** { venues: { coinspot: { kind, cipher, public_info, status } … }, mode } or empty before migration 0013. */
export async function connectionsOf(owner) {
  if (!vaultReady()) return { venues: {}, mode: null }
  const j = await rpc('conn_get', { who_owner: owner }).catch(() => null)
  return j && typeof j === 'object' ? { venues: j.venues || {}, mode: j.mode || null } : { venues: {}, mode: null }
}

export async function envWithConnections(owner, env = process.env) {
  const out = envFor(env, owner)
  const { venues, mode } = await connectionsOf(owner)
  const cs = venues.coinspot
  if (cs?.cipher && cs.status !== 'refused') {
    try { const s = open(cs.cipher, env); out.COINSPOT_API_KEY = s.apiKey; out.COINSPOT_API_SECRET = s.apiSecret; out.KEYS_FROM = 'site' } catch { out.KEYS_ERROR = 'saved CoinSpot key could not be decrypted (was CONNECTIONS_KEY changed?)' }
  } else if (out.COINSPOT_API_KEY) out.KEYS_FROM = 'vercel'
  if (mode === 'paper' || mode === 'live') { out.EXECUTION_MODE = mode; out.MODE_FROM = 'site' } else out.MODE_FROM = 'vercel'
  return out
}
