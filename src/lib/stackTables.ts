// On phones, tables marked `stack-sm` show one card per row (see styles.css). Each cell needs its
// column name as data-label; rather than repeat that in every component, copy it from the header.
const label = (th: Element) => {
  const c = th.cloneNode(true) as Element
  c.querySelectorAll('.info').forEach(n => n.remove())
  return (c.textContent || '').replace(/\s+/g, ' ').trim()
}
function labelTable(t: HTMLTableElement) {
  const heads = t.tHead?.rows[0]
  if (!heads) return
  const names: string[] = []
  for (const th of Array.from(heads.cells)) for (let i = 0; i < (th.colSpan || 1); i++) names.push(label(th))
  for (const body of Array.from(t.tBodies)) for (const tr of Array.from(body.rows)) {
    let col = 0
    for (const td of Array.from(tr.cells)) {
      const n = names[col] ?? ''
      if (!td.hasAttribute('data-label') || td.getAttribute('data-auto') === '1') { td.setAttribute('data-label', n); td.setAttribute('data-auto', '1') }
      col += td.colSpan || 1
    }
  }
}
export function watchStackTables() {
  if (typeof window === 'undefined' || !('MutationObserver' in window)) return
  let queued = false
  const run = () => { queued = false; document.querySelectorAll<HTMLTableElement>('table.stack-sm').forEach(labelTable) }
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run) } }).observe(document.body, { childList: true, subtree: true, characterData: true })
  run()
}
