// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

import {
  HumanPresenceService,
  type HumanPresenceRepository,
  type OwnerIdentity,
  type PlanAuthenticationChallenge,
  type RegistrationChallenge,
  type StoredWebAuthnCredential,
  type WebAuthnServer,
} from './index'

const NOW = '2026-07-12T02:00:00.000Z'
const EXPIRES_AT = '2026-07-12T02:02:00.000Z'
const PLAN_DIGEST = `sha256:${'a'.repeat(64)}`

const ownerInput = {
  id: 'local-owner',
  userName: 'jack',
  displayName: 'Jack',
}

const registrationResponse: RegistrationResponseJSON = {
  id: 'credential-1',
  rawId: 'credential-1',
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    clientDataJSON: Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: 'registration-challenge',
        origin: 'http://localhost:4317',
      }),
    ).toString('base64url'),
    attestationObject: 'attestation',
    transports: ['internal'],
  },
}

const authenticationResponse: AuthenticationResponseJSON = {
  id: 'credential-1',
  rawId: 'credential-1',
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    clientDataJSON: Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: 'authentication-challenge',
        origin: 'http://localhost:4317',
      }),
    ).toString('base64url'),
    authenticatorData: 'authenticator-data',
    signature: 'signature',
  },
}

function registrationOptions(
  challenge = 'registration-challenge',
): PublicKeyCredentialCreationOptionsJSON {
  return {
    rp: { id: 'localhost', name: '专注之门' },
    user: { id: 'user-handle', name: 'jack', displayName: 'Jack' },
    challenge,
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
  }
}

function authenticationOptions(
  challenge = 'authentication-challenge',
): PublicKeyCredentialRequestOptionsJSON {
  return {
    challenge,
    rpId: 'localhost',
    userVerification: 'required',
  }
}

class MemoryHumanPresenceRepository implements HumanPresenceRepository {
  owners = new Map<string, OwnerIdentity>()
  credentials = new Map<string, StoredWebAuthnCredential>()
  registrationChallenges = new Map<string, RegistrationChallenge>()
  authenticationChallenges = new Map<string, PlanAuthenticationChallenge>()

  async getOwner(ownerId: string) {
    return this.owners.get(ownerId) ?? null
  }

  async saveOwner(owner: OwnerIdentity) {
    this.owners.set(owner.id, structuredClone(owner))
  }

  async listCredentials(ownerId: string) {
    return [...this.credentials.values()].filter(
      (credential) => credential.ownerId === ownerId,
    )
  }

  async getCredential(ownerId: string, credentialId: string) {
    const credential = this.credentials.get(credentialId)
    return credential?.ownerId === ownerId ? credential : null
  }

  async saveCredential(credential: StoredWebAuthnCredential) {
    this.credentials.set(credential.id, structuredClone(credential))
  }

  async compareAndSetCredentialCounter(input: {
    ownerId: string
    credentialId: string
    expectedCounter: number
    newCounter: number
    usedAt: string
  }) {
    const credential = this.credentials.get(input.credentialId)
    if (
      !credential ||
      credential.ownerId !== input.ownerId ||
      credential.counter !== input.expectedCounter
    ) {
      return false
    }

    this.credentials.set(input.credentialId, {
      ...credential,
      counter: input.newCounter,
      lastUsedAt: input.usedAt,
    })
    return true
  }

  async saveRegistrationChallenge(challenge: RegistrationChallenge) {
    this.registrationChallenges.set(
      challenge.challenge,
      structuredClone(challenge),
    )
  }

  async getRegistrationChallenge(ownerId: string, challenge: string) {
    const stored = this.registrationChallenges.get(challenge)
    return stored?.ownerId === ownerId ? stored : null
  }

  async consumeRegistrationChallenge(input: {
    ownerId: string
    challenge: string
    consumedAt: string
  }) {
    const stored = await this.getRegistrationChallenge(
      input.ownerId,
      input.challenge,
    )
    if (
      !stored ||
      stored.consumedAt !== null ||
      input.consumedAt >= stored.expiresAt
    ) {
      return false
    }

    this.registrationChallenges.set(input.challenge, {
      ...stored,
      consumedAt: input.consumedAt,
    })
    return true
  }

