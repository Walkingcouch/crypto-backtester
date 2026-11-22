// The exchanges (CEX) and wallets (DEX) that can be connected from the Connections page, what each
// needs, and a read-only connection test for each. Tests only ever READ (balances, key permissions);
// nothing here places an order or moves funds.
import { createHash, createHmac, createPrivateKey, randomBytes, sign as edSign } from 'node:crypto'
import { CoinSpotAdapter } from './coinspot.js'

const f = (id, label, opts = {}) => ({ id, label, secret: true, ...opts })
export const VENUES = {
  coinspot: { kind: 'cex', name: 'CoinSpot', bot: true, fields: [f('apiKey', 'API key', { secret: false }), f('apiSecret', 'API secret')],
    help: 'CoinSpot → Settings → API → Create new key. Choose the access that allows trading (it can also withdraw, but this bot never calls withdrawal endpoints).' },
  binance: { kind: 'cex', name: 'Binance', fields: [f('apiKey', 'API key', { secret: false }), f('apiSecret', 'Secret key')],
    help: 'Binance → Account → API Management → Create API (system-generated). Tick "Enable Spot & Margin Trading" only. Leave "Enable Withdrawals" OFF: keys that can withdraw are refused.' },
  kraken: { kind: 'cex', name: 'Kraken', fields: [f('apiKey', 'API key', { secret: false }), f('apiSecret', 'Private key')],
    help: 'Kraken Pro → Settings → API → Create key. Allow "Query funds", "Query open orders & trades", "Create & modify orders". Leave "Withdraw funds" unticked.' },
  coinbase: { kind: 'cex', name: 'Coinbase Advanced', fields: [f('apiKey', 'API key name', { secret: false, placeholder: 'organizations/…/apiKeys/…' }), f('apiSecret', 'Private key', { multiline: true, placeholder: '-----BEGIN EC PRIVATE KEY-----' })],
    help: 'Coinbase Developer Platform → API keys → Create (Advanced Trade, ECDSA). Permissions: View and Trade. Do NOT tick Transfer: keys that can transfer are refused.' },
  swyftx: { kind: 'cex', name: 'Swyftx', fields: [f('apiKey', 'API key')], help: 'Swyftx → Profile → API keys. Stored for later: no connection test or bot support yet.' },
  independentreserve: { kind: 'cex', name: 'Independent Reserve', fields: [f('apiKey', 'API key', { secret: false }), f('apiSecret', 'API secret')], help: 'Stored for later: no connection test or bot support yet.' },
  btcmarkets: { kind: 'cex', name: 'BTC Markets', fields: [f('apiKey', 'API key', { secret: false }), f('apiSecret', 'Private key')], help: 'Stored for later: no connection test or bot support yet.' },
  solana: { kind: 'dex', name: 'Solana wallet (Jupiter)', fields: [f('privateKey', 'Wallet private key', { placeholder: 'base58, or the [12,34,…] array from a keypair file' }), f('rpcUrl', 'RPC URL (optional)', { secret: false, optional: true })],
    help: 'Use a NEW wallet made just for the bot and keep only what it may trade in it. A private key can move everything in the wallet: anyone who gets it can empty it.' },
  base: { kind: 'dex', name: 'Base wallet (EVM)', fields: [f('privateKey', 'Wallet private key', { placeholder: '0x…' }), f('rpcUrl', 'RPC URL (optional)', { secret: false, optional: true })],
    help: 'Use a NEW wallet made just for the bot (e.g. a fresh MetaMask account) holding only what it may trade. A private key can move everything in the wallet.' },
  ethereum: { kind: 'dex', name: 'Ethereum wallet (EVM)', fields: [f('privateKey', 'Wallet private key', { placeholder: '0x…' }), f('rpcUrl', 'RPC URL (optional)', { secret: false, optional: true })],
    help: 'Use a NEW wallet made just for the bot holding only what it may trade. Ethereum network fees make small trades uneconomic.' },
  arbitrum: { kind: 'dex', name: 'Arbitrum wallet (EVM)', fields: [f('privateKey', 'Wallet private key', { placeholder: '0x…' }), f('rpcUrl', 'RPC URL (optional)', { secret: false, optional: true })],
    help: 'Use a NEW wallet made just for the bot holding only what it may trade. A private key can move everything in the wallet.' },
}
const RPC = { solana: 'https://api.mainnet-beta.solana.com', base: 'https://mainnet.base.org', ethereum: 'https://ethereum-rpc.publicnode.com', arbitrum: 'https://arb1.arbitrum.io/rpc' }
const NATIVE = { solana: 'SOL', base: 'ETH', ethereum: 'ETH', arbitrum: 'ETH' }

