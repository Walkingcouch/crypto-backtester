import { test } from 'node:test'
import assert from 'node:assert/strict'
const mem = new Map()
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) }
const L = await import('../src/lib/applock.ts')

test('passcode lock: right code unlocks, five wrong ones lock you out, nothing readable is stored', async () => {
  mem.clear()
  assert.equal(L.validPin('123456'), false); assert.equal(L.validPin('111111'), false); assert.equal(L.validPin('12345'), false); assert.equal(L.validPin('482913'), true)
  L.saveLock('u1', { method: 'pin', ...(await L.pinSettings('482913')), afterMin: 5, created: 1 })
  assert.ok(![...mem.values()].some(v => v.includes('482913')))
  assert.equal((await L.tryUnlock('u1', { pin: '482913' })).result, 'ok')
  for (let i = 1; i < 5; i++) assert.equal((await L.tryUnlock('u1', { pin: '000001' })).result, 'wrong')
  assert.equal((await L.tryUnlock('u1', { pin: '000001' })).result, 'locked-out')
})
test('locks only after the chosen time away', () => {
  mem.clear()
  L.saveLock('u2', { method: 'pin', salt: 'AA', hash: 'x', afterMin: 5, created: 1 })
  const t = L.lastActive()
  assert.equal(L.shouldLock('u2', t + 4 * 60_000), false)
  assert.equal(L.shouldLock('u2', t + 6 * 60_000), true)
  assert.equal(L.shouldLock('nobody', t + 1e9), false)
})
