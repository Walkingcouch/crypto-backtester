import { Navigate, useSearchParams } from 'react-router-dom'
import Runs from './Runs'
import Ledger from './Ledger'

export default function History({ tab }: { tab: 'saved' | 'checks' }) {
  const [params] = useSearchParams()
  if (params.get('tab') === 'checks') return <Navigate to="/history/checks" replace />
  return (
    <main className="page narrow">
      <div className="page-head">
        <div className="eyebrow">History</div>
        <h1>{tab === 'saved' ? 'Saved results' : 'Final checks'}</h1>
      </div>
      {tab === 'saved' ? <Runs embedded /> : <Ledger embedded />}
    </main>
  )
}
