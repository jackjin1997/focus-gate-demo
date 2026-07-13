import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}))

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
}))

import {
  authenticateReadPlan,
  registerHumanPresence,
  supportsHumanPresence,
} from './human-presence-client'

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('human presence client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports browser WebAuthn support without starting a ceremony', () => {
    expect(supportsHumanPresence()).toBe(true)
    expect(startRegistration).not.toHaveBeenCalled()
    expect(startAuthentication).not.toHaveBeenCalled()
  })

  it('registers a passkey only inside the explicit client call', async () => {
    const options = { challenge: 'registration-challenge' }
    const credential = { id: 'credential-1', response: {} }
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse(options))
      .mockImplementationOnce(() => jsonResponse({ verified: true }))
    vi.stubGlobal('fetch', fetchMock)
    startRegistration.mockResolvedValue(credential)

    await expect(registerHumanPresence()).resolves.toEqual({ verified: true })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/human-presence/registration/options',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    )
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: options })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/human-presence/registration/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ credential }),
      }),
    )
  })

  it('binds authentication and approval to the same read plan', async () => {
    const options = { challenge: 'authentication-challenge' }
    const credential = { id: 'credential-1', response: {} }
    const readResult = {
      runId: 'run-1',
      status: 'completed',
      itemCount: 0,
      coverage: 'bounded-search-unverified',
      rawDeleted: true,
    }
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse(options))
      .mockImplementationOnce(() => jsonResponse(readResult))
    vi.stubGlobal('fetch', fetchMock)
    startAuthentication.mockResolvedValue(credential)

    await expect(authenticateReadPlan({
      planId: 'plan-1',
      digest: 'sha256:plan-digest',
      approvalNonce: 'one-time-nonce',
    })).resolves.toEqual(readResult)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/read-plans/plan-1/presence/options',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
      }),
    )
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: options })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/read-plans/plan-1/approve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          digest: 'sha256:plan-digest',
          approvalNonce: 'one-time-nonce',
          presenceCredential: credential,
        }),
      }),
    )
  })
})
