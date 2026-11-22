// The site's structure in one place: the top menu, its dropdowns, the mobile menu and the tab row
// under the header all come from this list, so a page is always under the same heading everywhere.
export interface Item { to: string; label: string; hint: string; end?: boolean; admin?: boolean }
export interface Section { id: string; label: string; to: string; items: Item[]; match: RegExp }

export const SECTIONS: Section[] = [
  { id: 'today', label: 'Today', to: '/today', match: /^\/today/, items: [] },
  { id: 'markets', label: 'Markets', to: '/markets', match: /^\/(markets|predict|picks)/, items: [
    { to: '/markets', label: 'Coins', hint: 'Every coin ranked, compared and filtered', end: true },
    { to: '/markets/flow', label: 'Smart money & news', hint: 'Politicians, insiders, whales and the crowd' },
    { to: '/markets/calendar', label: 'Economic calendar', hint: 'Rate decisions and data that move markets' },
    { to: '/predict', label: 'Predictions', hint: 'Where a coin could be, and how accurate that has been' },
    { to: '/picks', label: 'Picks test', hint: 'A simple weekly coin-picking strategy, back-tested' },
  ] },
  { id: 'crypto', label: 'Crypto lab', to: '/lab', match: /^\/lab/, items: [
    { to: '/lab', label: 'Swing rules', hint: 'Fixed menu of rules held for days', end: true },
    { to: '/lab/explore', label: 'New ideas', hint: 'Rules the Explorer invents and tests' },
    { to: '/lab/daytrade', label: 'Day trading', hint: 'Hourly rules closed by end of day' },
  ] },
  { id: 'shares', label: 'Shares lab', to: '/shares', match: /^\/shares/, items: [
    { to: '/shares', label: 'Swing rules', hint: 'US and ASX shares held for days', end: true },
    { to: '/shares/explore', label: 'New ideas', hint: 'Share rules the Explorer invents' },
    { to: '/shares/daytrade', label: 'Day trading', hint: 'Intraday share rules' },
  ] },
  { id: 'automation', label: 'Automation', to: '/automation', match: /^\/(automation|connections)/, items: [
    { to: '/automation', label: 'Bot & orders', hint: 'Guardrails, kill switch and the order log' },
    { to: '/connections', label: 'Connections', hint: 'Exchange keys, wallets, paper or live' },
  ] },
  { id: 'history', label: 'History', to: '/history', match: /^\/history/, items: [
    { to: '/history', label: 'Saved results', hint: 'Back-tests you saved', end: true },
    { to: '/history/checks', label: 'Final checks', hint: 'One-time checks on held-back data' },
  ] },
  { id: 'guide', label: 'Guide', to: '/guide', match: /^\/guide/, items: [] },
]

export const sectionOf = (path: string) => SECTIONS.find(s => s.match.test(path)) || null
