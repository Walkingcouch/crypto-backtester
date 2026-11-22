// Keeps people signed in until they sign out.
//
// Supabase keeps the session in the browser's localStorage, which some browsers clear on their own
// (Safari wipes it after 7 days without a visit; private windows and "clear site data" do too).
// This keeps a backup of the session's refresh token in a cookie the page's scripts can't read
// (HttpOnly, Secure, SameSite=Strict, this path only), set by our own server so browser limits on
// script-set cookies don't apply. If the browser loses the session, the page asks for the backup
// once and resumes it. Signing out deletes the backup.
//
// POST { action: 'save', refresh_token, locked } | { action: 'restore' } | { action: 'clear' }
const NAME = 'bt_rt', PATH = '/api/session', MAX_AGE = 400 * 86_400   // the longest browsers allow

const cookie = (v, age, name = NAME) => `${name}=${v}; Path=${PATH}; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`
// If the person had an app lock on, a browser that lost its storage also lost the lock settings, so
// the backup must not silently reopen the site: it says so, and they sign in with the email code.
const LOCK = 'bt_lock'
const read = (req, name = NAME) => {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  // only our own pages may call this
  const origin = req.headers.origin, host = req.headers['x-forwarded-host'] || req.headers.host
  if (!origin || new URL(origin).host !== host) return res.status(403).json({ error: 'wrong origin' })
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  if (body.action === 'save') {
    const t = String(body.refresh_token || '')
    if (!/^[A-Za-z0-9._-]{8,512}$/.test(t)) return res.status(400).json({ error: 'bad token' })
    res.setHeader('set-cookie', [cookie(encodeURIComponent(t), MAX_AGE), cookie(body.locked ? '1' : '', body.locked ? MAX_AGE : 0, LOCK)])
    return res.status(200).json({ ok: true })
  }
  if (body.action === 'restore') return res.status(200).json(read(req, LOCK) === '1' ? { locked: true } : { refresh_token: read(req) })
  if (body.action === 'clear') { res.setHeader('set-cookie', [cookie('', 0), cookie('', 0, LOCK)]); return res.status(200).json({ ok: true }) }
  return res.status(400).json({ error: 'unknown action' })
}