  async savePlanAuthenticationChallenge(challenge: PlanAuthenticationChallenge) {
    this.authenticationChallenges.set(
      challenge.challenge,
      structuredClone(challenge),
    )
  }

  async getPlanAuthenticationChallenge(ownerId: string, challenge: string) {
    const stored = this.authenticationChallenges.get(challenge)
    return stored?.ownerId === ownerId ? stored : null
  }

  async consumePlanAuthenticationChallenge(input: {
    ownerId: string
    challenge: string
    planId: string
    planDigest: string
    expiresAt: string
    consumedAt: string
  }) {
    const stored = await this.getPlanAuthenticationChallenge(
      input.ownerId,
      input.challenge,
    )
    if (
      !stored ||
      stored.consumedAt !== null ||
      input.consumedAt >= stored.expiresAt ||
      stored.planId !== input.planId ||
      stored.planDigest !== input.planDigest ||
      stored.expiresAt !== input.expiresAt
    ) {
      return false
    }

    this.authenticationChallenges.set(input.challenge, {
      ...stored,
      consumedAt: input.consumedAt,
    })
    return true
  }

  async commitPlanAuthentication(input: {
    ownerId: string
    challenge: string
    planId: string
    planDigest: string
    expiresAt: string
    consumedAt: string
    credentialId: string
    expectedCounter: number
    newCounter: number
  }) {
    const stored = await this.getPlanAuthenticationChallenge(
      input.ownerId,
      input.challenge,
    )
    const credential = await this.getCredential(input.ownerId, input.credentialId)
    if (
      !stored ||
      stored.consumedAt !== null ||
      input.consumedAt < stored.issuedAt ||
      input.consumedAt >= stored.expiresAt ||
      stored.planId !== input.planId ||
      stored.planDigest !== input.planDigest ||
      stored.expiresAt !== input.expiresAt
    ) return 'challenge-rejected' as const
    if (!credential || credential.counter !== input.expectedCounter) {
      return 'counter-conflict' as const
    }

    this.authenticationChallenges.set(input.challenge, {
      ...stored,
      consumedAt: input.consumedAt,
    })
    this.credentials.set(input.credentialId, {
      ...credential,
      counter: input.newCounter,
      lastUsedAt: input.consumedAt,
    })
    return 'committed' as const
  }
}

function createWebAuthn(): WebAuthnServer {
  return {
    generateRegistrationOptions: vi
      .fn()
      .mockResolvedValue(registrationOptions()),
    verifyRegistrationResponse: vi.fn().mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: {
          id: 'credential-1',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
        credentialType: 'public-key',
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://localhost:4317',
        rpID: 'localhost',
      },
    }),
    generateAuthenticationOptions: vi
      .fn()
      .mockResolvedValue(authenticationOptions()),
    verifyAuthenticationResponse: vi.fn().mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: 'credential-1',
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://localhost:4317',
        rpID: 'localhost',
      },
    }),
  }
}

function setup() {
  const repository = new MemoryHumanPresenceRepository()
  const webAuthn = createWebAuthn()
  let currentTime = NOW
  const service = new HumanPresenceService({
    repository,
    webAuthn,
    now: () => new Date(currentTime),
    randomBytes: () => new Uint8Array([7, 8, 9, 10]),
  })

  return {
    repository,
    service,
    webAuthn,
    setNow: (value: string) => {
      currentTime = value
    },
  }
}

async function registerCredential(
  setupResult: ReturnType<typeof setup>,
): Promise<void> {
  await setupResult.service.generateRegistration({
    owner: ownerInput,
    expiresAt: EXPIRES_AT,
  })
  await setupResult.service.verifyRegistration({
    ownerId: ownerInput.id,
    response: registrationResponse,
  })
}

