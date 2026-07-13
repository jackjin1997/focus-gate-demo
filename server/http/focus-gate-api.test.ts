// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FocusGateApplication, type LarkGateway } from '../application/focus-gate-application'
import type { HumanPresenceApplication } from '../application/human-presence-application'
import type { RecentMessageWindow, StandardLarkMessage } from '../infrastructure/lark-cli'
import { FocusGateStore } from '../infrastructure/sqlite/focus-gate-store'
import { createFocusGateApi } from './focus-gate-api'

class FakeGateway implements LarkGateway {
  reads = 0
  userOpenId = 'ou_current_user'

  async reviewCapabilities() {
    return {
      cliVersion: '1.0.26',
      authenticated: true,
      identity: 'user' as const,
      userOpenId: this.userOpenId,
      scopes: ['search:message'],
      eventKeys: ['im.message.receive_v1'],
    }
  }

  async readRecentMessages(_window: RecentMessageWindow): Promise<readonly StandardLarkMessage[]> {
    this.reads += 1
    return []
  }
}

const stores: FocusGateStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function setup() {
  const store = new FocusGateStore(':memory:')
  stores.push(store)
  const lark = new FakeGateway()
  let id = 0
  const application = new FocusGateApplication({
    store,
    lark,
    now: () => new Date('2026-07-12T02:00:00.000Z'),
    createId: (prefix) => `${prefix}-${++id}`,
  })
  const humanPresence = {
    status: vi.fn().mockResolvedValue({ registered: true, method: 'passkey' }),
    registrationOptions: vi.fn().mockResolvedValue({ challenge: 'registration-challenge' }),
    verifyRegistration: vi.fn().mockResolvedValue({ verified: true }),
    planAuthenticationOptions: vi.fn().mockResolvedValue({ challenge: 'plan-challenge' }),
    verifyPlanAuthentication: vi.fn().mockResolvedValue({
      ownerId: 'focus-gate-local-owner',
      credentialId: 'credential-1',
      verifiedAt: '2026-07-12T02:00:00.000Z',
    }),
  } as unknown as HumanPresenceApplication
  return {
    app: createFocusGateApi({ application, humanPresence }),
    lark,
    humanPresence,
  }
}

const trustedHeaders = {
  Origin: 'http://localhost:4317',
  'Content-Type': 'application/json',
}

const presenceCredential = {
  id: 'credential-1',
  response: { clientDataJSON: 'signed-client-data' },
}

