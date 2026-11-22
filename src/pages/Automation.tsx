import { Link } from 'react-router-dom'
import AutomationPanel from '../components/AutomationPanel'

export default function Automation() {
  return (
    <main className="page narrow">
      <div className="page-head">
        <div className="eyebrow">Automation</div>
        <h1>Bot &amp; orders</h1>
        <p>The bot copies one lab's paper trades onto your real exchange account inside hard limits. Set the limits and the kill switch here; connect exchanges and switch paper or live on <Link to="/connections">Connections</Link>.</p>
      </div>
      <AutomationPanel />
    </main>
  )
}
