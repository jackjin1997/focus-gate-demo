// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { SqliteHumanPresenceRepository } from './sqlite-human-presence-repository'

const repositories: SqliteHumanPresenceRepository[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
})

function setup() {
  const repository = new SqliteHumanPresenceRepository(':memory:')
  repositories.push(repository)
  return repository
}

describe('SqliteHumanPresenceRepository', () => {
  it('persists the local owner and opaque WebAuthn credential', async () => {
    const repository = setup()
    await repository.saveOwner({
      id: 'owner-1',
      userName: 'owner',
      displayName: '本机主人',
      webAuthnUserId: 'opaque-user-handle',
      createdAt: '2026-07-12T02:00:00.000Z',
      updatedAt: '2026-07-12T02:00:00.000Z',
    })
    await repository.saveCredential({
      ownerId: 'owner-1',
      id: 'credential-1',
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 4,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false,
      createdAt: '2026-07-12T02:00:01.000Z',
      lastUsedAt: null,
    })

    await expect(repository.getOwner('owner-1')).resolves.toMatchObject({
      webAuthnUserId: 'opaque-user-handle',
    })
    await expect(repository.getCredential('owner-1', 'credential-1')).resolves.toMatchObject({
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 4,
      transports: ['internal'],
    })
  })

  it('consumes a registration challenge atomically and only before expiry', async () => {
    const repository = setup()
    await repository.saveRegistrationChallenge({
      ownerId: 'owner-1',
      challenge: 'register-1',
      issuedAt: '2026-07-12T02:00:00.000Z',
      expiresAt: '2026-07-12T02:02:00.000Z',
      consumedAt: null,
    })

    await expect(repository.consumeRegistrationChallenge({
      ownerId: 'owner-1',
      challenge: 'register-1',
      consumedAt: '2026-07-12T02:01:00.000Z',
    })).resolves.toBe(true)
    await expect(repository.consumeRegistrationChallenge({
      ownerId: 'owner-1',
      challenge: 'register-1',
      consumedAt: '2026-07-12T02:01:01.000Z',
    })).resolves.toBe(false)
  })

  it('binds plan challenges and credential counters with compare-and-set', async () => {
    const repository = setup()
    await repository.savePlanAuthenticationChallenge({
      ownerId: 'owner-1',
      challenge: 'auth-1',
      planId: 'plan-1',
      planDigest: `sha256:${'a'.repeat(64)}`,
      issuedAt: '2026-07-12T02:00:00.000Z',
      expiresAt: '2026-07-12T02:02:00.000Z',
      consumedAt: null,
    })
    await repository.saveCredential({
      ownerId: 'owner-1',
      id: 'credential-1',
      publicKey: new Uint8Array([1]),
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      createdAt: '2026-07-12T02:00:00.000Z',
      lastUsedAt: null,
    })

    await expect(repository.consumePlanAuthenticationChallenge({
      ownerId: 'owner-1',
      challenge: 'auth-1',
      planId: 'plan-1',
      planDigest: `sha256:${'b'.repeat(64)}`,
      expiresAt: '2026-07-12T02:02:00.000Z',
      consumedAt: '2026-07-12T02:01:00.000Z',
    })).resolves.toBe(false)
    await expect(repository.consumePlanAuthenticationChallenge({
      ownerId: 'owner-1',
      challenge: 'auth-1',
      planId: 'plan-1',
      planDigest: `sha256:${'a'.repeat(64)}`,
      expiresAt: '2026-07-12T02:02:00.000Z',
      consumedAt: '2026-07-12T02:01:00.000Z',
    })).resolves.toBe(true)

    await expect(repository.compareAndSetCredentialCounter({
      ownerId: 'owner-1',
      credentialId: 'credential-1',
      expectedCounter: 0,
      newCounter: 1,
      usedAt: '2026-07-12T02:01:00.000Z',
    })).resolves.toBe(true)
    await expect(repository.compareAndSetCredentialCounter({
      ownerId: 'owner-1',
      credentialId: 'credential-1',
      expectedCounter: 0,
      newCounter: 2,
      usedAt: '2026-07-12T02:01:01.000Z',
    })).resolves.toBe(false)
  })

  it('commits challenge consumption and counter advancement in one transaction', async () => {
    const repository = setup()
    const challenge = {
      ownerId: 'owner-1',
      challenge: 'auth-atomic',
      planId: 'plan-1',
      planDigest: `sha256:${'a'.repeat(64)}`,
      issuedAt: '2026-07-12T02:00:00.000Z',
      expiresAt: '2026-07-12T02:02:00.000Z',
      consumedAt: null,
    }
    await repository.savePlanAuthenticationChallenge(challenge)
    await repository.saveCredential({
      ownerId: 'owner-1',
      id: 'credential-1',
      publicKey: new Uint8Array([1]),
      counter: 3,
      deviceType: 'singleDevice',
      backedUp: false,
      createdAt: '2026-07-12T02:00:00.000Z',
      lastUsedAt: null,
    })

    await expect(repository.commitPlanAuthentication({
      ...challenge,
      consumedAt: '2026-07-12T02:01:00.000Z',
      credentialId: 'credential-1',
      expectedCounter: 2,
      newCounter: 4,
    })).resolves.toBe('counter-conflict')
    await expect(repository.getPlanAuthenticationChallenge(
      'owner-1',
      'auth-atomic',
    )).resolves.toMatchObject({ consumedAt: null })

    await expect(repository.commitPlanAuthentication({
      ...challenge,
      consumedAt: '2026-07-12T02:01:01.000Z',
      credentialId: 'credential-1',
      expectedCounter: 3,
      newCounter: 4,
    })).resolves.toBe('committed')
    await expect(repository.getCredential('owner-1', 'credential-1')).resolves.toMatchObject({
      counter: 4,
      lastUsedAt: '2026-07-12T02:01:01.000Z',
    })
  })
})
