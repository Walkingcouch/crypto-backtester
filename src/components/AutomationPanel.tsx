import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { Disclosure, Info } from './Info'

interface Settings {
  kill_switch: boolean; max_order_aud: number; max_daily_spend_aud: number; min_wallet_buffer_aud: number; max_slippage_pct: number
  max_signal_age_min: number; crypto_source_lab: string; crypto_source_account: string; require_proven: boolean
  share_source_lab: string; share_order_aud: number; share_fee_aud: number; updated_at: string; updated_by: string | null
}
interface Order {
  id: number; created_at: string; idem_key: string; mode: string; venue: string; source: string; side: 'BUY' | 'SELL'; asset: string; market: string
  requested_aud: number | null; requested_amount: number | null; signal_price: number | null; quote_rate: number | null; filled_rate: number | null
  filled_amount: number | null; fee_aud: number | null; status: string; reason: string | null; raw: unknown
}
interface Status {
  who: string; mode: 'paper' | 'live'; keysSet: boolean; settings: Settings; wallet: { aud: number; coins: Record<string, number> } | null; walletError: string | null
  spent24h: number; remaining24h: number; orders: Order[]; webhook: boolean
}

const aud = (x: number | null | undefined) => x == null ? '–' : `A$${(+x).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (x: number | null | undefined, d = 6) => x == null ? '–' : (+x).toLocaleString('en-AU', { maximumFractionDigits: d })
const when = (iso: string) => {
  const t = new Date(iso)
  const darwin = t.toLocaleString('en-AU', { timeZone: 'Australia/Darwin', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  return <>{darwin} ACST<div className="muted small">{t.toISOString().slice(5, 16).replace('T', ' ')} UTC</div></>
}
const STATUS: Record<string, [string, string]> = {
  intent: ['Checking', 'amber'], rejected: ['Blocked', 'red'], paper_filled: ['Paper fill', 'green'], submitted: ['Sent', 'amber'], filled: ['Filled', 'green'],
  failed: ['Failed', 'red'], pending_manual: ['Waiting for you', 'amber'], executed_manual: ['Placed in Superhero', 'green'], dismissed: ['Dismissed', ''],
}
const FIELDS: [keyof Settings, string, string][] = [
  ['max_order_aud', 'Max per order (A$)', 'Hard cap on any single CoinSpot buy. Each signal buys exactly this amount.'],
  ['max_daily_spend_aud', 'Max spend per 24 h (A$)', 'Rolling 24-hour cap on CoinSpot buys.'],
  ['min_wallet_buffer_aud', 'Wallet reserve (A$)', 'A buy is refused if it would leave less AUD than this in the CoinSpot wallet.'],
  ['max_slippage_pct', 'Max slippage (%)', 'Refuse if the live quote is further than this from the signal price. Also sent to CoinSpot so it cancels the order if the price moves.'],
  ['max_signal_age_min', 'Max signal age (min)', 'Ignore buy signals older than this (for example after downtime).'],
  ['share_order_aud', 'Suggested per share order (A$)', 'Amount suggested for each Superhero order.'],
  ['share_fee_aud', 'Superhero brokerage (A$)', 'Logged against each confirmed share order.'],
]

export default function AutomationPanel() {
  const { session, ready } = useAuth()
  const [st, setSt] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<Partial<Settings>>({})
  const [fills, setFills] = useState<Record<string, { price: string; qty: string; fee: string }>>({})

  const call = useCallback(async (body?: object) => {
    if (!session) return null
    const r = await fetch('/api/exec-control', {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${session.access_token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || `error ${r.status}`)
    return j
  }, [session])
  const load = useCallback(async () => { try { setSt(await call()); setError('') } catch (e) { setError(String((e as Error).message)) } }, [call])
  useEffect(() => { if (session) load() }, [session, load])
  const act = async (body: object) => { setBusy(true); try { await call(body); await load() } catch (e) { setError(String((e as Error).message)) } finally { setBusy(false) } }

  if (!ready) return null
  if (!session) return <section className="card"><h2>Execution &amp; guardrails</h2><p className="muted">Sign in with an admin account to see wallet balances, orders and the kill switch. <Link to="/account">Sign in</Link></p></section>
  if (error && !st) return <section className="card"><h2>Execution &amp; guardrails</h2><div className="notice err">{error}</div></section>
  if (!st) return <section className="card"><h2>Execution &amp; guardrails</h2><p className="muted">Loading…</p></section>

  const S = st.settings
  const crypto = st.orders.filter(o => o.venue === 'coinspot')
  const pending = st.orders.filter(o => o.venue === 'superhero' && o.status === 'pending_manual')
  const shares = st.orders.filter(o => o.venue === 'superhero' && o.status !== 'pending_manual')
  const spentPct = Math.min(100, st.spent24h / S.max_daily_spend_aud * 100)
  const copyText = (o: Order) => `${o.side} ${o.asset} (${o.market}) · about ${aud(o.requested_aud)} · limit ${o.signal_price ?? '–'} ${o.market === 'US' ? 'USD' : 'AUD'} · ${o.source}`

  return (
    <>
      <section className="card">
        <div className="step-head" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Execution &amp; guardrails</h2>
          <span className={`tag ${st.mode === 'live' ? 'red' : 'green'}`} style={{ fontSize: 13 }}>{st.mode === 'live' ? 'LIVE · real money' : 'PAPER · simulated'}</span>
          {S.kill_switch && <span className="tag red" style={{ fontSize: 13 }}>KILL SWITCH ON</span>}
        </div>
        {error && <div className="notice err small">{error}</div>}
        <button
          className="btn btn-block" disabled={busy}
          style={{ margin: '12px 0', padding: '14px', fontSize: 16, fontWeight: 700, background: S.kill_switch ? 'var(--surface-2)' : 'var(--neg)', color: S.kill_switch ? 'var(--text)' : '#fff' }}
          onClick={() => act({ action: 'kill', on: !S.kill_switch })}
        >{S.kill_switch ? 'Kill switch is ON: tap to resume trading' : 'KILL SWITCH: stop all orders now'}</button>
        <div className="kpis">
          <div className="kpi"><div className="label">CoinSpot AUD {st.mode === 'paper' ? '(simulated)' : 'available'}</div><div className="value">{st.wallet ? aud(st.wallet.aud) : '–'}</div>
            <div className="sub">{st.walletError ? <span className="neg">{st.walletError}</span> : st.mode === 'live' && !st.keysSet ? 'API keys not set' : `reserve ${aud(S.min_wallet_buffer_aud)} never used`}</div></div>
          <div className="kpi"><div className="label">Spent in the last 24 h</div><div className="value">{aud(st.spent24h)}</div>
            <div className="sub">{aud(st.remaining24h)} left of {aud(S.max_daily_spend_aud)}</div>
            <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, marginTop: 6 }}><div style={{ width: `${spentPct}%`, height: 6, borderRadius: 3, background: spentPct >= 100 ? 'var(--neg)' : 'var(--accent)' }} /></div></div>
          <div className="kpi"><div className="label">Per order</div><div className="value">{aud(S.max_order_aud)}</div><div className="sub">slippage limit {S.max_slippage_pct}%</div></div>
        </div>
        <p className="small muted">
          Mirrors <b>{S.crypto_source_lab}</b> lab account <b>{S.crypto_source_account}</b>.{' '}
          {S.require_proven ? 'In live mode only rules that passed every professional check are mirrored.' : <span className="neg">Live mode will mirror unproven rules too.</span>}{' '}
          The bot never moves money in or out of CoinSpot: it can only buy and sell with what's already in the wallet.
          {st.mode === 'paper' && ' Switching to live is done only in Vercel (EXECUTION_MODE=live), never from this page.'}
        </p>
        <Disclosure title="Guardrail settings">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {FIELDS.map(([k, label, help]) => (
              <label key={k} className="small">{label} <Info>{help}</Info>
                <input className="input" type="number" step="any" defaultValue={String(S[k])} onChange={e => setEdit(x => ({ ...x, [k]: e.target.value }))} style={{ width: '100%' }} /></label>
            ))}
            <label className="small">Crypto lab to mirror
              <select className="input" defaultValue={S.crypto_source_lab} onChange={e => setEdit(x => ({ ...x, crypto_source_lab: e.target.value }))} style={{ width: '100%' }}>
                <option value="daytrade">Crypto day</option><option value="main">Crypto swing</option><option value="explorer">Crypto Explorer</option></select></label>
            <label className="small">Share lab to queue
              <select className="input" defaultValue={S.share_source_lab} onChange={e => setEdit(x => ({ ...x, share_source_lab: e.target.value }))} style={{ width: '100%' }}>
                <option value="stocks">Shares swing</option><option value="stocks-explore">Shares Explorer</option><option value="stocks-day">Shares day</option></select></label>
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" defaultChecked={S.require_proven} onChange={e => setEdit(x => ({ ...x, require_proven: e.target.checked }))} /> Live: proven rules only</label>
          </div>
          <button className="btn btn-primary btn-sm" disabled={busy || !Object.keys(edit).length} style={{ marginTop: 10 }} onClick={() => act({ action: 'settings', patch: edit }).then(() => setEdit({}))}>Save settings</button>
          <p className="muted small">Last changed {new Date(S.updated_at).toLocaleString('en-AU', { timeZone: 'Australia/Darwin' })}{S.updated_by ? ` by ${S.updated_by}` : ''}.</p>
        </Disclosure>
      </section>

      <section className="card">
        <h2>Pending Superhero share orders {pending.length > 0 && <span className="tag amber">{pending.length}</span>}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Superhero has no public trading API, so share signals wait here. Place the order in the Superhero app, then confirm the fill so profit and loss and capital gains records stay accurate.{st.webhook ? ' New orders are also sent to your notification webhook.' : ''}</p>
        {!pending.length ? <p className="muted small">Nothing waiting.</p> : pending.map(o => {
          const f = fills[o.idem_key] || { price: String(o.signal_price ?? ''), qty: '', fee: String(S.share_fee_aud) }
          const setF = (k: 'price' | 'qty' | 'fee', v: string) => setFills(x => ({ ...x, [o.idem_key]: { ...f, [k]: v } }))
          return (
            <div key={o.idem_key} className="explain-box" style={{ marginBottom: 10 }}>
              <div><span className={`tag ${o.side === 'BUY' ? 'green' : 'red'}`}>{o.side}</span> <b>{o.asset}</b> <span className="muted">({o.market})</span> · about {aud(o.requested_aud)} · limit {o.signal_price ?? '–'} {o.market === 'US' ? 'USD' : 'AUD'}</div>
              <div className="muted small">{o.source} · {when(o.created_at)}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(copyText(o))}>Copy order</button>
                <input className="input" placeholder="Fill price" value={f.price} onChange={e => setF('price', e.target.value)} style={{ width: 100 }} />
                <input className="input" placeholder="Quantity" value={f.qty} onChange={e => setF('qty', e.target.value)} style={{ width: 90 }} />
                <input className="input" placeholder="Fee A$" value={f.fee} onChange={e => setF('fee', e.target.value)} style={{ width: 70 }} />
                <button className="btn btn-primary btn-sm" disabled={busy || !f.price || !f.qty} onClick={() => act({ action: 'mark_executed', idem_key: o.idem_key, fill_price: f.price, quantity: f.qty, fee_aud: f.fee })}>Mark executed in Superhero</button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act({ action: 'dismiss', idem_key: o.idem_key })}>Dismiss</button>
              </div>
            </div>
          )
        })}
      </section>

      <section className="card">
        <h2>Order log</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Every trade intent, guardrail block and fill from the last 30 days, kept for debugging and tax records.</p>
        <div className="table-wrap"><table className="record">
          <thead><tr><th>Time</th><th>Order</th><th>Signal source</th><th>Price: signal → quote → filled</th><th>Amount</th><th>Fee</th><th>Status</th></tr></thead>
          <tbody>{[...crypto, ...shares].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(o => {
            const [label, color] = STATUS[o.status] || [o.status, '']
            return (
              <tr key={o.idem_key}>
                <td>{when(o.created_at)}</td>
                <td><span className={`tag ${o.side === 'BUY' ? 'green' : 'red'}`}>{o.side}</span> <b>{o.asset}</b><div className="muted small">{o.venue} · {o.mode}</div></td>
                <td className="small" style={{ minWidth: 140, whiteSpace: 'normal' }}>{o.source}</td>
                <td className="small">{num(o.signal_price)} → {num(o.quote_rate)} → <b>{num(o.filled_rate)}</b></td>
                <td className="small">{o.requested_aud != null ? aud(o.requested_aud) : ''}{o.filled_amount != null ? <div className="muted">{num(o.filled_amount, 8)} units</div> : null}</td>
                <td className="small">{aud(o.fee_aud)}</td>
                <td><span className={`tag ${color}`}>{label}</span>{o.reason && <div className="small muted" style={{ maxWidth: 260, whiteSpace: 'normal' }}>{o.reason}</div>}
                  {(o.status === 'failed' || o.status === 'rejected') && o.raw ? <details className="small"><summary>raw response</summary><pre style={{ whiteSpace: 'pre-wrap', maxWidth: 300 }}>{JSON.stringify(o.raw, null, 1)}</pre></details> : null}</td>
              </tr>
            )
          })}</tbody></table></div>
        {!st.orders.length && <p className="muted small">No orders yet. The job checks every 5 minutes.</p>}
      </section>
    </>
  )
}
