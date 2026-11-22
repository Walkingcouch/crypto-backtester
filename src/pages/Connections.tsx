import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'

interface Field { id: string; label: string; secret: boolean; optional?: boolean; placeholder?: string; multiline?: boolean }
interface Venue { kind: 'cex' | 'dex'; name: string; bot: boolean; help: string; fields: Field[] }
interface Test { at?: string; ok: boolean; summary: string; refuse?: string }
interface Conn { owner: string; venue: string; kind: 'cex' | 'dex'; label: string | null; public_info: { hint?: string; address?: string }; status: string; last_test: Test | null; updated_at: string; updated_by: string; mine: boolean }
interface Status { who: string; me: string; vaultReady: boolean; migrated: boolean | null; migrationError: string | null; venues: Record<string, Venue>; connections: Conn[]; modes: Record<string, { mode: 'paper' | 'live'; from: 'site' | 'vercel' }> }

const STATUS: Record<string, [string, string]> = { ok: ['Connected', 'green'], untested: ['Saved, not tested', ''], failing: ['Test failing', 'red'], refused: ['Refused', 'red'] }
const when = (s?: string) => (s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '')

export default function Connections() {
  const { session, ready } = useAuth()
  const [st, setSt] = useState<Status | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const call = useCallback(async (body?: object) => {
    const r = await fetch('/api/connections', { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${session!.access_token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { data: j })
    return j
  }, [session])
  const load = useCallback(async () => { try { setSt(await call()); setErr(null) } catch (e) { setErr((e as Error).message) } }, [call])
  useEffect(() => { if (session) void load() }, [session, load])

  if (!ready) return <main className="page"><div className="empty">Loading…</div></main>
  if (!session) return <main className="page narrow"><div className="card"><h1>Connections</h1><p>Sign in with an admin account to manage exchange and wallet connections.</p><Link className="btn btn-primary" to="/account" state={{ from: '/connections' }}>Sign in</Link></div></main>

  const mine = st?.connections.filter(c => c.mine) || []
  const others = st?.connections.filter(c => !c.mine) || []
  const act = async (label: string, body: object) => { setBusy(label); setErr(null); try { const j = await call(body); await load(); return j } catch (e) { setErr((e as Error).message); return null } finally { setBusy('') } }

  return (
    <main className="page narrow">
      <div className="page-head">
        <div className="eyebrow">Automation</div>
        <h1>Connections</h1>
        <p className="muted">Connect exchanges and bot wallets from here instead of Vercel. Keys are encrypted on the server before they're saved, never shown again, and never sent to any browser. Each person connects their own; you can see others' connections but not change them.</p>
        <p className="small"><Link to="/markets?view=auto">← Back to Automation</Link></p>
      </div>
      {err && <div className="notice err">{err}</div>}
      {!st ? <div className="empty">Loading connections…</div> : <>
        {!st.vaultReady && <VaultSetup call={call} />}
        {st.vaultReady && st.migrated === false && (
          <section className="card"><h2>One more step: the database table</h2>
            <p>Open Supabase → SQL Editor → New query, paste the file <code>supabase/migrations/0013_connections.sql</code> from GitHub, and press Run. Then reload this page.</p>
            <p className="muted small">{st.migrationError}</p></section>
        )}
        {st.vaultReady && st.migrated && <>
          <ModeCard st={st} busy={busy} act={act} hasCoinspot={mine.some(c => c.venue === 'coinspot')} />
          <section className="card">
            <h2>Your connections ({st.me})</h2>
            {mine.length ? <div className="conn-list">{mine.map(c => <ConnRow key={c.venue} c={c} v={st.venues[c.venue]} busy={busy} act={act} />)}</div> : <p className="muted">Nothing connected yet.</p>}
            <AddForm st={st} busy={busy} act={act} existing={mine.map(c => c.venue)} />
          </section>
          {others.length > 0 && (
            <section className="card">
              <h2>Other people's connections</h2>
              <p className="muted small" style={{ marginTop: 0 }}>View only. Their keys stay theirs: your bot never uses them.</p>
              <div className="table-wrap"><table className="record stack-sm">
                <thead><tr><th>Person</th><th>Exchange / wallet</th><th>Status</th><th>Key / address</th><th>Updated</th></tr></thead>
                <tbody>{others.map(c => <tr key={c.owner + c.venue}><td>{c.owner}</td><td>{st.venues[c.venue]?.name || c.venue}</td><td><span className={`tag ${STATUS[c.status]?.[1] || ''}`}>{STATUS[c.status]?.[0] || c.status}</span></td><td className="mono small">{c.public_info.address ? `${c.public_info.address.slice(0, 6)}…${c.public_info.address.slice(-4)}` : c.public_info.hint}</td><td className="small">{when(c.updated_at)}</td></tr>)}</tbody>
              </table></div>
            </section>
          )}
          <p className="hint">The bot trades on CoinSpot today. Binance, Kraken, Coinbase and DEX wallets can be connected and tested now; the bot starts trading on them once their order connectors are built. Every change here sends a phone alert (once alerts are set up).</p>
        </>}
      </>}
    </main>
  )
}

function VaultSetup({ call }: { call: (b?: object) => Promise<{ key?: string }> }) {
  const [key, setKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  return (
    <section className="card">
      <h2>First-time setup: an encryption key</h2>
      <p>Saved keys are locked with a master key that lives only in Vercel, so the database never holds anything readable. This is the last thing you'll add in Vercel by hand.</p>
      {!key ? <button className="btn btn-primary" onClick={async () => { try { setKey((await call({ action: 'genkey' })).key || null) } catch { /* shown on reload */ } }}>Create my master key</button> : <>
        <div className="notice warn small">Shown once. Copy it now: it isn't stored anywhere until you add it to Vercel.</div>
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}><code className="mono" style={{ wordBreak: 'break-all', flex: 1 }}>{key}</code>
          <button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard.writeText(key); setCopied(true) }}>{copied ? 'Copied ✓' : 'Copy'}</button></div>
        <ol className="small" style={{ paddingLeft: 20 }}>
          <li>Vercel → your project → Settings → Environment Variables → Add.</li>
          <li>Name <code>CONNECTIONS_KEY</code>, paste the value, tick all environments, mark it Sensitive, Save.</li>
          <li>Deployments → the latest one → ⋯ → Redeploy. Then reload this page.</li>
        </ol>
        <p className="muted small">Keep a copy somewhere safe (a password manager). If this key is lost or changed, saved connections can't be opened and must be added again.</p>
      </>}
    </section>
  )
}

