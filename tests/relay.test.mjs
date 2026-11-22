import { test } from 'node:test'
import assert from 'node:assert/strict'
globalThis.navigator ??= { userAgent: 'test' }
const R = await import('../src/lib/relay.ts')

test('only the waiting page can open an approval, and both screens show the same code', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 })
  const w = await R.startWaiting('John@Example.com ')
  assert.equal(w.id, await R.emailId('john@example.com'))
  const pub = { kty: 'RSA', n: w.priv.n, e: w.priv.e, alg: 'RSA-OAEP-256', ext: true }
  assert.equal(await R.codeOf(pub), w.code)
  assert.match(w.code, /^\d{4}$/)
  const box = await R.sealFor(pub, 'refresh-abc123')
  assert.equal(await R.openBox(w.priv, box), 'refresh-abc123')
  const other = await R.startWaiting('x@y.z')
  await assert.rejects(R.openBox(other.priv, box))
})