describe('HumanPresenceService registration', () => {
  it('uses the installed SimpleWebAuthn v13 generator without a browser', async () => {
    const repository = new MemoryHumanPresenceRepository()
    const service = new HumanPresenceService({
      repository,
      now: () => new Date(NOW),
      randomBytes: () => new Uint8Array([7, 8, 9, 10]),
    })

    await expect(
      service.generateRegistration({ owner: ownerInput, expiresAt: EXPIRES_AT }),
    ).resolves.toMatchObject({
      rp: { id: 'localhost', name: '专注之门' },
      user: { name: 'jack', displayName: 'Jack' },
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
    })
  })

  it('requires a platform authenticator and verified user, then stores the challenge', async () => {
    const { repository, service, webAuthn } = setup()

    await expect(
      service.generateRegistration({ owner: ownerInput, expiresAt: EXPIRES_AT }),
    ).resolves.toMatchObject({
      challenge: 'registration-challenge',
    })

    expect(webAuthn.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'localhost',
        rpName: '专注之门',
        authenticatorSelection: expect.objectContaining({
          authenticatorAttachment: 'platform',
          userVerification: 'required',
        }),
      }),
    )
    expect(repository.owners.get(ownerInput.id)).toMatchObject({
      ...ownerInput,
      webAuthnUserId: 'BwgJCg',
    })
    expect(repository.registrationChallenges.get('registration-challenge')).toEqual({
      ownerId: ownerInput.id,
      challenge: 'registration-challenge',
      issuedAt: NOW,
      expiresAt: EXPIRES_AT,
      consumedAt: null,
    })
  })

  it('verifies the fixed origin and RP, stores the v13 credential, and consumes once', async () => {
    const { repository, service, webAuthn } = setup()
    await service.generateRegistration({ owner: ownerInput, expiresAt: EXPIRES_AT })

    await expect(
      service.verifyRegistration({
        ownerId: ownerInput.id,
        response: registrationResponse,
      }),
    ).resolves.toMatchObject({
      ownerId: ownerInput.id,
      credentialId: 'credential-1',
      verifiedAt: NOW,
    })

    expect(webAuthn.verifyRegistrationResponse).toHaveBeenCalledWith({
      response: registrationResponse,
      expectedChallenge: 'registration-challenge',
      expectedOrigin: 'http://localhost:4317',
      expectedRPID: 'localhost',
      requireUserPresence: true,
      requireUserVerification: true,
    })
    expect(repository.credentials.get('credential-1')).toMatchObject({
      ownerId: ownerInput.id,
      id: 'credential-1',
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false,
    })

    await expect(
      service.verifyRegistration({
        ownerId: ownerInput.id,
        response: registrationResponse,
      }),
    ).rejects.toMatchObject({
      code: 'REGISTRATION_CHALLENGE_CONSUMED',
    })
  })
})

