import { randomBytes as nodeRandomBytes } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers'

import { HumanPresenceError } from './errors'
import type { HumanPresenceRepository } from './repository'
import type {
  GeneratePlanAuthenticationInput,
  GenerateRegistrationInput,
  OwnerIdentity,
  PlanAuthenticationChallenge,
  PlanAuthenticationProof,
  RegistrationChallenge,
  RegistrationProof,
  VerifyPlanAuthenticationInput,
  VerifyRegistrationInput,
} from './types'

export const HUMAN_PRESENCE_RP = Object.freeze({
  name: '专注之门',
  id: 'localhost',
  origin: 'http://localhost:4317',
})

export interface WebAuthnServer {
  readonly generateRegistrationOptions: typeof generateRegistrationOptions
  readonly verifyRegistrationResponse: typeof verifyRegistrationResponse
  readonly generateAuthenticationOptions: typeof generateAuthenticationOptions
  readonly verifyAuthenticationResponse: typeof verifyAuthenticationResponse
}

const defaultWebAuthn: WebAuthnServer = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
}

export class HumanPresenceService {
  private readonly repository: HumanPresenceRepository
  private readonly webAuthn: WebAuthnServer
  private readonly now: () => Date
  private readonly randomBytes: (length: number) => Uint8Array

  constructor(input: {
    readonly repository: HumanPresenceRepository
    readonly webAuthn?: WebAuthnServer
    readonly now?: () => Date
    readonly randomBytes?: (length: number) => Uint8Array
  }) {
    this.repository = input.repository
    this.webAuthn = input.webAuthn ?? defaultWebAuthn
    this.now = input.now ?? (() => new Date())
    this.randomBytes = input.randomBytes ?? ((length) => nodeRandomBytes(length))
  }

