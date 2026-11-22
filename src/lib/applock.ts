// App lock: Face ID / Touch ID / fingerprint / Windows Hello (or the device's own passcode) where the
// device offers it, otherwise a passcode set here. Like a banking app, the site locks itself when
// you've been away for a while and opens again only after you prove it's you.
//
// Biometrics use the browser's built-in passkey support (WebAuthn) with "user verification
// required": the device checks the face, finger or device passcode, the site never sees it. A
// passcode set here is never stored, only a slow salted hash of it (PBKDF2, 200,000 rounds).
// Too many wrong passcodes signs you out; signing back in with the email code resets the lock.
// Settings are per person and per browser/device.

export type LockMethod = 'bio' | 'pin'
export interface LockSettings { method: LockMethod; credId?: string; salt?: string; hash?: string; afterMin: number; created: number }

const KEY = (uid: string) => `applock:${uid}`
const ACTIVE = 'applock:active'
const FAILS = (uid: string) => `applock:fails:${uid}`
export const MAX_FAILS = 5
export const AFTER_CHOICES: [number, string][] = [[0, 'Every time I come back'], [1, 'After 1 minute away'], [5, 'After 5 minutes away'], [15, 'After 15 minutes away'], [60, 'After 1 hour away']]

const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string, v: string | null) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* storage blocked */ } }

export const lockSettings = (uid: string): LockSettings | null => { try { return JSON.parse(get(KEY(uid)) || 'null') } catch { return null } }
export const saveLock = (uid: string, s: LockSettings | null) => { set(KEY(uid), s ? JSON.stringify(s) : null); set(FAILS(uid), null); markActive() }
export const failCount = (uid: string) => +(get(FAILS(uid)) || 0)
export const resetFails = (uid: string) => set(FAILS(uid), null)
const addFail = (uid: string) => { const n = failCount(uid) + 1; set(FAILS(uid), String(n)); return n }

/** Last time the site was in front of the person (shared by all tabs). */
export const markActive = () => set(ACTIVE, String(Date.now()))
export const lastActive = () => +(get(ACTIVE) || 0)
export function shouldLock(uid: string, now = Date.now()) {
  const s = lockSettings(uid)
  if (!s) return false
  return now - lastActive() > Math.max(s.afterMin * 60_000, 3_000)
}

// ---------------------------------------------------------------- biometrics (WebAuthn)
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0))
const challenge = () => crypto.getRandomValues(new Uint8Array(32))

/** Does this device have Face ID / Touch ID / fingerprint / Windows Hello (or a device passcode) for websites? */
export async function bioAvailable(): Promise<boolean> {
  try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() } catch { return false }
}
export async function enrolBio(uid: string, email: string): Promise<string> {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: challenge(), rp: { name: 'Backtester', id: location.hostname },
    user: { id: new TextEncoder().encode(uid).slice(0, 64), name: email, displayName: email },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    timeout: 60_000, attestation: 'none',
  } }) as PublicKeyCredential | null
  if (!cred) throw new Error('Not set up')
  return b64u(cred.rawId)
}
/** True only if the device confirmed it's the owner (face, finger or device passcode). */
export async function verifyBio(credId: string): Promise<boolean> {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: challenge(), allowCredentials: [{ type: 'public-key', id: unb64u(credId) }],
    userVerification: 'required', rpId: location.hostname, timeout: 60_000,
  } }) as PublicKeyCredential | null
  const data = (a?.response as AuthenticatorAssertionResponse | undefined)?.authenticatorData
  return !!data && (new Uint8Array(data)[32] & 0x04) !== 0      // flags byte: bit 2 = user verified
}

// ---------------------------------------------------------------- passcode
async function hashPin(pin: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(salt), iterations: 200_000 }, key, 256)
  return b64u(bits)
}
export async function pinSettings(pin: string): Promise<Pick<LockSettings, 'salt' | 'hash'>> {
  const salt = b64u(crypto.getRandomValues(new Uint8Array(16)).buffer)
  return { salt, hash: await hashPin(pin, salt) }
}
export const validPin = (pin: string) => /^\d{6,12}$/.test(pin) && !/^(\d)\1+$/.test(pin) && !'0123456789012'.includes(pin) && !'9876543210987'.includes(pin)

/** Check an unlock attempt. Returns 'ok', 'wrong' (with tries left) or 'locked-out'. */
export async function tryUnlock(uid: string, attempt: { pin?: string; bio?: boolean }): Promise<{ result: 'ok' | 'wrong' | 'locked-out'; left: number }> {
  const s = lockSettings(uid)
  if (!s) return { result: 'ok', left: MAX_FAILS }
  let ok = false
  if (attempt.bio && s.credId) ok = await verifyBio(s.credId).catch(() => false)
  else if (attempt.pin != null && s.salt && s.hash) ok = (await hashPin(attempt.pin, s.salt)) === s.hash
  if (ok) { set(FAILS(uid), null); markActive(); return { result: 'ok', left: MAX_FAILS } }
  if (attempt.bio) return { result: 'wrong', left: MAX_FAILS - failCount(uid) }   // a cancelled prompt isn't a wrong guess
  const n = addFail(uid)
  return n >= MAX_FAILS ? { result: 'locked-out', left: 0 } : { result: 'wrong', left: MAX_FAILS - n }
}
