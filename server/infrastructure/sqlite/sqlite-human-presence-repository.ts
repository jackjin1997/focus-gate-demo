import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type * as NodeSqlite from 'node:sqlite'
import type {
  AuthenticatorTransportFuture,
  CredentialDeviceType,
} from '@simplewebauthn/server'
import type {
  HumanPresenceRepository,
  OwnerIdentity,
  PlanAuthenticationChallenge,
  RegistrationChallenge,
  StoredWebAuthnCredential,
} from '../../security/human-presence'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite

type Row = Record<string, unknown>

export class SqliteHumanPresenceRepository implements HumanPresenceRepository {
  private readonly database: NodeSqlite.DatabaseSync
  private closed = false

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.database = new DatabaseSync(path)
    this.database.exec('PRAGMA journal_mode = WAL;')
    this.database.exec('PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  close() {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  async getOwner(ownerId: string): Promise<OwnerIdentity | null> {
    const row = this.database
      .prepare('SELECT * FROM human_presence_owners WHERE id = ?')
      .get(ownerId) as Row | undefined
    return row ? ownerFromRow(row) : null
  }

  async saveOwner(owner: OwnerIdentity): Promise<void> {
    this.database.prepare(`
      INSERT INTO human_presence_owners (
        id, user_name, display_name, webauthn_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_name = excluded.user_name,
        display_name = excluded.display_name,
        webauthn_user_id = excluded.webauthn_user_id,
        updated_at = excluded.updated_at
    `).run(
      owner.id,
      owner.userName,
      owner.displayName,
      owner.webAuthnUserId,
      owner.createdAt,
      owner.updatedAt,
    )
  }

  async listCredentials(ownerId: string): Promise<readonly StoredWebAuthnCredential[]> {
    const rows = this.database
      .prepare('SELECT * FROM human_presence_credentials WHERE owner_id = ? ORDER BY created_at')
      .all(ownerId) as Row[]
    return rows.map(credentialFromRow)
  }

  async getCredential(
    ownerId: string,
    credentialId: string,
  ): Promise<StoredWebAuthnCredential | null> {
    const row = this.database.prepare(`
      SELECT * FROM human_presence_credentials
      WHERE owner_id = ? AND credential_id = ?
    `).get(ownerId, credentialId) as Row | undefined
    return row ? credentialFromRow(row) : null
  }

  async saveCredential(credential: StoredWebAuthnCredential): Promise<void> {
    this.database.prepare(`
      INSERT INTO human_presence_credentials (
        owner_id, credential_id, public_key, counter, transports_json,
        device_type, backed_up, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, credential_id) DO UPDATE SET
        public_key = excluded.public_key,
        counter = excluded.counter,
        transports_json = excluded.transports_json,
        device_type = excluded.device_type,
        backed_up = excluded.backed_up,
        last_used_at = excluded.last_used_at
    `).run(
      credential.ownerId,
      credential.id,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      credential.deviceType,
      credential.backedUp ? 1 : 0,
      credential.createdAt,
      credential.lastUsedAt,
    )
  }

  async compareAndSetCredentialCounter(input: {
    readonly ownerId: string
    readonly credentialId: string
    readonly expectedCounter: number
    readonly newCounter: number
    readonly usedAt: string
  }): Promise<boolean> {
    const result = this.database.prepare(`
      UPDATE human_presence_credentials
      SET counter = ?, last_used_at = ?
      WHERE owner_id = ? AND credential_id = ? AND counter = ?
    `).run(
      input.newCounter,
      input.usedAt,
      input.ownerId,
      input.credentialId,
      input.expectedCounter,
    )
    return Number(result.changes) === 1
  }

