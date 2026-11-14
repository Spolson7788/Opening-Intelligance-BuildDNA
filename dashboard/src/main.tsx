import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { consumeFieldGateReturn } from '../../field-app/src/lib/siteAccess.ts'

if (typeof window !== "undefined") {
  consumeFieldGateReturn(window.sessionStorage, window.location.pathname, (url) => window.location.replace(url));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
