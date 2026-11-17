import { NavLink, Route, Routes, Link, Navigate } from 'react-router-dom'
import Guide from './pages/Guide'
import History from './pages/History'
import Markets from './pages/Markets'
import Predict from './pages/Predict'
import Picks from './pages/Picks'
import { LabDay, LabExplore, LabSwing, SharesDay, SharesExplore, SharesSwing } from './pages/Lab'
import Account from './pages/Account'
import EconCalendar from './pages/EconCalendar'
import { useAuth } from './lib/auth'
import { cloudEnabled } from './lib/supabase'
import { useCurrency, type Cur } from './lib/currency'

export default function App() {
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
          <nav className="nav">
            <NavLink to="/markets">Markets</NavLink>
            <NavLink to="/predict">Predict</NavLink>
            <NavLink to="/picks">Picks</NavLink>
            <NavLink to="/lab">Crypto lab</NavLink>
            <NavLink to="/shares">Shares lab</NavLink>
            <NavLink to="/history">History</NavLink>
            <NavLink to="/guide">Guide</NavLink>
          </nav>
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
            <Link to="/account" className="btn btn-ghost btn-sm">{session ? name || 'Account' : 'Sign in'}</Link>
          )}
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Navigate to="/markets" replace />} />
        <Route path="/guide" element={<Guide />} />
        <Route path="/history" element={<History />} />
        <Route path="/markets" element={<Markets />} />
        <Route path="/predict" element={<Predict />} />
        <Route path="/picks" element={<Picks />} />
        <Route path="/lab" element={<LabSwing />} />
        <Route path="/lab/explore" element={<LabExplore />} />
        <Route path="/lab/daytrade" element={<LabDay />} />
        <Route path="/shares" element={<SharesSwing />} />
        <Route path="/shares/explore" element={<SharesExplore />} />
        <Route path="/shares/daytrade" element={<SharesDay />} />
        <Route path="/shares/calendar" element={<EconCalendar />} />
        <Route path="/lab/stocks" element={<Navigate to="/shares" replace />} />
        <Route path="/runs" element={<Navigate to="/history" replace />} />
        <Route path="/ledger" element={<Navigate to="/history?tab=checks" replace />} />
        <Route path="/account" element={<Account />} />
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