describe('Focus Gate loopback API', () => {
  it('exposes health without inspecting Feishu', async () => {
    const { app, lark } = setup()

    const response = await app.request('/api/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ready', mode: 'local-real' })
    expect(lark.reads).toBe(0)
  })

  it('rejects cross-origin write requests before application code runs', async () => {
    const { app, lark } = setup()

    const response = await app.request('/api/capability-reviews', {
      method: 'POST',
      headers: { ...trustedHeaders, Origin: 'https://malicious.example' },
    })

    expect(response.status).toBe(403)
    expect(lark.reads).toBe(0)
  })

  it('keeps research and preview read-only, then rejects a changed manifest digest', async () => {
    const { app, lark } = setup()

    const research = await app.request('/api/capability-reviews', {
      method: 'POST',
      headers: trustedHeaders,
    })
    expect(research.status).toBe(200)

    const previewResponse = await app.request('/api/read-plans', {
      method: 'POST',
      headers: trustedHeaders,
      body: JSON.stringify({
        lookbackMinutes: 10,
        source: 'all-visible',
        includeAttachments: false,
        retention: 'delete-raw-on-digest',
      }),
    })
    const preview = await previewResponse.json() as {
      plan: { id: string; digest: string }
      approvalNonce: string
    }
    expect(lark.reads).toBe(0)

    const rejected = await app.request(`/api/read-plans/${preview.plan.id}/approve`, {
      method: 'POST',
      headers: trustedHeaders,
      body: JSON.stringify({
        digest: 'sha256:changed',
        approvalNonce: preview.approvalNonce,
        presenceCredential,
      }),
    })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'READ_PLAN_MISMATCH' })
    expect(lark.reads).toBe(0)
  })

  it('rejects direct approval without a verified human-presence credential', async () => {
    const { app, lark, humanPresence } = setup()
    await app.request('/api/capability-reviews', {
      method: 'POST',
      headers: trustedHeaders,
    })
    const previewResponse = await app.request('/api/read-plans', {
      method: 'POST',
      headers: trustedHeaders,
      body: JSON.stringify({
        lookbackMinutes: 10,
        source: 'all-visible',
        includeAttachments: false,
        retention: 'delete-raw-on-digest',
      }),
    })
    const preview = await previewResponse.json() as {
      plan: { id: string; digest: string }
      approvalNonce: string
    }

    const response = await app.request(`/api/read-plans/${preview.plan.id}/approve`, {
      method: 'POST',
      headers: trustedHeaders,
      body: JSON.stringify({
        digest: preview.plan.digest,
        approvalNonce: preview.approvalNonce,
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ code: 'INVALID_APPROVAL_REQUEST' })
    expect(humanPresence.verifyPlanAuthentication).not.toHaveBeenCalled()
    expect(lark.reads).toBe(0)
  })

  it('runs registration and plan authentication as explicit separate ceremonies', async () => {
    const { app, humanPresence, lark } = setup()

    const registrationOptions = await app.request('/api/human-presence/registration/options', {
      method: 'POST',
      headers: trustedHeaders,
      body: '{}',
    })
    expect(registrationOptions.status).toBe(200)

    const registration = await app.request('/api/human-presence/registration/verify', {
      method: 'POST',
      headers: trustedHeaders,
      body: JSON.stringify({ credential: presenceCredential }),
    })
    expect(registration.status).toBe(200)

    await app.request('/api/capability-reviews', { method: 'POST', headers: trustedHeaders })
    const previewResponse = await app.request('/api/read-plans', {
      method: 'POST',
      headers: trustedHeaders,
      body: JSON.stringify({
        lookbackMinutes: 10,
        source: 'all-visible',
        includeAttachments: false,
        retention: 'delete-raw-on-digest',
      }),
    })
    const preview = await previewResponse.json() as { plan: { id: string; digest: string } }
    const authOptions = await app.request(
      `/api/read-plans/${preview.plan.id}/presence/options`,
      { method: 'POST', headers: trustedHeaders, body: '{}' },
    )

    expect(authOptions.status).toBe(200)
    expect(humanPresence.registrationOptions).toHaveBeenCalledTimes(1)
    expect(humanPresence.verifyRegistration).toHaveBeenCalledWith(presenceCredential)
    expect(humanPresence.planAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ planId: preview.plan.id, digest: preview.plan.digest }),
    )
    expect(lark.reads).toBe(0)
  })

  it('executes an exact grant once and refuses replay', async () => {
    const { app, lark } = setup()
    await app.request('/api/capability-reviews', {
      method: 'POST',
      headers: trustedHeaders,
    })
    const previewResponse = await app.request('/api/read-plans', {
      method: 'POST',
      headers: trustedHeaders,
      body: JSON.stringify({
        lookbackMinutes: 10,
        source: 'all-visible',
        includeAttachments: false,
        retention: 'delete-raw-on-digest',
      }),
    })
    const preview = await previewResponse.json() as {
      plan: { id: string; digest: string }
      approvalNonce: string
    }
    const approvalBody = JSON.stringify({
      digest: preview.plan.digest,
      approvalNonce: preview.approvalNonce,
      presenceCredential,
    })

    const approved = await app.request(`/api/read-plans/${preview.plan.id}/approve`, {
      method: 'POST',
      headers: trustedHeaders,
      body: approvalBody,
    })
    expect(approved.status).toBe(200)
    expect(lark.reads).toBe(1)

    const replay = await app.request(`/api/read-plans/${preview.plan.id}/approve`, {
      method: 'POST',
      headers: trustedHeaders,
      body: approvalBody,
    })
    expect(replay.status).toBe(409)
    expect(await replay.json()).toMatchObject({ code: 'READ_PLAN_ALREADY_CLAIMED' })
    expect(lark.reads).toBe(1)
  })

  it('returns a stable conflict when the Feishu account changed after review', async () => {
    const { app, lark } = setup()
    await app.request('/api/capability-reviews', {
      method: 'POST',
      headers: trustedHeaders,
    })
    const previewResponse = await app.request('/api/read-plans', {
      method: 'POST',
      headers: trustedHeaders,
      body: JSON.stringify({
        lookbackMinutes: 10,
        source: 'all-visible',
        includeAttachments: false,
        retention: 'delete-raw-on-digest',
      }),
    })
    const preview = await previewResponse.json() as {
      plan: { id: string; digest: string; accountFingerprint: string }
      approvalNonce: string
    }
    expect(preview.plan.accountFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    lark.userOpenId = 'ou_other_user'

    const response = await app.request(`/api/read-plans/${preview.plan.id}/approve`, {
      method: 'POST',
      headers: trustedHeaders,
      body: JSON.stringify({
        digest: preview.plan.digest,
        approvalNonce: preview.approvalNonce,
        presenceCredential,
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'READ_PLAN_IDENTITY_CHANGED' })
    expect(lark.reads).toBe(0)
  })
})
