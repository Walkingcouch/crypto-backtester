import { NavLink, Route, Routes, Link } from 'react-router-dom'
import Backtest from './pages/Backtest'
import Guide from './pages/Guide'
import Ledger from './pages/Ledger'
import Runs from './pages/Runs'
import Account from './pages/Account'
import { useAuth } from './lib/auth'
import { cloudEnabled } from './lib/supabase'

export default function App() {
  const { session, name } = useAuth()
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /></svg>
            </span>
            Backtester
          </Link>
          <nav className="nav">
            <NavLink to="/" end>Backtest</NavLink>
            <NavLink to="/guide">Guide</NavLink>
            <NavLink to="/runs">Saved runs</NavLink>
            <NavLink to="/ledger">Test ledger</NavLink>
          </nav>
          {cloudEnabled && (
            <Link to="/account" className="btn btn-ghost btn-sm">{session ? name || 'Account' : 'Sign in'}</Link>
          )}
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Backtest />} />
        <Route path="/guide" element={<Guide />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/ledger" element={<Ledger />} />
        <Route path="/account" element={<Account />} />
        <Route path="*" element={<div className="page empty">Page not found. <Link to="/">Back to backtest</Link></div>} />
      </Routes>
      <footer className="footer">
        <div className="page">
          Backtests are simulations on past prices, not predictions, and nothing here is financial advice.
          Price data: Binance public market data.
        </div>
      </footer>
    </>
  )
}
