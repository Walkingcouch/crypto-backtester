import { useSearchParams } from 'react-router-dom'
import Runs from './Runs'
import Ledger from './Ledger'

export default function History() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'checks' ? 'checks' : 'saved'
  return (
    <main className="page narrow">
      <div className="page-head">
        <h1>History</h1>
        <div className="seg" style={{ maxWidth: 360 }}>
          <button className={tab === 'saved' ? 'on' : ''} onClick={() => setParams({})}>Saved results</button>
          <button className={tab === 'checks' ? 'on' : ''} onClick={() => setParams({ tab: 'checks' })}>Final checks</button>
        </div>
      </div>
      {tab === 'saved' ? <Runs embedded /> : <Ledger embedded />}
    </main>
  )
}
