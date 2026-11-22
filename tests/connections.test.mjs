import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import { open, seal, vaultReady } from '../api/_lib/exec/vault.js'
import { coinbaseJwt, loadWalletLibs, prepare, testConnection } from '../api/_lib/exec/venues.js'

const env = { CONNECTIONS_KEY: randomBytes(32).toString('base64') }

test('secrets are sealed with the master key and only open with it', () => {
  const c = seal({ apiKey: 'k', apiSecret: 'very-secret' }, env)
  assert.ok(!c.includes('very-secret'))
  assert.deepEqual(open(c, env), { apiKey: 'k', apiSecret: 'very-secret' })
  assert.throws(() => open(c, { CONNECTIONS_KEY: randomBytes(32).toString('base64') }))
  assert.equal(vaultReady({}), false)
})

test('wallet keys give their public address; bad keys are rejected in plain words', async () => {
  await loadWalletLibs()
  const evm = await prepare('base', { privateKey: '0x' + '11'.repeat(32) })
  assert.match(evm.pub.address, /^0x[0-9a-fA-F]{40}$/)
  const nacl = globalThis.__nacl, bs58 = globalThis.__bs58
  const kp = nacl.sign.keyPair()
  const sol = await prepare('solana', { privateKey: bs58.encode(kp.secretKey) })
  assert.equal(sol.pub.address, bs58.encode(kp.publicKey))
  const sol2 = await prepare('solana', { privateKey: JSON.stringify([...kp.secretKey]) })
  assert.equal(sol2.pub.address, sol.pub.address)
  await assert.rejects(prepare('base', { privateKey: '0x1234' }), /64 hex/)
  await assert.rejects(prepare('binance', { apiKey: 'abc' }), /Secret key is missing/)
  await assert.rejects(prepare('solana', { privateKey: '[1,2]', rpcUrl: 'http://x' }), /RPC URL|64 bytes/)
})

test('a Binance key that can withdraw is refused', async () => {
  const fake = async () => new Response(JSON.stringify({ enableWithdrawals: true, enableSpotAndMarginTrading: true }), { status: 200 })
  const r = await testConnection('binance', { apiKey: 'a', apiSecret: 'b' }, {}, fake)
  assert.ok(r.refuse && /WITHDRAW/.test(r.refuse))
  const ok = await testConnection('binance', { apiKey: 'a', apiSecret: 'b' }, {}, async () => new Response(JSON.stringify({ enableWithdrawals: false, enableSpotAndMarginTrading: true }), { status: 200 }))
  assert.equal(ok.ok, true); assert.equal(ok.refuse, undefined)
})

test('a Coinbase key with transfer permission is refused; the request is signed with the key', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pem = privateKey.export({ type: 'sec1', format: 'pem' })
  const jwt = coinbaseJwt('organizations/x/apiKeys/y', pem, 'GET api.coinbase.com/x')
  const [h, p, sig] = jwt.split('.')
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')))
  const r = await testConnection('coinbase', { apiKey: 'organizations/x/apiKeys/y', apiSecret: pem }, {}, async () => new Response(JSON.stringify({ can_trade: true, can_transfer: true }), { status: 200 }))
  assert.ok(r.refuse)
})