  async generateRegistration(input: GenerateRegistrationInput) {
    validateOwner(input.owner)
    const issuedAt = this.now().toISOString()
    const timeout = challengeTimeout(issuedAt, input.expiresAt)
    const existingOwner = await this.repository.getOwner(input.owner.id)
    const owner: OwnerIdentity = existingOwner
      ? {
          ...existingOwner,
          userName: input.owner.userName,
          displayName: input.owner.displayName,
          updatedAt: issuedAt,
        }
      : {
          ...input.owner,
          webAuthnUserId: toBase64Url(this.randomBytes(32)),
          createdAt: issuedAt,
          updatedAt: issuedAt,
        }
    const credentials = await this.repository.listCredentials(owner.id)

    const options = await this.webAuthn.generateRegistrationOptions({
      rpName: HUMAN_PRESENCE_RP.name,
      rpID: HUMAN_PRESENCE_RP.id,
      userID: fromBase64Url(owner.webAuthnUserId),
      userName: owner.userName,
      userDisplayName: owner.displayName,
      timeout,
      attestationType: 'none',
      excludeCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports ? [...credential.transports] : undefined,
      })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
      preferredAuthenticatorType: 'localDevice',
    })

    const challenge: RegistrationChallenge = {
      ownerId: owner.id,
      challenge: options.challenge,
      issuedAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
    }
    await this.repository.saveOwner(owner)
    await this.repository.saveRegistrationChallenge(challenge)

    return options
  }

  async verifyRegistration(
    input: VerifyRegistrationInput,
  ): Promise<RegistrationProof> {
    assertNonEmpty('ownerId', input.ownerId)
    const presentedAt = this.now().toISOString()
    const presentedChallenge = extractChallenge(
      input.response.response.clientDataJSON,
      'REGISTRATION_VERIFICATION_FAILED',
    )

    const owner = await this.repository.getOwner(input.ownerId)
    if (!owner) throw new HumanPresenceError('OWNER_NOT_FOUND')

    const challenge = await this.repository.getRegistrationChallenge(
      input.ownerId,
      presentedChallenge,
    )
    if (!challenge) {
      throw new HumanPresenceError('REGISTRATION_CHALLENGE_NOT_FOUND')
    }
    assertPendingChallenge(
      challenge,
      presentedAt,
      'REGISTRATION_CHALLENGE_CONSUMED',
      'REGISTRATION_CHALLENGE_EXPIRED',
      'REGISTRATION_CHALLENGE_NOT_YET_VALID',
    )

    let verification
    try {
      verification = await this.webAuthn.verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: HUMAN_PRESENCE_RP.origin,
        expectedRPID: HUMAN_PRESENCE_RP.id,
        requireUserPresence: true,
        requireUserVerification: true,
      })
    } catch (error) {
      throw new HumanPresenceError('REGISTRATION_VERIFICATION_FAILED', {
        cause: error,
      })
    }

    if (!verification.verified || !verification.registrationInfo.userVerified) {
      throw new HumanPresenceError('REGISTRATION_VERIFICATION_FAILED')
    }

    const verifiedAt = this.now().toISOString()
    assertPendingChallenge(
      challenge,
      verifiedAt,
      'REGISTRATION_CHALLENGE_CONSUMED',
      'REGISTRATION_CHALLENGE_EXPIRED',
      'REGISTRATION_CHALLENGE_NOT_YET_VALID',
    )

    const consumed = await this.repository.consumeRegistrationChallenge({
      ownerId: input.ownerId,
      challenge: challenge.challenge,
      consumedAt: verifiedAt,
    })
    if (!consumed) {
      throw new HumanPresenceError('REGISTRATION_CHALLENGE_CONSUMED')
    }

    const { credential } = verification.registrationInfo
    await this.repository.saveCredential({
      ownerId: owner.id,
      id: credential.id,
      publicKey: credential.publicKey.slice(),
      counter: credential.counter,
      transports: credential.transports
        ? [...credential.transports]
        : undefined,
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
      createdAt: verifiedAt,
      lastUsedAt: null,
    })

    return {
      ownerId: owner.id,
      credentialId: credential.id,
      verifiedAt,
    }
  }

  async generatePlanAuthentication(input: GeneratePlanAuthenticationInput) {
    validatePlanReference(input)
    const issuedAt = this.now().toISOString()
    const timeout = challengeTimeout(issuedAt, input.expiresAt)
    const owner = await this.repository.getOwner(input.ownerId)
    if (!owner) throw new HumanPresenceError('OWNER_NOT_FOUND')

    const credentials = await this.repository.listCredentials(owner.id)
    if (credentials.length === 0) {
      throw new HumanPresenceError('CREDENTIAL_NOT_REGISTERED')
    }

    const options = await this.webAuthn.generateAuthenticationOptions({
      rpID: HUMAN_PRESENCE_RP.id,
      allowCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports ? [...credential.transports] : undefined,
      })),
      timeout,
      userVerification: 'required',
    })

    const challenge: PlanAuthenticationChallenge = {
      ownerId: owner.id,
      challenge: options.challenge,
      planId: input.planId,
      planDigest: input.planDigest,
      issuedAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
    }
    await this.repository.savePlanAuthenticationChallenge(challenge)

    return options
  }

  async verifyPlanAuthentication(
    input: VerifyPlanAuthenticationInput,
  ): Promise<PlanAuthenticationProof> {
    validatePlanReference(input)
    const presentedAt = this.now().toISOString()
    const presentedChallenge = extractChallenge(
      input.response.response.clientDataJSON,
      'PLAN_AUTHENTICATION_VERIFICATION_FAILED',
    )

    const challenge = await this.repository.getPlanAuthenticationChallenge(
      input.ownerId,
      presentedChallenge,
    )
    if (!challenge) {
      throw new HumanPresenceError(
        'PLAN_AUTHENTICATION_CHALLENGE_NOT_FOUND',
      )
    }
    assertPlanBinding(challenge, input)
    assertPendingChallenge(
      challenge,
      presentedAt,
      'PLAN_AUTHENTICATION_CHALLENGE_CONSUMED',
      'PLAN_AUTHENTICATION_CHALLENGE_EXPIRED',
      'PLAN_AUTHENTICATION_CHALLENGE_NOT_YET_VALID',
    )

    const credential = await this.repository.getCredential(
      input.ownerId,
      input.response.id,
    )
    if (!credential) {
      throw new HumanPresenceError('CREDENTIAL_NOT_REGISTERED')
    }

    let verification
    try {
      verification = await this.webAuthn.verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: HUMAN_PRESENCE_RP.origin,
        expectedRPID: HUMAN_PRESENCE_RP.id,
        credential: {
          id: credential.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports
            ? [...credential.transports]
            : undefined,
        },
        requireUserVerification: true,
        advancedFIDOConfig: { userVerification: 'required' },
      })
    } catch (error) {
      throw new HumanPresenceError(
        'PLAN_AUTHENTICATION_VERIFICATION_FAILED',
        { cause: error },
      )
    }

    if (
      !verification.verified ||
      !verification.authenticationInfo.userVerified
    ) {
      throw new HumanPresenceError('PLAN_AUTHENTICATION_VERIFICATION_FAILED')
    }

    const verifiedAt = this.now().toISOString()
    assertPendingChallenge(
      challenge,
      verifiedAt,
      'PLAN_AUTHENTICATION_CHALLENGE_CONSUMED',
      'PLAN_AUTHENTICATION_CHALLENGE_EXPIRED',
      'PLAN_AUTHENTICATION_CHALLENGE_NOT_YET_VALID',
    )

    const committed = await this.repository.commitPlanAuthentication({
      ownerId: input.ownerId,
      challenge: challenge.challenge,
      planId: challenge.planId,
      planDigest: challenge.planDigest,
      expiresAt: challenge.expiresAt,
      consumedAt: verifiedAt,
      credentialId: credential.id,
      expectedCounter: credential.counter,
      newCounter: verification.authenticationInfo.newCounter,
    })
    if (committed === 'challenge-rejected') {
      throw new HumanPresenceError(
        'PLAN_AUTHENTICATION_CHALLENGE_CONSUMED',
      )
    }
    if (committed === 'counter-conflict') {
      throw new HumanPresenceError('CREDENTIAL_COUNTER_CONFLICT')
    }

    return {
      ownerId: input.ownerId,
      credentialId: credential.id,
      planId: challenge.planId,
      planDigest: challenge.planDigest,
      expiresAt: challenge.expiresAt,
      verifiedAt,
    }
  }
}