describe('HumanPresenceService plan authentication', () => {
  it('generates required-user-verification options and persists the exact plan binding', async () => {
    const result = setup()
    await registerCredential(result)

    await expect(
      result.service.generatePlanAuthentication({
        ownerId: ownerInput.id,
        planId: 'plan-1',
        planDigest: PLAN_DIGEST,
        expiresAt: EXPIRES_AT,
      }),
    ).resolves.toMatchObject({
      challenge: 'authentication-challenge',
      userVerification: 'required',
    })

    expect(result.webAuthn.generateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: 'localhost',
      allowCredentials: [{ id: 'credential-1', transports: ['internal'] }],
      timeout: 120_000,
      userVerification: 'required',
    })
    expect(
      result.repository.authenticationChallenges.get('authentication-challenge'),
    ).toEqual({
      ownerId: ownerInput.id,
      challenge: 'authentication-challenge',
      planId: 'plan-1',
      planDigest: PLAN_DIGEST,
      issuedAt: NOW,
      expiresAt: EXPIRES_AT,
      consumedAt: null,
    })
  })

  it('rejects a changed plan binding before invoking WebAuthn verification', async () => {
    const result = setup()
    await registerCredential(result)
    await result.service.generatePlanAuthentication({
      ownerId: ownerInput.id,
      planId: 'plan-1',
      planDigest: PLAN_DIGEST,
      expiresAt: EXPIRES_AT,
    })

    await expect(
      result.service.verifyPlanAuthentication({
        ownerId: ownerInput.id,
        planId: 'plan-1',
        planDigest: `sha256:${'b'.repeat(64)}`,
        response: authenticationResponse,
      }),
    ).rejects.toMatchObject({
      code: 'PLAN_BINDING_MISMATCH',
    })
    expect(result.webAuthn.verifyAuthenticationResponse).not.toHaveBeenCalled()
    expect(
      result.repository.authenticationChallenges.get('authentication-challenge'),
    ).toMatchObject({ consumedAt: null })
  })

  it('verifies against the stored credential, consumes once, and advances its counter', async () => {
    const result = setup()
    await registerCredential(result)
    await result.service.generatePlanAuthentication({
      ownerId: ownerInput.id,
      planId: 'plan-1',
      planDigest: PLAN_DIGEST,
      expiresAt: EXPIRES_AT,
    })

    const input = {
      ownerId: ownerInput.id,
      planId: 'plan-1',
      planDigest: PLAN_DIGEST,
      response: authenticationResponse,
    } as const

    result.setNow('2026-07-12T02:01:00.000Z')

    await expect(result.service.verifyPlanAuthentication(input)).resolves.toEqual({
      ownerId: ownerInput.id,
      credentialId: 'credential-1',
      planId: 'plan-1',
      planDigest: PLAN_DIGEST,
      expiresAt: EXPIRES_AT,
      verifiedAt: '2026-07-12T02:01:00.000Z',
    })

    expect(result.webAuthn.verifyAuthenticationResponse).toHaveBeenCalledWith({
      response: authenticationResponse,
      expectedChallenge: 'authentication-challenge',
      expectedOrigin: 'http://localhost:4317',
      expectedRPID: 'localhost',
      credential: {
        id: 'credential-1',
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ['internal'],
      },
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
    })
    expect(result.repository.credentials.get('credential-1')).toMatchObject({
      counter: 1,
      lastUsedAt: '2026-07-12T02:01:00.000Z',
    })

    await expect(
      result.service.verifyPlanAuthentication(input),
    ).rejects.toMatchObject({
      code: 'PLAN_AUTHENTICATION_CHALLENGE_CONSUMED',
    })
  })

  it('rejects an expired challenge without consuming it or verifying a signature', async () => {
    const result = setup()
    await registerCredential(result)
    await result.service.generatePlanAuthentication({
      ownerId: ownerInput.id,
      planId: 'plan-1',
      planDigest: PLAN_DIGEST,
      expiresAt: EXPIRES_AT,
    })
    result.setNow(EXPIRES_AT)

    await expect(
      result.service.verifyPlanAuthentication({
        ownerId: ownerInput.id,
        planId: 'plan-1',
        planDigest: PLAN_DIGEST,
        response: authenticationResponse,
      }),
    ).rejects.toMatchObject({
      code: 'PLAN_AUTHENTICATION_CHALLENGE_EXPIRED',
    })
    expect(result.webAuthn.verifyAuthenticationResponse).not.toHaveBeenCalled()
    expect(
      result.repository.authenticationChallenges.get('authentication-challenge'),
    ).toMatchObject({ consumedAt: null })
  })

  it('rechecks expiry after asynchronous signature verification finishes', async () => {
    const result = setup()
    await registerCredential(result)
    await result.service.generatePlanAuthentication({
      ownerId: ownerInput.id,
      planId: 'plan-1',
      planDigest: PLAN_DIGEST,
      expiresAt: EXPIRES_AT,
    })
    result.setNow('2026-07-12T02:01:59.999Z')
    vi.mocked(result.webAuthn.verifyAuthenticationResponse).mockImplementation(async () => {
      result.setNow(EXPIRES_AT)
      return {
        verified: true,
        authenticationInfo: {
          credentialID: 'credential-1',
          newCounter: 1,
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost:4317',
          rpID: 'localhost',
        },
      }
    })

    await expect(result.service.verifyPlanAuthentication({
      ownerId: ownerInput.id,
      planId: 'plan-1',
      planDigest: PLAN_DIGEST,
      response: authenticationResponse,
    })).rejects.toMatchObject({
      code: 'PLAN_AUTHENTICATION_CHALLENGE_EXPIRED',
    })
    expect(
      result.repository.authenticationChallenges.get('authentication-challenge'),
    ).toMatchObject({ consumedAt: null })
  })
})