function ModeCard({ st, busy, act, hasCoinspot }: { st: Status; busy: string; act: (l: string, b: object) => Promise<unknown>; hasCoinspot: boolean }) {
  const m = st.modes[st.me] || { mode: 'paper', from: 'vercel' }
  const [confirm, setConfirm] = useState('')
  const [open, setOpen] = useState(false)
  return (
    <section className="card">
      <h2>Your bot: <span className={`tag ${m.mode === 'live' ? 'red' : ''}`}>{m.mode === 'live' ? 'LIVE · real money' : 'Paper · simulated'}</span></h2>
      <p className="muted small" style={{ marginTop: 0 }}>{m.from === 'site' ? 'Set on this page.' : 'Currently set by Vercel (EXECUTION_MODE). Choosing here takes over from Vercel.'} The guardrails (per-order cap, daily cap, wallet reserve, kill switch) apply in both.</p>
      {m.mode === 'live'
        ? <button className="btn btn-ghost" disabled={!!busy} onClick={() => act('mode', { action: 'mode', mode: 'paper' })}>Switch to paper</button>
        : !open ? <button className="btn btn-ghost" disabled={!hasCoinspot && m.from !== 'vercel'} onClick={() => setOpen(true)}>Switch to live…</button>
          : <form onSubmit={async e => { e.preventDefault(); await act('mode', { action: 'mode', mode: 'live', confirm }); setOpen(false); setConfirm('') }}>
            <label className="field"><span>Type <b>LIVE</b> to trade real money on CoinSpot</span><input value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="off" /></label>
            <div className="flex" style={{ gap: 8 }}><button className="btn btn-primary" disabled={confirm !== 'LIVE' || !!busy}>Go live</button><button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button></div>
          </form>}
    </section>
  )
}