function validateOwner(owner: {
  readonly id: string
  readonly userName: string
  readonly displayName: string
}): void {
  assertNonEmpty('owner.id', owner.id)
  assertNonEmpty('owner.userName', owner.userName)
  assertNonEmpty('owner.displayName', owner.displayName)
}

function validatePlanReference(input: {
  readonly ownerId: string
  readonly planId: string
  readonly planDigest: string
}): void {
  assertNonEmpty('ownerId', input.ownerId)
  assertNonEmpty('planId', input.planId)
  if (!/^sha256:[a-f0-9]{64}$/.test(input.planDigest)) {
    throw new HumanPresenceError('INVALID_HUMAN_PRESENCE_INPUT')
  }
}

function assertPlanBinding(
  stored: PlanAuthenticationChallenge,
  presented: {
    readonly planId: string
    readonly planDigest: string
  },
): void {
  if (
    stored.planId !== presented.planId ||
    stored.planDigest !== presented.planDigest
  ) {
    throw new HumanPresenceError('PLAN_BINDING_MISMATCH')
  }
}

function assertPendingChallenge(
  challenge: RegistrationChallenge | PlanAuthenticationChallenge,
  presentedAt: string,
  consumedCode:
    | 'REGISTRATION_CHALLENGE_CONSUMED'
    | 'PLAN_AUTHENTICATION_CHALLENGE_CONSUMED',
  expiredCode:
    | 'REGISTRATION_CHALLENGE_EXPIRED'
    | 'PLAN_AUTHENTICATION_CHALLENGE_EXPIRED',
  notYetValidCode:
    | 'REGISTRATION_CHALLENGE_NOT_YET_VALID'
    | 'PLAN_AUTHENTICATION_CHALLENGE_NOT_YET_VALID',
): void {
  if (challenge.consumedAt !== null) {
    throw new HumanPresenceError(consumedCode)
  }
  const presentedAtMs = parseInstant('presentedAt', presentedAt)
  if (presentedAtMs < parseInstant('challenge.issuedAt', challenge.issuedAt)) {
    throw new HumanPresenceError(notYetValidCode)
  }
  if (presentedAtMs >= parseInstant('challenge.expiresAt', challenge.expiresAt)) {
    throw new HumanPresenceError(expiredCode)
  }
}

function challengeTimeout(issuedAt: string, expiresAt: string): number {
  const issuedAtMs = parseInstant('issuedAt', issuedAt)
  const expiresAtMs = parseInstant('expiresAt', expiresAt)
  if (expiresAtMs <= issuedAtMs) {
    throw new HumanPresenceError('INVALID_HUMAN_PRESENCE_INPUT')
  }
  return expiresAtMs - issuedAtMs
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new HumanPresenceError('INVALID_HUMAN_PRESENCE_INPUT', {
      cause: new TypeError(`${label} must not be empty`),
    })
  }
}

function parseInstant(label: string, value: string): number {
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new HumanPresenceError('INVALID_HUMAN_PRESENCE_INPUT', {
      cause: new TypeError(`${label} must be a canonical ISO-8601 instant`),
    })
  }
  return milliseconds
}

function extractChallenge(
  clientDataJSON: string,
  errorCode:
    | 'REGISTRATION_VERIFICATION_FAILED'
    | 'PLAN_AUTHENTICATION_VERIFICATION_FAILED',
): string {
  try {
    const challenge = decodeClientDataJSON(clientDataJSON).challenge
    if (challenge.trim().length === 0) throw new TypeError('empty challenge')
    return challenge
  } catch (error) {
    throw new HumanPresenceError(errorCode, { cause: error })
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromBase64Url(value: string) {
  return Uint8Array.from(Buffer.from(value, 'base64url'))
}
