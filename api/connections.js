// Connections page API: add, test and remove exchange keys (CEX) and bot wallets (DEX), and switch
// paper / live. Admins only (ADMIN_EMAILS); each person can change only their own connections and
// sees only the public part of anyone else's (exchange name, key hint, wallet address, status).
//
// Keys are encrypted here on the server (vault.js) before they reach the database and are never
// sent back to any browser. A key that the exchange says can withdraw / transfer is refused.
import { SUPABASE_KEY, SUPABASE_URL, rpc } from './_lib/forecaster.js'
import { LEGACY, ownerOf, ownersFrom } from './_lib/exec/owners.js'
import { setSettingsFor, loadAll } from './_lib/exec/store.js'
import { connectionsOf } from './_lib/exec/creds.js'
import { newVaultKey, open, seal, vaultReady } from './_lib/exec/vault.js'
import { loadWalletLibs, prepare, testConnection, VENUES } from './_lib/exec/venues.js'
import { notify } from './_lib/exec/notify.js'

async function admin(req) {
  const allow = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (!allow.length || !token) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = await r.json()
  return u?.email && allow.includes(u.email.toLowerCase()) ? u.email : null
}
const publicVenues = () => Object.fromEntries(Object.entries(VENUES).map(([id, v]) => [id, { kind: v.kind, name: v.name, bot: !!v.bot, help: v.help, fields: v.fields.map(({ id, label, secret, optional, placeholder, multiline }) => ({ id, label, secret, optional, placeholder, multiline })) }]))

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store')
  const who = await admin(req).catch(() => null)
  if (!who) return res.status(403).json({ error: 'Sign in with an admin account to manage connections.' })
  const me = ownerOf(who)
  try {
    const body = req.method === 'POST' ? (typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}')) : {}
    const action = body.action || 'status'
    const ready = vaultReady()

    if (action === 'status') {
      const list = ready ? await rpc('conn_list', {}) : []
      const migrated = Array.isArray(list)
      const all = await loadAll(1).catch(() => ({ settings: [] }))
      const owners = [...new Set([me, LEGACY, ...ownersFrom(process.env).map(o => o.owner)])]
      return res.status(200).json({
        who, me, vaultReady: ready, migrated: ready ? migrated : null, migrationError: ready && !migrated ? String(list) : null,
        venues: publicVenues(),
        connections: migrated ? list.map(c => ({ ...c, mine: c.owner === me })) : [],
        modes: Object.fromEntries(owners.map(o => {
          const s = all.settings.find(x => (x.owner || LEGACY) === o)
          const U = o.toUpperCase(), envMode = process.env[`EXECUTION_MODE_${U}`] ?? (o === LEGACY ? process.env.EXECUTION_MODE : undefined)
          return [o, { mode: s?.execution_mode || (envMode === 'live' ? 'live' : 'paper'), from: s?.execution_mode ? 'site' : 'vercel' }]
        })),
      })
    }
    if (action === 'genkey') {          // first-time setup: a key to paste into Vercel (only while none is set)
      if (ready) return res.status(400).json({ error: 'CONNECTIONS_KEY is already set.' })
      return res.status(200).json({ key: newVaultKey() })
    }
    if (!ready) return res.status(400).json({ error: 'Add CONNECTIONS_KEY in Vercel first (step 1 on this page).' })

    const venue = String(body.venue || '')
    if (action === 'save') {
      if (!VENUES[venue]) return res.status(400).json({ error: 'unknown exchange or wallet' })
      await loadWalletLibs()
      const { secrets, pub } = await prepare(venue, body.fields)
      const test = await testConnection(venue, secrets, pub).catch(e => ({ ok: false, summary: `Test failed: ${e.message}` }))
      if (test.refuse) return res.status(400).json({ error: test.refuse, test })
      const r = await rpc('conn_put', { row_data: { owner: me, venue, kind: VENUES[venue].kind, label: String(body.label || '').slice(0, 60) || null, public_info: { ...pub, ...(test.details ? { details: test.details } : {}) }, cipher: seal(secrets), status: test.ok ? 'ok' : 'untested', last_test: { at: new Date().toISOString(), ...test } }, who })
      if (typeof r === 'string' && r !== 'saved') return res.status(500).json({ error: /conn_put/.test(r) ? 'Run migration 0013 in Supabase first.' : r })
      await notify(me, `🔑 ${VENUES[venue].name} ${VENUES[venue].kind === 'dex' ? 'wallet' : 'API key'} saved for ${me}'s automation by ${who}.`).catch(() => {})
      return res.status(200).json({ ok: true, test, public_info: pub })
    }
    if (action === 'test') {
      const { venues } = await connectionsOf(me)
      const c = venues[venue]
      if (!c) return res.status(404).json({ error: 'not connected' })
      await loadWalletLibs()
      const test = await testConnection(venue, open(c.cipher), c.public_info).catch(e => ({ ok: false, summary: `Test failed: ${e.message}` }))
      await rpc('conn_status', { who_owner: me, v: venue, new_status: test.refuse ? 'refused' : test.ok ? 'ok' : 'failing', test: { at: new Date().toISOString(), ...test } })
      return res.status(200).json({ test })
    }
    if (action === 'delete') {
      await rpc('conn_delete', { who_owner: me, v: venue })
      await notify(me, `🗑 ${VENUES[venue]?.name || venue} connection removed from ${me}'s automation by ${who}.`).catch(() => {})
      return res.status(200).json({ ok: true })
    }
    if (action === 'mode') {
      const mode = body.mode === 'live' ? 'live' : 'paper'
      if (mode === 'live') {
        if (body.confirm !== 'LIVE') return res.status(400).json({ error: 'Type LIVE to confirm real-money trading.' })
        const { venues } = await connectionsOf(me)
        const U = me.toUpperCase(), envKey = process.env[`COINSPOT_API_KEY_${U}`] ?? (me === LEGACY ? process.env.COINSPOT_API_KEY : undefined)
        if (!venues.coinspot && !envKey) return res.status(400).json({ error: 'Connect CoinSpot first: the bot trades there.' })
      }
      const settings = await setSettingsFor(me, { execution_mode: mode }, who)
      if (settings && !('execution_mode' in settings)) return res.status(500).json({ error: 'Run migration 0013 in Supabase first.' })
      await notify(me, mode === 'live' ? `🟥 ${me}'s automation switched to LIVE (real money) by ${who}.` : `🟩 ${me}'s automation switched to paper by ${who}.`).catch(() => {})
      return res.status(200).json({ ok: true, mode })
    }
    return res.status(400).json({ error: 'unknown action' })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