function ConnRow({ c, v, busy, act }: { c: Conn; v?: Venue; busy: string; act: (l: string, b: object) => Promise<unknown> }) {
  const [s, color] = STATUS[c.status] || [c.status, '']
  return (
    <div className="conn">
      <div className="conn-head"><b>{v?.name || c.venue}</b> <span className={`tag ${color}`}>{s}</span>{v?.bot && <span className="tag green">Bot trades here</span>}{c.kind === 'dex' && <span className="tag red">Wallet key</span>}</div>
      <div className="small mono">{c.public_info.address || (c.public_info.hint ? `Key ${c.public_info.hint}` : '')}</div>
      {c.last_test && <div className="small muted">{c.last_test.summary} {c.last_test.at && `(${when(c.last_test.at)})`}</div>}
      <div className="flex" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => act('test' + c.venue, { action: 'test', venue: c.venue })}>{busy === 'test' + c.venue ? 'Testing…' : 'Test'}</button>
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => { if (confirm(`Remove the ${v?.name || c.venue} connection? The bot stops using it straight away.`)) void act('del' + c.venue, { action: 'delete', venue: c.venue }) }}>Remove</button>
      </div>
    </div>
  )
}

function AddForm({ st, busy, act, existing }: { st: Status; busy: string; act: (l: string, b: object) => Promise<unknown>; existing: string[] }) {
  const [venue, setVenue] = useState('')
  const [vals, setVals] = useState<Record<string, string>>({})
  const [ack, setAck] = useState(false)
  const [result, setResult] = useState<Test | null>(null)
  const v = st.venues[venue]
  const opts = (k: 'cex' | 'dex') => Object.entries(st.venues).filter(([, x]) => x.kind === k)
  return (
    <form style={{ marginTop: 16 }} onSubmit={async e => {
      e.preventDefault(); setResult(null)
      const j = await act('save', { action: 'save', venue, fields: vals }) as { test?: Test } | null
      if (j?.test) { setResult(j.test); setVals({}); setAck(false) }
    }}>
      <h3>{existing.length ? 'Add or replace a connection' : 'Add a connection'}</h3>
      <label className="field"><span>Exchange or wallet</span>
        <select value={venue} onChange={e => { setVenue(e.target.value); setVals({}); setAck(false); setResult(null) }}>
          <option value="">Choose…</option>
          <optgroup label="Exchanges (API keys)">{opts('cex').map(([id, x]) => <option key={id} value={id}>{x.name}{existing.includes(id) ? ' (replace)' : ''}</option>)}</optgroup>
          <optgroup label="DEX wallets (private keys)">{opts('dex').map(([id, x]) => <option key={id} value={id}>{x.name}{existing.includes(id) ? ' (replace)' : ''}</option>)}</optgroup>
        </select></label>
      {v && <>
        <p className="small muted">{v.help}</p>
        {v.kind === 'dex' && <div className="notice err small">A wallet private key can send everything in that wallet anywhere: it can't be limited to trading. It's stored encrypted and the bot will only ever use it to swap, but if the server or the master key were ever exposed, the wallet could be emptied. Use a separate wallet holding only what you're prepared to lose.</div>}
        {v.fields.map(f => (
          <label key={f.id} className="field"><span>{f.label}{f.optional ? ' (optional)' : ''}</span>
            {f.multiline
              ? <textarea rows={4} className="mono" spellCheck={false} autoComplete="off" placeholder={f.placeholder} value={vals[f.id] || ''} onChange={e => setVals(x => ({ ...x, [f.id]: e.target.value }))} />
              : <input type={f.secret ? 'password' : 'text'} spellCheck={false} autoComplete="off" placeholder={f.placeholder} value={vals[f.id] || ''} onChange={e => setVals(x => ({ ...x, [f.id]: e.target.value }))} />}
          </label>
        ))}
        {v.kind === 'dex' && <label className="toggle-row"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> I understand this key can move all funds in the wallet, and I'm using a wallet only for the bot.</label>}
        <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={!!busy || (v.kind === 'dex' && !ack) || v.fields.some(f => !f.optional && !(vals[f.id] || '').trim())}>{busy === 'save' ? 'Encrypting and testing…' : 'Save and test'}</button>
      </>}
      {result && <div className={`notice ${result.ok ? 'info' : 'warn'} small`} style={{ marginTop: 10 }}>{result.summary}</div>}
    </form>
  )
}