const hint = s => (s ? `…${String(s).slice(-4)}` : '')
const json = async r => { const t = await r.text(); try { return JSON.parse(t) } catch { return { _raw: t.slice(0, 200) } } }

/** Check the fields, work out what can be shown publicly (key hint, wallet address). Throws a plain-words error. */
export async function prepare(venue, input) {
  const v = VENUES[venue]
  if (!v) throw new Error('unknown exchange or wallet')
  const secrets = {}
  for (const fl of v.fields) {
    const val = String(input?.[fl.id] ?? '').trim()
    if (!val && !fl.optional) throw new Error(`${fl.label} is missing`)
    if (val.length > 4000) throw new Error(`${fl.label} is too long`)
    if (val) secrets[fl.id] = val
  }
  if (secrets.rpcUrl && !/^https:\/\/[^\s]+$/.test(secrets.rpcUrl)) throw new Error('RPC URL must start with https://')
  const pub = { hint: hint(secrets.apiKey) }
  if (v.kind === 'dex') pub.address = venue === 'solana' ? solanaAddress(secrets.privateKey) : await evmAddress(secrets.privateKey)
  return { secrets, pub }
}

// ---------------------------------------------------------------- wallets
function solanaSecret(pk) {
  const s = pk.trim()
  if (s.startsWith('[')) return Uint8Array.from(JSON.parse(s))
  return globalThis.__bs58.decode(s)
}
function solanaAddress(pk) {
  const sk = solanaSecret(pk)
  if (sk.length !== 64) throw new Error('A Solana private key is 64 bytes (base58 text or a [..] array of 64 numbers)')
  const kp = globalThis.__nacl.sign.keyPair.fromSecretKey(sk)
  if (Buffer.compare(Buffer.from(kp.publicKey), Buffer.from(sk.slice(32))) !== 0) throw new Error('That Solana key is not a valid keypair')
  return globalThis.__bs58.encode(kp.publicKey)
}
async function evmAddress(pk) {
  const { privateKeyToAccount } = await import('viem/accounts')
  const k = pk.startsWith('0x') ? pk : `0x${pk}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('An EVM private key is 64 hex characters (with or without 0x)')
  return privateKeyToAccount(k).address
}
export async function loadWalletLibs() {
  globalThis.__bs58 ||= (await import('bs58')).default
  globalThis.__nacl ||= (await import('tweetnacl')).default
}

// ---------------------------------------------------------------- read-only tests
/** { ok, summary, details, refuse? }: refuse = a reason the key must not be kept (e.g. it can withdraw). */
export async function testConnection(venue, s, pub, fetcher = globalThis.fetch) {
  const v = VENUES[venue]
  if (v.kind === 'dex') return testWallet(venue, s, pub, fetcher)
  if (venue === 'coinspot') {
    const bal = await new CoinSpotAdapter({ mode: 'live', key: s.apiKey, secret: s.apiSecret, fetch: fetcher }).getWalletBalance()
    return { ok: true, summary: `Connected. A$${bal.aud.toFixed(2)} and ${Object.keys(bal.coins).length} coin${Object.keys(bal.coins).length === 1 ? '' : 's'} in the wallet.`, details: { aud: bal.aud } }
  }
  if (venue === 'binance') {
    const q = `timestamp=${Date.now()}&recvWindow=10000`
    const sig = createHmac('sha256', s.apiSecret).update(q).digest('hex')
    const r = await fetcher(`https://api.binance.com/sapi/v1/account/apiRestrictions?${q}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': s.apiKey } })
    const j = await json(r)
    if (r.status === 451) return { ok: false, summary: "Binance refused the check because of the server's location. Saved, but not tested." }
    if (!r.ok) return { ok: false, summary: `Binance said: ${j.msg || j._raw || r.status}` }
    if (j.enableWithdrawals) return { ok: false, refuse: 'This key can WITHDRAW. Edit it on Binance, untick "Enable Withdrawals", then save it again.', summary: 'Refused: withdrawals enabled' }
    return { ok: true, summary: `Connected. Spot trading ${j.enableSpotAndMarginTrading ? 'on' : 'OFF (tick "Enable Spot & Margin Trading" on Binance)'}, withdrawals off${j.ipRestrict ? ', IP-restricted' : ''}.`, details: { trade: !!j.enableSpotAndMarginTrading, ipRestrict: !!j.ipRestrict } }
  }
  if (venue === 'kraken') {
    const path = '/0/private/Balance', nonce = String(Date.now() * 1000), body = `nonce=${nonce}`
    const sig = createHmac('sha512', Buffer.from(s.apiSecret, 'base64')).update(path).update(createHash('sha256').update(nonce + body).digest()).digest('base64')
    const r = await fetcher(`https://api.kraken.com${path}`, { method: 'POST', body, headers: { 'API-Key': s.apiKey, 'API-Sign': sig, 'content-type': 'application/x-www-form-urlencoded' } })
    const j = await json(r)
    if (j.error?.length) return { ok: false, summary: `Kraken said: ${j.error.join(', ')}` }
    return { ok: true, summary: `Connected. ${Object.keys(j.result || {}).length} balances visible. Kraken can't report whether the key can withdraw: make sure "Withdraw funds" is unticked.` }
  }
  if (venue === 'coinbase') {
    const uri = 'GET api.coinbase.com/api/v3/brokerage/key_permissions'
    const r = await fetcher('https://api.coinbase.com/api/v3/brokerage/key_permissions', { headers: { authorization: `Bearer ${coinbaseJwt(s.apiKey, s.apiSecret, uri)}` } })
    const j = await json(r)
    if (!r.ok) return { ok: false, summary: `Coinbase said: ${j.message || j.error || j._raw || r.status}` }
    if (j.can_transfer) return { ok: false, refuse: 'This key can TRANSFER funds out. Make a new key with only View and Trade, then save it again.', summary: 'Refused: transfer permission' }
    return { ok: true, summary: `Connected. Trading ${j.can_trade ? 'on' : 'OFF (give the key Trade permission)'}, transfers off.`, details: { trade: !!j.can_trade } }
  }
  return { ok: true, summary: 'Saved. No connection test for this exchange yet.' }
}

