import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './lib/auth'
import { LockGate } from './components/AppLock'
import { CurrencyProvider } from './lib/currency'
import { BrokerProvider } from './lib/brokers'
import './styles.css'
import { watchStackTables } from './lib/stackTables'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <CurrencyProvider>
          <BrokerProvider>
            <LockGate><App /></LockGate>
          </BrokerProvider>
        </CurrencyProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
watchStackTables()
