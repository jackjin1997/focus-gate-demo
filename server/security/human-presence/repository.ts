import type {
  OwnerIdentity,
  PlanAuthenticationChallenge,
  RegistrationChallenge,
  StoredWebAuthnCredential,
} from './types'

export interface HumanPresenceRepository {
  getOwner(ownerId: string): Promise<OwnerIdentity | null>
  saveOwner(owner: OwnerIdentity): Promise<void>

  listCredentials(ownerId: string): Promise<readonly StoredWebAuthnCredential[]>
  getCredential(
    ownerId: string,
    credentialId: string,
  ): Promise<StoredWebAuthnCredential | null>
  saveCredential(credential: StoredWebAuthnCredential): Promise<void>

  /**
   * Atomically update only when owner, credential ID, and current counter match.
   * Return false when another authentication changed the row first.
   */
  compareAndSetCredentialCounter(input: {
    readonly ownerId: string
    readonly credentialId: string
    readonly expectedCounter: number
    readonly newCounter: number
    readonly usedAt: string
  }): Promise<boolean>

  saveRegistrationChallenge(challenge: RegistrationChallenge): Promise<void>
  getRegistrationChallenge(
    ownerId: string,
    challenge: string,
  ): Promise<RegistrationChallenge | null>

  /** Atomically set consumedAt only while the exact challenge is pending and unexpired. */
  consumeRegistrationChallenge(input: {
    readonly ownerId: string
    readonly challenge: string
    readonly consumedAt: string
  }): Promise<boolean>

  savePlanAuthenticationChallenge(
    challenge: PlanAuthenticationChallenge,
  ): Promise<void>
  getPlanAuthenticationChallenge(
    ownerId: string,
    challenge: string,
  ): Promise<PlanAuthenticationChallenge | null>

  /**
   * Atomically set consumedAt only when every plan-binding field matches, the row
   * is pending, and consumedAt is before expiresAt. This is the replay boundary.
   */
  consumePlanAuthenticationChallenge(input: {
    readonly ownerId: string
    readonly challenge: string
    readonly planId: string
    readonly planDigest: string
    readonly expiresAt: string
    readonly consumedAt: string
  }): Promise<boolean>

  /** Atomically consume the bound challenge and advance the credential counter. */
  commitPlanAuthentication(input: {
    readonly ownerId: string
    readonly challenge: string
    readonly planId: string
    readonly planDigest: string
    readonly expiresAt: string
    readonly consumedAt: string
    readonly credentialId: string
    readonly expectedCounter: number
    readonly newCounter: number
  }): Promise<'committed' | 'challenge-rejected' | 'counter-conflict'>
}