  async saveRegistrationChallenge(challenge: RegistrationChallenge): Promise<void> {
    this.database.prepare(`
      INSERT INTO human_presence_registration_challenges (
        owner_id, challenge, issued_at, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      challenge.ownerId,
      challenge.challenge,
      challenge.issuedAt,
      challenge.expiresAt,
      challenge.consumedAt,
    )
  }

  async getRegistrationChallenge(
    ownerId: string,
    challenge: string,
  ): Promise<RegistrationChallenge | null> {
    const row = this.database.prepare(`
      SELECT * FROM human_presence_registration_challenges
      WHERE owner_id = ? AND challenge = ?
    `).get(ownerId, challenge) as Row | undefined
    return row ? registrationChallengeFromRow(row) : null
  }

  async consumeRegistrationChallenge(input: {
    readonly ownerId: string
    readonly challenge: string
    readonly consumedAt: string
  }): Promise<boolean> {
    const result = this.database.prepare(`
      UPDATE human_presence_registration_challenges
      SET consumed_at = ?
      WHERE owner_id = ? AND challenge = ? AND consumed_at IS NULL
        AND issued_at <= ? AND expires_at > ?
    `).run(
      input.consumedAt,
      input.ownerId,
      input.challenge,
      input.consumedAt,
      input.consumedAt,
    )
    return Number(result.changes) === 1
  }

  async savePlanAuthenticationChallenge(
    challenge: PlanAuthenticationChallenge,
  ): Promise<void> {
    this.database.prepare(`
      INSERT INTO human_presence_plan_challenges (
        owner_id, challenge, plan_id, plan_digest,
        issued_at, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      challenge.ownerId,
      challenge.challenge,
      challenge.planId,
      challenge.planDigest,
      challenge.issuedAt,
      challenge.expiresAt,
      challenge.consumedAt,
    )
  }

  async getPlanAuthenticationChallenge(
    ownerId: string,
    challenge: string,
  ): Promise<PlanAuthenticationChallenge | null> {
    const row = this.database.prepare(`
      SELECT * FROM human_presence_plan_challenges
      WHERE owner_id = ? AND challenge = ?
    `).get(ownerId, challenge) as Row | undefined
    return row ? planChallengeFromRow(row) : null
  }

  async consumePlanAuthenticationChallenge(input: {
    readonly ownerId: string
    readonly challenge: string
    readonly planId: string
    readonly planDigest: string
    readonly expiresAt: string
    readonly consumedAt: string
  }): Promise<boolean> {
    const result = this.database.prepare(`
      UPDATE human_presence_plan_challenges
      SET consumed_at = ?
      WHERE owner_id = ? AND challenge = ? AND plan_id = ? AND plan_digest = ?
        AND expires_at = ? AND consumed_at IS NULL
        AND issued_at <= ? AND expires_at > ?
    `).run(
      input.consumedAt,
      input.ownerId,
      input.challenge,
      input.planId,
      input.planDigest,
      input.expiresAt,
      input.consumedAt,
      input.consumedAt,
    )
    return Number(result.changes) === 1
  }

  async commitPlanAuthentication(input: {
    readonly ownerId: string
    readonly challenge: string
    readonly planId: string
    readonly planDigest: string
    readonly expiresAt: string
    readonly consumedAt: string
    readonly credentialId: string
    readonly expectedCounter: number
    readonly newCounter: number
  }): Promise<'committed' | 'challenge-rejected' | 'counter-conflict'> {
    this.database.exec('BEGIN IMMEDIATE;')
    try {
      const challengeUpdate = this.database.prepare(`
        UPDATE human_presence_plan_challenges
        SET consumed_at = ?
        WHERE owner_id = ? AND challenge = ? AND plan_id = ? AND plan_digest = ?
          AND expires_at = ? AND consumed_at IS NULL
          AND issued_at <= ? AND expires_at > ?
      `).run(
        input.consumedAt,
        input.ownerId,
        input.challenge,
        input.planId,
        input.planDigest,
        input.expiresAt,
        input.consumedAt,
        input.consumedAt,
      )
      if (Number(challengeUpdate.changes) !== 1) {
        this.database.exec('ROLLBACK;')
        return 'challenge-rejected'
      }

      const counterUpdate = this.database.prepare(`
        UPDATE human_presence_credentials
        SET counter = ?, last_used_at = ?
        WHERE owner_id = ? AND credential_id = ? AND counter = ?
      `).run(
        input.newCounter,
        input.consumedAt,
        input.ownerId,
        input.credentialId,
        input.expectedCounter,
      )
      if (Number(counterUpdate.changes) !== 1) {
        this.database.exec('ROLLBACK;')
        return 'counter-conflict'
      }

      this.database.exec('COMMIT;')
      return 'committed'
    } catch (error) {
      this.database.exec('ROLLBACK;')
      throw error
    }
  }

  private migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS human_presence_owners (
        id TEXT PRIMARY KEY,
        user_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        webauthn_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS human_presence_credentials (
        owner_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports_json TEXT NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL CHECK(backed_up IN (0, 1)),
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        PRIMARY KEY(owner_id, credential_id)
      );

      CREATE TABLE IF NOT EXISTS human_presence_registration_challenges (
        owner_id TEXT NOT NULL,
        challenge TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        PRIMARY KEY(owner_id, challenge)
      );

      CREATE TABLE IF NOT EXISTS human_presence_plan_challenges (
        owner_id TEXT NOT NULL,
        challenge TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        PRIMARY KEY(owner_id, challenge)
      );
    `)
  }
}

function ownerFromRow(row: Row): OwnerIdentity {
  return {
    id: String(row.id),
    userName: String(row.user_name),
    displayName: String(row.display_name),
    webAuthnUserId: String(row.webauthn_user_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function credentialFromRow(row: Row): StoredWebAuthnCredential {
  if (!(row.public_key instanceof Uint8Array)) throw new Error('INVALID_WEBAUTHN_PUBLIC_KEY')
  return {
    ownerId: String(row.owner_id),
    id: String(row.credential_id),
    publicKey: row.public_key.slice(),
    counter: Number(row.counter),
    transports: parseTransports(row.transports_json),
    deviceType: parseDeviceType(row.device_type),
    backedUp: Number(row.backed_up) === 1,
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
  }
}

function registrationChallengeFromRow(row: Row): RegistrationChallenge {
  return {
    ownerId: String(row.owner_id),
    challenge: String(row.challenge),
    issuedAt: String(row.issued_at),
    expiresAt: String(row.expires_at),
    consumedAt: row.consumed_at === null ? null : String(row.consumed_at),
  }
}

function planChallengeFromRow(row: Row): PlanAuthenticationChallenge {
  return {
    ...registrationChallengeFromRow(row),
    planId: String(row.plan_id),
    planDigest: String(row.plan_digest),
  }
}

function parseTransports(value: unknown): AuthenticatorTransportFuture[] {
  if (typeof value !== 'string') return []
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return []
  return parsed as AuthenticatorTransportFuture[]
}

function parseDeviceType(value: unknown): CredentialDeviceType {
  if (value === 'singleDevice' || value === 'multiDevice') return value
  throw new Error('INVALID_WEBAUTHN_DEVICE_TYPE')
}
