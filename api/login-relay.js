// "Approve from anywhere" sign-in. The page you asked from waits; tapping the email link on any
// device or browser shows an approval screen with a 4-digit code that matches the waiting page, and
// approving signs that waiting page in by itself.
//
// How it stays safe:
//  - The waiting page makes a one-off key pair and sends only the PUBLIC key here. The approving
//    device encrypts its sign-in for that public key in the browser; only the waiting page (which
//    holds the private key) can open it. This server and the database only ever see ciphertext.
//  - Requests are filed under a hash of the email, never the email itself, and expire in 15 minutes.
//  - Approving needs a real signed-in session for that same email (from the email link), and the
//    person confirms the 4-digit code matches the screen they're signing in, so nobody can slip in
//    their own waiting page.
import { createHash } from 'node:crypto'
import { SUPABASE_KEY, SUPABASE_URL, rpc, sb } from './_lib/forecaster.js'

const TTL = 15 * 60_000
const idOf = email => createHash('sha256').update(`${String(email).trim().toLowerCase()}|backtester`).digest('hex')
const sid = id => `relay:${id}`
async function read(id) {
  const r = await sb(`/rest/v1/lab_state?id=eq.${encodeURIComponent(sid(id))}&select=data`)
  const d = r.ok ? (await r.json())[0]?.data : null
  return d && d.at && Date.now() - d.at < TTL ? d : null
}
const write = (id, data) => rpc('lab_put', { sid: sid(id), payload: data })
async function userOf(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (!token) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}` } })
  return r.ok ? r.json() : null
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const origin = req.headers.origin, host = req.headers['x-forwarded-host'] || req.headers.host
  if (!origin || new URL(origin).host !== host) return res.status(403).json({ error: 'wrong origin' })
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  try {
    if (b.action === 'wait') {                // the page that asked for the email
      if (!/^[0-9a-f]{64}$/.test(b.id || '')) return res.status(400).json({ error: 'bad id' })
      const pub = b.pub
      if (!pub || pub.kty !== 'RSA' || typeof pub.n !== 'string' || pub.n.length > 1200 || pub.d) return res.status(400).json({ error: 'bad key' })
      await write(b.id, { pub: { kty: 'RSA', n: pub.n, e: pub.e, alg: 'RSA-OAEP-256', ext: true }, device: String(b.device || '').slice(0, 80), at: Date.now(), box: null })
      return res.status(200).json({ ok: true })
    }
    if (b.action === 'claim') {               // the waiting page polls for its approval
      if (!/^[0-9a-f]{64}$/.test(b.id || '')) return res.status(400).json({ error: 'bad id' })
      const d = await read(b.id)
      if (d?.box && b.done) await write(b.id, { at: 0 })        // picked up: wipe it
      return res.status(200).json({ box: d?.box || null, waiting: !!d })
    }
    // the device that opened the email link (signed in by that link)
    const u = await userOf(req)
    if (!u?.email) return res.status(401).json({ error: 'not signed in' })
    const id = idOf(u.email), d = await read(id)
    if (b.action === 'peek') return res.status(200).json(d && !d.box ? { waiting: true, pub: d.pub, device: d.device, at: d.at } : { waiting: false })
    if (b.action === 'approve') {
      if (!d || d.box) return res.status(410).json({ error: 'That sign-in request has expired or was already approved. Ask for a new code.' })
      if (typeof b.box !== 'string' || b.box.length > 2000) return res.status(400).json({ error: 'bad box' })
      await write(id, { ...d, box: b.box, approvedAt: Date.now() })
      return res.status(200).json({ ok: true })
    }
    if (b.action === 'decline') { if (d) await write(id, { at: 0 }); return res.status(200).json({ ok: true }) }
    return res.status(400).json({ error: 'unknown action' })
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
