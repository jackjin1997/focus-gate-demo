import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type {
  HumanPresenceRepository,
  HumanPresenceService,
  PlanAuthenticationProof,
  RegistrationProof,
} from '../security/human-presence'

const OWNER = Object.freeze({
  id: 'focus-gate-local-owner',
  userName: 'focus-gate-owner',
  displayName: '专注之门本机主人',
})
const CEREMONY_LIFETIME_MS = 2 * 60 * 1_000

export interface ReadPlanPresenceBinding {
  readonly planId: string
  readonly digest: string
  readonly expiresAt: string
}

type PresenceService = Pick<
  HumanPresenceService,
  | 'generateRegistration'
  | 'verifyRegistration'
  | 'generatePlanAuthentication'
  | 'verifyPlanAuthentication'
>

export class HumanPresenceApplication {
  private readonly service: PresenceService
  private readonly repository: HumanPresenceRepository
  private readonly now: () => Date

  constructor(input: {
    service: PresenceService
    repository: HumanPresenceRepository
    now?: () => Date
  }) {
    this.service = input.service
    this.repository = input.repository
    this.now = input.now ?? (() => new Date())
  }

  async status() {
    const credentials = await this.repository.listCredentials(OWNER.id)
    return {
      registered: credentials.length > 0,
      method: 'passkey' as const,
    }
  }

  async registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if ((await this.status()).registered) {
      throw new Error('HUMAN_PRESENCE_ALREADY_REGISTERED')
    }
    return this.service.generateRegistration({
      owner: OWNER,
      expiresAt: this.ceremonyExpiry(),
    })
  }

  async verifyRegistration(
    response: RegistrationResponseJSON,
  ): Promise<{ verified: true; proof: RegistrationProof }> {
    const proof = await this.service.verifyRegistration({
      ownerId: OWNER.id,
      response,
    })
    return { verified: true, proof }
  }

  async planAuthenticationOptions(
    binding: ReadPlanPresenceBinding,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    if (!(await this.status()).registered) {
      throw new Error('HUMAN_PRESENCE_NOT_REGISTERED')
    }
    return this.service.generatePlanAuthentication({
      ownerId: OWNER.id,
      planId: binding.planId,
      planDigest: binding.digest,
      expiresAt: this.ceremonyExpiry(binding.expiresAt),
    })
  }

  async verifyPlanAuthentication(
    binding: ReadPlanPresenceBinding,
    response: AuthenticationResponseJSON,
  ): Promise<PlanAuthenticationProof> {
    return this.service.verifyPlanAuthentication({
      ownerId: OWNER.id,
      planId: binding.planId,
      planDigest: binding.digest,
      response,
    })
  }

  private ceremonyExpiry(outerExpiry?: string) {
    const shortExpiry = this.now().getTime() + CEREMONY_LIFETIME_MS
    const outerExpiryMs = outerExpiry === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(outerExpiry)
    if (Number.isNaN(outerExpiryMs)) throw new Error('INVALID_HUMAN_PRESENCE_INPUT')
    const expiresAtMs = Math.min(shortExpiry, outerExpiryMs)
    if (expiresAtMs <= this.now().getTime()) throw new Error('READ_PLAN_EXPIRED')
    return new Date(expiresAtMs).toISOString()
  }
}
