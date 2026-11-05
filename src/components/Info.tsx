import { useState, type ReactNode } from 'react'

/** Small (i) that reveals a plain-English explanation on tap. */
export function Info({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="info">
      <button type="button" aria-label="What does this mean?" aria-expanded={open} onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>i</button>
      {open && <span className="info-pop" role="note" onClick={() => setOpen(false)}>{children}</span>}
    </span>
  )
}

export function Disclosure({ title, children, defaultOpen = false }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="disclosure" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}
