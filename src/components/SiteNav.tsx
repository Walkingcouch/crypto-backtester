import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useLocation } from 'react-router-dom'
import { SECTIONS, sectionOf } from '../lib/sitemap'

/** Top menu: one entry per section; sections with pages open a dropdown on hover, focus or tap. */
export function TopNav() {
  const loc = useLocation()
  const cur = sectionOf(loc.pathname)
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => setOpen(null), [loc.pathname, loc.search])
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])
  return (
    <nav className="nav nav-desktop" ref={ref} aria-label="Main">
      {SECTIONS.map(s => s.items.length ? (
        <div key={s.id} className={`nav-group ${open === s.id ? 'open' : ''}`} onMouseLeave={() => open === s.id && setOpen(null)}>
          <button type="button" className={cur?.id === s.id ? 'active' : ''} aria-expanded={open === s.id} aria-haspopup="true"
            onClick={() => setOpen(o => (o === s.id ? null : s.id))} onMouseEnter={() => setOpen(s.id)}>
            {s.label} <span className="caret" aria-hidden="true">▾</span>
          </button>
          <div className="nav-menu" role="menu">
            {s.items.map(i => (
              <NavLink key={i.to} to={i.to} end={i.end} role="menuitem">
                <span className="nm-label">{i.label}</span><span className="nm-hint">{i.hint}</span>
              </NavLink>
            ))}
          </div>
        </div>
      ) : <NavLink key={s.id} to={s.to} className={cur?.id === s.id ? 'active' : ''}>{s.label}</NavLink>)}
    </nav>
  )
}

/** Phones: a Menu button opening every section and page as one list. */
export function MobileMenu() {
  const loc = useLocation()
  const [open, setOpen] = useState(false)
  const cur = sectionOf(loc.pathname)
  useEffect(() => setOpen(false), [loc.pathname, loc.search])
  useEffect(() => { document.body.style.overflow = open ? 'hidden' : ''; return () => { document.body.style.overflow = '' } }, [open])
  return (
    <div className="nav-mobile">
      <button type="button" className="menu-btn" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">{open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}</svg>
        <span>{cur?.label || 'Menu'}</span>
      </button>
      {open && createPortal(<div className="menu-panel" role="menu">
        {SECTIONS.map(s => (
          <div key={s.id} className="mp-section">
            {s.items.length
              ? <><div className={`mp-head ${cur?.id === s.id ? 'active' : ''}`}>{s.label}</div>
                {s.items.map(i => <NavLink key={i.to} to={i.to} end={i.end} role="menuitem"><span className="nm-label">{i.label}</span><span className="nm-hint">{i.hint}</span></NavLink>)}</>
              : <NavLink to={s.to} className="mp-solo" role="menuitem">{s.label}</NavLink>}
          </div>
        ))}
      </div>, document.body)}
    </div>
  )
}

/** The current section's pages as a tab row under the header (hidden for one-page sections). */
export function SubNav() {
  const loc = useLocation()
  const s = sectionOf(loc.pathname)
  // phones: the tab row scrolls sideways, so keep the current page's tab in view
  useEffect(() => { document.querySelector('.subnav-inner a.active')?.scrollIntoView({ inline: 'center', block: 'nearest' }) }, [loc.pathname])
  if (!s || s.items.length < 2) return null
  return (
    <div className="subnav"><div className="subnav-inner" role="tablist" aria-label={s.label}>
      {s.items.map(i => <NavLink key={i.to} to={i.to} end={i.end} role="tab">{i.label}</NavLink>)}
    </div></div>
  )
}
