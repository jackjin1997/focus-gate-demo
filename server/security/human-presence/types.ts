import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  CredentialDeviceType,
  RegistrationResponseJSON,
  Uint8Array_,
} from '@simplewebauthn/server'

export interface OwnerProfile {
  readonly id: string
  readonly userName: string
  readonly displayName: string
}

export interface OwnerIdentity extends OwnerProfile {
  /** Opaque, non-PII WebAuthn user handle encoded as base64url. */
  readonly webAuthnUserId: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface StoredWebAuthnCredential {
  readonly ownerId: string
  readonly id: string
  /** COSE public key bytes. Store as a BLOB, never as a JS number array. */
  readonly publicKey: Uint8Array_
  readonly counter: number
  readonly transports?: readonly AuthenticatorTransportFuture[]
  readonly deviceType: CredentialDeviceType
  readonly backedUp: boolean
  readonly createdAt: string
  readonly lastUsedAt: string | null
}

interface StoredChallenge {
  readonly ownerId: string
  readonly challenge: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly consumedAt: string | null
}

export interface RegistrationChallenge extends StoredChallenge {}

export interface PlanAuthenticationChallenge extends StoredChallenge {
  readonly planId: string
  readonly planDigest: string
}

export interface GenerateRegistrationInput {
  readonly owner: OwnerProfile
  readonly expiresAt: string
}

export interface VerifyRegistrationInput {
  readonly ownerId: string
  readonly response: RegistrationResponseJSON
}

export interface GeneratePlanAuthenticationInput {
  readonly ownerId: string
  readonly planId: string
  readonly planDigest: string
  readonly expiresAt: string
}

export interface VerifyPlanAuthenticationInput {
  readonly ownerId: string
  readonly planId: string
  readonly planDigest: string
  readonly response: AuthenticationResponseJSON
}

export interface RegistrationProof {
  readonly ownerId: string
  readonly credentialId: string
  readonly verifiedAt: string
}

export interface PlanAuthenticationProof {
  readonly ownerId: string
  readonly credentialId: string
  readonly planId: string
  readonly planDigest: string
  readonly expiresAt: string
  readonly verifiedAt: string
}