function b64url(b) { return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
export function coinbaseJwt(name, secret, uri, now = Math.floor(Date.now() / 1000)) {
  const pem = secret.includes('BEGIN') ? secret.replace(/\\n/g, '\n') : null
  const alg = pem ? 'ES256' : 'EdDSA'
  const header = { alg, kid: name, nonce: randomBytes(16).toString('hex'), typ: 'JWT' }
  const payload = { sub: name, iss: 'cdp', nbf: now, exp: now + 120, uri }
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  let key
  if (pem) key = createPrivateKey(pem)
  else {
    const raw = Buffer.from(secret, 'base64')
    if (raw.length < 32) throw new Error('Coinbase private key not recognised')
    key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' })
  }
  const sig = pem ? edSign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }) : edSign(null, Buffer.from(data), key)
  return `${data}.${b64url(sig)}`
}

async function testWallet(venue, s, pub, fetcher) {
  const url = s.rpcUrl || RPC[venue]
  const call = async (method, params) => {
    const r = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const j = await json(r)
    if (j.error || !r.ok) throw new Error(j.error?.message || j._raw || `RPC ${r.status}`)
    return j.result
  }
  try {
    const bal = venue === 'solana' ? (await call('getBalance', [pub.address])).value / 1e9 : Number(BigInt(await call('eth_getBalance', [pub.address, 'latest']))) / 1e18
    return { ok: true, summary: `Wallet ${pub.address.slice(0, 6)}…${pub.address.slice(-4)} found: ${bal.toFixed(5)} ${NATIVE[venue]} for network fees and trading.`, details: { native: bal } }
  } catch (e) { return { ok: false, summary: `Couldn't read the wallet: ${e.message}` } }
}
