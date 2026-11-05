import { useState } from 'react'
import { BROKERS, useBroker } from '../lib/brokers'

const NAME = Object.fromEntries(BROKERS.map(b => [b.id, b.name]))

/** Small badge for a coin: "✓ CoinSpot" or "Not on CoinSpot"; hover or tap to see every exchange that lists it. */
export default function WhereToBuy({ base, where, known, partial, compact = false }: { base: string; where: string[]; known: Set<string> | null; partial?: Set<string>; compact?: boolean }) {
  const { broker } = useBroker()
  const [open, setOpen] = useState(false)
  if (!known) return null
  const has = where.includes(broker.id)
  const unsure = !has && !!partial?.has(broker.id)          // exchange doesn't publish a full list
  const onMine = broker.id === 'other' ? null : has ? true : unsure ? null : known.has(broker.id) || broker.id === 'binance' ? false : null
  const others = BROKERS.filter(b => b.id !== 'other')
  const label = has ? `✓ ${broker.name}` : unsure ? `Check ${broker.name}` : onMine === false ? `Not on ${broker.name}` : `${where.length} exchanges`
  return (
    <span className={`wtb ${compact ? 'compact' : ''}`}
      onPointerEnter={e => { if (e.pointerType === 'mouse') setOpen(true) }}
      onPointerLeave={e => { if (e.pointerType === 'mouse') setOpen(false) }}
      onClick={e => { e.stopPropagation(); if ((e.nativeEvent as PointerEvent).pointerType !== 'mouse') setOpen(o => !o) }}>
      <span className={`tag ${has ? 'green' : unsure ? 'amber' : ''}`}>{label}</span>
      {open && (
        <span className="wtb-pop" role="tooltip">
          <b>Where to buy {base}</b>
          {others.map(b => {
            const yes = where.includes(b.id), checked = b.id === 'binance' || known.has(b.id), maybe = !yes && partial?.has(b.id)
            return (
              <span key={b.id} className={`wtb-row ${yes ? 'yes' : 'no'}`}>
                <span>{yes ? '✓' : maybe || !checked ? '?' : '✕'}</span><span className="wtb-name">{NAME[b.id]}</span>{maybe && <em>check app</em>}{b.id === broker.id && <em className="mine">yours</em>}
              </span>
            )
          })}
          <button className="wtb-close" onClick={e => { e.stopPropagation(); setOpen(false) }}>Close</button>
          <span className="wtb-foot">From each exchange's public coin list. ? = not in that exchange's public list; check its app.</span>
        </span>
      )}
    </span>
  )
}
