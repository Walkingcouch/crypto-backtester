// Browser side of "approve from anywhere" sign-in (api/login-relay.js). The waiting page keeps a
// private key; the approving device encrypts its sign-in for the matching public key.
const ALG = { name: 'RSA-OAEP', hash: 'SHA-256' } as const
const enc = new TextEncoder()
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)))
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')

export const emailId = async (email: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(`${email.trim().toLowerCase()}|backtester`)))
/** 4 digits both screens show, so the person can see they're approving their own request. */
export const codeOf = async (pub: JsonWebKey) => String(new DataView(await crypto.subtle.digest('SHA-256', enc.encode(pub.n || ''))).getUint32(0) % 10000).padStart(4, '0')

export function deviceName() {
  const ua = navigator.userAgent
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'a device'
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser'
  return `${br} on ${os}`
}

export const post = (body: object, token?: string) => fetch('/api/login-relay', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
}).then(async r => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) }))

/** Start waiting for an approval: returns what the waiting page must keep. */
export async function startWaiting(email: string) {
  const kp = await crypto.subtle.generateKey({ ...ALG, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt'])
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey), priv = await crypto.subtle.exportKey('jwk', kp.privateKey)
  const id = await emailId(email)
  const r = await post({ action: 'wait', id, pub, device: deviceName() })
  if (!r.ok) throw new Error('could not start waiting')
  return { id, priv, code: await codeOf(pub) }
}
export async function sealFor(pub: JsonWebKey, refreshToken: string) {
  const k = await crypto.subtle.importKey('jwk', pub, ALG, false, ['encrypt'])
  return b64(await crypto.subtle.encrypt(ALG, k, enc.encode(JSON.stringify({ rt: refreshToken }))))
}
export async function openBox(priv: JsonWebKey, box: string): Promise<string> {
  const k = await crypto.subtle.importKey('jwk', priv, ALG, false, ['decrypt'])
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(ALG, k, unb64(box)))).rt
}
