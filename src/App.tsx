import { Route, Routes, Link, Navigate, useLocation } from 'react-router-dom'
import { MobileMenu, SubNav, TopNav } from './components/SiteNav'
import AutomationPage from './pages/Automation'
import Brief from './pages/Brief'
import Guide from './pages/Guide'
import History from './pages/History'
import Markets from './pages/Markets'
import Predict from './pages/Predict'
import Picks from './pages/Picks'
import { LabDay, LabExplore, LabSwing, SharesDay, SharesExplore, SharesSwing } from './pages/Lab'
import Account from './pages/Account'
import Connections from './pages/Connections'
import EconCalendar from './pages/EconCalendar'
import { useAuth } from './lib/auth'
import { cloudEnabled } from './lib/supabase'
import { useCurrency, type Cur } from './lib/currency'

export default function App() {
  const loc = useLocation()
  const here = loc.pathname === '/account' ? '/' : loc.pathname + loc.search
  const { session, name } = useAuth()
  const { cur, setCur } = useCurrency()
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/markets" className="brand">
            <span className="brand-mark">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /></svg>
            </span>
            <span className="brand-name">Backtester</span>
          </Link>
          <TopNav />
          <MobileMenu />
          <button className="refresh-btn" onClick={() => window.location.reload()} title="Refresh" aria-label="Refresh the page">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
          </button>
          <label className="cur-select" title="Show prices in">
            <span className="sr-only">Currency</span>
            <select value={cur} onChange={e => setCur(e.target.value as Cur)} aria-label="Currency">
              <option value="AUD">AUD</option>
              <option value="USD">USD</option>
            </select>
          </label>
          {cloudEnabled && (
            <Link to="/account" state={{ from: here }} className="btn btn-ghost btn-sm">{session ? name || 'Account' : 'Sign in'}</Link>
          )}
        </div>
      </header>
      <SubNav />
      <Routes>
        <Route path="/" element={<Navigate to="/markets" replace />} />
        <Route path="/today" element={<Brief />} />
        <Route path="/guide" element={<Guide />} />
        <Route path="/markets" element={<Markets view="coins" />} />
        <Route path="/markets/flow" element={<Markets view="flow" />} />
        <Route path="/markets/calendar" element={<EconCalendar />} />
        <Route path="/predict" element={<Predict />} />
        <Route path="/picks" element={<Picks />} />
        <Route path="/lab" element={<LabSwing />} />
        <Route path="/lab/explore" element={<LabExplore />} />
        <Route path="/lab/daytrade" element={<LabDay />} />
        <Route path="/shares" element={<SharesSwing />} />
        <Route path="/shares/explore" element={<SharesExplore />} />
        <Route path="/shares/daytrade" element={<SharesDay />} />
        <Route path="/automation" element={<AutomationPage />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/history" element={<History tab="saved" />} />
        <Route path="/history/checks" element={<History tab="checks" />} />
        <Route path="/account" element={<Account />} />
        {/* old addresses keep working */}
        <Route path="/shares/calendar" element={<Navigate to="/markets/calendar" replace />} />
        <Route path="/lab/stocks" element={<Navigate to="/shares" replace />} />
        <Route path="/runs" element={<Navigate to="/history" replace />} />
        <Route path="/ledger" element={<Navigate to="/history/checks" replace />} />
        <Route path="*" element={<div className="page empty">Page not found. <Link to="/markets">Back to Markets</Link></div>} />
      </Routes>
      <footer className="footer">
        <div className="page">
          Backtests are simulations on past prices, not predictions, and nothing here is financial advice.
          Price data: Binance public market data (crypto) and Yahoo Finance (shares).
        </div>
      </footer>
    </>
  )
}
