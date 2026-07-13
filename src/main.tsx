import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FocusGateDemo } from './focus-gate-demo'
import { RealFocusGate } from './real-focus-gate'
import { isRealRuntimeLocation } from './runtime-mode'
import './global.css'

const App = isRealRuntimeLocation(window.location) ? RealFocusGate : FocusGateDemo

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
