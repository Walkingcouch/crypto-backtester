// Encryption for exchange keys and wallet keys saved from the Connections page.
// AES-256-GCM with CONNECTIONS_KEY (32 random bytes, base64), which lives only in Vercel's
// environment, never in the database or the browser. The database holds only ciphertext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const keyOf = (env = process.env) => {
  const k = Buffer.from(env.CONNECTIONS_KEY || '', 'base64')
  if (k.length !== 32) throw new Error('CONNECTIONS_KEY is not set (32 random bytes, base64) in Vercel')
  return k
}
export const vaultReady = (env = process.env) => { try { keyOf(env); return true } catch { return false } }
/** A fresh key for CONNECTIONS_KEY (shown once, only while none is set). */
export const newVaultKey = () => randomBytes(32).toString('base64')

export function seal(obj, env = process.env) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyOf(env), iv)
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
}
export function open(cipher, env = process.env) {
  const [v, iv, tag, ct] = String(cipher || '').split(':')
  if (v !== 'v1') throw new Error('unknown cipher format')
  const d = createDecipheriv('aes-256-gcm', keyOf(env), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'))
}
