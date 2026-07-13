// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { HumanPresenceRepository } from '../security/human-presence'
import { HumanPresenceApplication } from './human-presence-application'

const credential = { id: 'credential-1' }

function setup(input?: { registered?: boolean }) {
  const service = {
    generateRegistration: vi.fn().mockResolvedValue({ challenge: 'register' }),
    verifyRegistration: vi.fn().mockResolvedValue({ credentialId: 'credential-1' }),
    generatePlanAuthentication: vi.fn().mockResolvedValue({ challenge: 'authenticate' }),
    verifyPlanAuthentication: vi.fn().mockResolvedValue({ credentialId: 'credential-1' }),
  }
  const repository = {
    listCredentials: vi.fn().mockResolvedValue(input?.registered ? [credential] : []),
  } as unknown as HumanPresenceRepository
  const application = new HumanPresenceApplication({
    service,
    repository,
    now: () => new Date('2026-07-12T02:00:00.000Z'),
  })
  return { application, service, repository }
}

describe('HumanPresenceApplication', () => {
  it('reports whether this Mac already has an owner passkey', async () => {
    const unregistered = setup()
    const registered = setup({ registered: true })

    await expect(unregistered.application.status()).resolves.toEqual({
      registered: false,
      method: 'passkey',
    })
    await expect(registered.application.status()).resolves.toEqual({
      registered: true,
      method: 'passkey',
    })
  })

  it('issues a short registration ceremony only while no credential exists', async () => {
    const { application, service } = setup()

    await expect(application.registrationOptions()).resolves.toEqual({ challenge: 'register' })
    expect(service.generateRegistration).toHaveBeenCalledWith({
      owner: {
        id: 'focus-gate-local-owner',
        userName: 'focus-gate-owner',
        displayName: '专注之门本机主人',
      },
      expiresAt: '2026-07-12T02:02:00.000Z',
    })

    const registered = setup({ registered: true })
    await expect(registered.application.registrationOptions()).rejects.toThrow(
      'HUMAN_PRESENCE_ALREADY_REGISTERED',
    )
  })

  it('never accepts challenge or expiry from the registration client', async () => {
    const { application, service } = setup()
    const response = { id: 'credential-1' } as RegistrationResponseJSON

    await application.verifyRegistration(response)

    expect(service.verifyRegistration).toHaveBeenCalledWith({
      ownerId: 'focus-gate-local-owner',
      response,
    })
  })

  it('caps plan authentication at two minutes and binds the exact server plan', async () => {
    const { application, service } = setup({ registered: true })
    const binding = {
      planId: 'plan-1',
      digest: `sha256:${'a'.repeat(64)}`,
      expiresAt: '2026-07-12T02:05:00.000Z',
    }

    await application.planAuthenticationOptions(binding)

    expect(service.generatePlanAuthentication).toHaveBeenCalledWith({
      ownerId: 'focus-gate-local-owner',
      planId: binding.planId,
      planDigest: binding.digest,
      expiresAt: '2026-07-12T02:02:00.000Z',
    })
  })

  it('verifies the credential against a freshly inspected server binding', async () => {
    const { application, service } = setup({ registered: true })
    const binding = {
      planId: 'plan-1',
      digest: `sha256:${'a'.repeat(64)}`,
      expiresAt: '2026-07-12T02:05:00.000Z',
    }
    const response = { id: 'credential-1' } as AuthenticationResponseJSON

    await application.verifyPlanAuthentication(binding, response)

    expect(service.verifyPlanAuthentication).toHaveBeenCalledWith({
      ownerId: 'focus-gate-local-owner',
      planId: binding.planId,
      planDigest: binding.digest,
      response,
    })
  })
})
