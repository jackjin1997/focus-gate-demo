import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { canonicalDigest } from './canonical'
import { parseInstant } from './instant'

interface ApprovalCore {
  readonly version: 1
  readonly nonceDigest: string
  readonly intentDigest: string
  readonly issuedAt: string
  readonly expiresAt: string
}

export interface PendingApprovalNonce extends ApprovalCore {
  readonly state: 'pending'
}

export interface ConsumedApprovalNonce extends ApprovalCore {
  readonly state: 'consumed'
  readonly consumedAt: string
}

export interface ExpiredApprovalNonce extends ApprovalCore {
  readonly state: 'expired'
  readonly expiredAt: string
}

export type ApprovalNonce =
  | PendingApprovalNonce
  | ConsumedApprovalNonce
  | ExpiredApprovalNonce

export type ApprovalConsumption =
  | {
      readonly kind: 'accepted'
      readonly approval: ConsumedApprovalNonce
    }
  | {
      readonly kind: 'rejected'
      readonly reason:
        | 'already-consumed'
        | 'expired'
        | 'not-yet-valid'
        | 'intent-mismatch'
        | 'nonce-mismatch'
      readonly approval: ApprovalNonce
    }

export function issueApprovalNonce(input: {
  readonly intent: unknown
  readonly issuedAt: string
  readonly expiresAt: string
}): {
  readonly nonce: string
  readonly approval: PendingApprovalNonce
} {
  const issuedAtMs = parseInstant('issuedAt', input.issuedAt)
  const expiresAtMs = parseInstant('expiresAt', input.expiresAt)
  if (expiresAtMs <= issuedAtMs) {
    throw new RangeError('expiresAt must be after issuedAt')
  }

  const nonce = randomBytes(32).toString('base64url')

  return {
    nonce,
    approval: {
      version: 1,
      state: 'pending',
      nonceDigest: hashNonceHex(nonce),
      intentDigest: canonicalDigest(input.intent),
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    },
  }
}

export function consumeApprovalNonce(
  approval: ApprovalNonce,
  input: {
    readonly nonce: string
    readonly intent: unknown
    readonly presentedAt: string
  },
): ApprovalConsumption {
  if (approval.state === 'consumed') {
    return { kind: 'rejected', reason: 'already-consumed', approval }
  }

  if (approval.state === 'expired') {
    return { kind: 'rejected', reason: 'expired', approval }
  }

  const presentedAtMs = parseInstant('presentedAt', input.presentedAt)
  const issuedAtMs = parseInstant('approval.issuedAt', approval.issuedAt)
  const expiresAtMs = parseInstant('approval.expiresAt', approval.expiresAt)

  if (presentedAtMs < issuedAtMs) {
    return { kind: 'rejected', reason: 'not-yet-valid', approval }
  }

  if (presentedAtMs >= expiresAtMs) {
    return {
      kind: 'rejected',
      reason: 'expired',
      approval: {
        ...approval,
        state: 'expired',
        expiredAt: input.presentedAt,
      },
    }
  }

  if (canonicalDigest(input.intent) !== approval.intentDigest) {
    return { kind: 'rejected', reason: 'intent-mismatch', approval }
  }

  if (!nonceMatches(input.nonce, approval.nonceDigest)) {
    return { kind: 'rejected', reason: 'nonce-mismatch', approval }
  }

  return {
    kind: 'accepted',
    approval: {
      ...approval,
      state: 'consumed',
      consumedAt: input.presentedAt,
    },
  }
}

function hashNonceHex(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex')
}

function nonceMatches(candidate: string, expectedHex: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest()
  const expectedDigest = hexToBytes(expectedHex)

  return (
    candidateDigest.byteLength === expectedDigest.byteLength &&
    timingSafeEqual(candidateDigest, expectedDigest)
  )
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    return new Uint8Array(0)
  }

  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
