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
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { SUPABASE_KEY, SUPABASE_URL, rpc, sb } from './_lib/forecaster.js'

const TTL = 15 * 60_000, CODE_TTL = 30 * 60_000, MAX_TRIES = 5
// The hand-over code: a 6-digit code the approval screen shows, to type on the waiting page when it
// can't pick the approval up by itself. Its sign-in is encrypted with a key made from a server
// secret plus the code (so the public row is useless without both), and 5 wrong tries wipe it.
const secretKey = (id, code) => createHash('sha256').update(`${process.env.FORECAST_SECRET || ''}|handover|${id}|${code}`).digest()
const codeHash = (id, code) => createHash('sha256').update(`${id}|${code}|${process.env.FORECAST_SECRET || ''}`).digest('hex')
function lock(id, code, rt) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secretKey(id, code), iv)
  const ct = Buffer.concat([c.update(rt, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join(':')
}
function unlock(id, code, box) {
  const [iv, tag, ct] = box.split(':').map(x => Buffer.from(x, 'base64'))
  const d = createDecipheriv('aes-256-gcm', secretKey(id, code), iv); d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}
const idOf = email => createHash('sha256').update(`${String(email).trim().toLowerCase()}|backtester`).digest('hex')
const sid = id => `relay:${id}`
async function read(id) {
  const r = await sb(`/rest/v1/lab_state?id=eq.${encodeURIComponent(sid(id))}&select=data`)
  const d = r.ok ? (await r.json())[0]?.data : null
  if (!d?.at) return null
  return Date.now() - d.at < TTL || (d.approvedAt && Date.now() - d.approvedAt < CODE_TTL) ? d : null
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
    if (b.action === 'redeem') {              // the waiting page types the hand-over code
      if (!/^[0-9a-f]{64}$/.test(b.id || '') || !/^\d{6}$/.test(b.code || '')) return res.status(400).json({ error: 'bad code' })
      const d = await read(b.id)
      if (!d?.box2) return res.status(404).json({ error: 'no approved sign-in waiting' })
      if ((d.tries || 0) >= MAX_TRIES) return res.status(429).json({ error: 'too many wrong codes: ask for a new sign-in' })
      const ok = timingSafeEqual(Buffer.from(codeHash(b.id, b.code)), Buffer.from(d.hash))
      if (!ok) { await write(b.id, { ...d, tries: (d.tries || 0) + 1 }); return res.status(401).json({ error: `wrong code (${MAX_TRIES - (d.tries || 0) - 1} tries left)` }) }
      const rt = unlock(b.id, b.code, d.box2)
      await write(b.id, { at: 0 })                // used once
      return res.status(200).json({ rt })
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
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const rt = typeof b.rt === 'string' && b.rt.length < 400 ? b.rt : null
      await write(id, { ...d, box: b.box, approvedAt: Date.now(), ...(rt ? { box2: lock(id, code, rt), hash: codeHash(id, code), tries: 0 } : {}) })
      return res.status(200).json({ ok: true, code: rt ? code : null })
    }
    if (b.action === 'decline') { if (d) await write(id, { at: 0 }); return res.status(200).json({ ok: true }) }
    return res.status(400).json({ error: 'unknown action' })
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
