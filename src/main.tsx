import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FocusGateDemo } from './focus-gate-demo'
import './global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FocusGateDemo />
  </StrictMode>,
)
