import { createHash } from 'node:crypto'

import { canonicalDigest } from './canonical'
import { parseInstant } from './instant'

const READ_LOOKBACK_MINUTES = 10 as const
const READ_LOOKBACK_MS = READ_LOOKBACK_MINUTES * 60 * 1_000

const READ_FIELDS = ['消息正文', '发送者', '会话', '时间', '@提及'] as const
const READ_EXCLUSIONS = ['附件内容', '飞书写入', 'macOS 设置'] as const

export interface ReadPlan {
  readonly version: 2
  readonly source: 'feishu-im'
  readonly sourceLabel: '飞书消息搜索'
  readonly requestedAt: string
  readonly account: {
    readonly provider: 'feishu'
    readonly identifier: 'user_open_id'
    readonly capabilityReviewId: string | null
    readonly fingerprint: string | null
  }
  readonly window: {
    readonly kind: 'absolute'
    readonly fromInclusive: string
    readonly toExclusive: string
    readonly lookbackMinutes: typeof READ_LOOKBACK_MINUTES
  }
  readonly scope: '当前用户全部可见会话'
  readonly visibility: 'all-visible'
  readonly fields: typeof READ_FIELDS
  readonly exclusions: typeof READ_EXCLUSIONS
  readonly attachments: 'exclude'
  readonly retention: '消息正文不写入本地数据库'
  readonly retentionPolicy: 'never-persist-message-content'
  readonly writes: 0
}

export interface ReadGrant {
  readonly version: 1
  readonly grantId: string
  readonly planDigest: string
  readonly grantedAt: string
  readonly expiresAt: string
}

export type ReadGrantValidation =
  | { readonly kind: 'valid' }
  | {
      readonly kind: 'invalid'
      readonly reason:
        | 'plan-mismatch'
        | 'not-yet-valid'
        | 'expired'
        | 'malformed-grant'
    }

export function createReadPlan(input: {
  readonly requestedAt: string
  readonly capabilityReviewId?: string | null
  readonly userOpenId?: string | null
}): ReadPlan {
  const requestedAtMs = parseInstant('requestedAt', input.requestedAt)
  const capabilityReviewId = normalizeOptionalIdentifier(
    'capabilityReviewId',
    input.capabilityReviewId,
  )
  const userOpenId = normalizeOptionalIdentifier('userOpenId', input.userOpenId)

  return {
    version: 2,
    source: 'feishu-im',
    sourceLabel: '飞书消息搜索',
    requestedAt: input.requestedAt,
    account: {
      provider: 'feishu',
      identifier: 'user_open_id',
      capabilityReviewId,
      fingerprint: userOpenId === null ? null : fingerprintUserOpenId(userOpenId),
    },
    window: {
      kind: 'absolute',
      fromInclusive: new Date(requestedAtMs - READ_LOOKBACK_MS).toISOString(),
      toExclusive: input.requestedAt,
      lookbackMinutes: READ_LOOKBACK_MINUTES,
    },
    scope: '当前用户全部可见会话',
    visibility: 'all-visible',
    fields: READ_FIELDS,
    exclusions: READ_EXCLUSIONS,
    attachments: 'exclude',
    retention: '消息正文不写入本地数据库',
    retentionPolicy: 'never-persist-message-content',
    writes: 0,
  }
}

export function fingerprintUserOpenId(userOpenId: string): string {
  if (userOpenId.trim().length === 0) {
    throw new TypeError('userOpenId must not be empty')
  }
  return `sha256:${createHash('sha256').update(userOpenId, 'utf8').digest('hex')}`
}

export function assertReadPlan(value: unknown): asserts value is ReadPlan {
  if (!isRecord(value) || value.version !== 2 || value.source !== 'feishu-im') {
    throw new TypeError('invalid ReadPlan')
  }
  if (!isRecord(value.account) || !isRecord(value.window)) {
    throw new TypeError('invalid ReadPlan')
  }
  if (
    typeof value.requestedAt !== 'string' ||
    typeof value.window.fromInclusive !== 'string' ||
    typeof value.window.toExclusive !== 'string'
  ) {
    throw new TypeError('invalid ReadPlan')
  }
  const requestedAtMs = parseInstant('plan.requestedAt', value.requestedAt)
  const fromMs = parseInstant('plan.window.fromInclusive', value.window.fromInclusive)
  const toMs = parseInstant('plan.window.toExclusive', value.window.toExclusive)
  const fingerprint = value.account.fingerprint
  const capabilityReviewId = value.account.capabilityReviewId

  if (
    value.sourceLabel !== '飞书消息搜索' ||
    value.account.provider !== 'feishu' ||
    value.account.identifier !== 'user_open_id' ||
    (capabilityReviewId !== null &&
      (typeof capabilityReviewId !== 'string' || capabilityReviewId.length === 0)) ||
    (fingerprint !== null &&
      (typeof fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(fingerprint))) ||
    value.window.kind !== 'absolute' ||
    value.window.lookbackMinutes !== READ_LOOKBACK_MINUTES ||
    fromMs !== requestedAtMs - READ_LOOKBACK_MS ||
    toMs !== requestedAtMs ||
    value.scope !== '当前用户全部可见会话' ||
    value.visibility !== 'all-visible' ||
    !sameStringTuple(value.fields, READ_FIELDS) ||
    !sameStringTuple(value.exclusions, READ_EXCLUSIONS) ||
    value.attachments !== 'exclude' ||
    value.retention !== '消息正文不写入本地数据库' ||
    value.retentionPolicy !== 'never-persist-message-content' ||
    value.writes !== 0
  ) {
    throw new TypeError('invalid ReadPlan')
  }
}

function normalizeOptionalIdentifier(
  name: string,
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`)
  return value
}

function sameStringTuple(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createReadGrant(
  plan: ReadPlan,
  input: {
    readonly grantId: string
    readonly grantedAt: string
    readonly expiresAt: string
  },
): ReadGrant {
  if (input.grantId.trim().length === 0) {
    throw new TypeError('grantId must not be empty')
  }

  const grantedAtMs = parseInstant('grantedAt', input.grantedAt)
  const expiresAtMs = parseInstant('expiresAt', input.expiresAt)
  if (expiresAtMs <= grantedAtMs) {
    throw new RangeError('expiresAt must be after grantedAt')
  }

  return {
    version: 1,
    grantId: input.grantId,
    planDigest: canonicalDigest(plan),
    grantedAt: input.grantedAt,
    expiresAt: input.expiresAt,
  }
}

export function validateReadGrant(
  plan: unknown,
  grant: ReadGrant,
  at: string,
): ReadGrantValidation {
  let atMs: number
  let grantedAtMs: number
  let expiresAtMs: number

  try {
    atMs = parseInstant('at', at)
    grantedAtMs = parseInstant('grant.grantedAt', grant.grantedAt)
    expiresAtMs = parseInstant('grant.expiresAt', grant.expiresAt)
  } catch {
    return { kind: 'invalid', reason: 'malformed-grant' }
  }

  if (grant.version !== 1 || expiresAtMs <= grantedAtMs) {
    return { kind: 'invalid', reason: 'malformed-grant' }
  }

  if (canonicalDigest(plan) !== grant.planDigest) {
    return { kind: 'invalid', reason: 'plan-mismatch' }
  }

  if (atMs < grantedAtMs) {
    return { kind: 'invalid', reason: 'not-yet-valid' }
  }

  if (atMs >= expiresAtMs) {
    return { kind: 'invalid', reason: 'expired' }
  }

  return { kind: 'valid' }
}
