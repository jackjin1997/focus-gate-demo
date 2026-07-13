import { describe, expect, it } from 'vitest'
import { isRealRuntimeLocation } from './runtime-mode'

describe('isRealRuntimeLocation', () => {
  it('uses real mode only on the loopback companion or explicit loopback development mode', () => {
    expect(isRealRuntimeLocation({ hostname: '127.0.0.1', port: '4317', search: '' })).toBe(true)
    expect(isRealRuntimeLocation({ hostname: 'localhost', port: '5173', search: '?mode=real' })).toBe(true)
    expect(isRealRuntimeLocation({ hostname: 'focus-gate-demo.vercel.app', port: '', search: '?mode=real' })).toBe(false)
    expect(isRealRuntimeLocation({ hostname: 'localhost', port: '5173', search: '' })).toBe(false)
  })
})
