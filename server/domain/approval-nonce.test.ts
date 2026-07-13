import { describe, expect, it } from 'vitest'

import {
  consumeApprovalNonce,
  issueApprovalNonce,
} from './approval-nonce'

describe('one-time approval nonce', () => {
  const intent = {
    kind: 'read-plan',
    planDigest: 'sha256:plan',
  }

  it('stores only a nonce digest and consumes a matching approval once', () => {
    const issued = issueApprovalNonce({
      intent,
      issuedAt: '2026-07-12T02:20:00.000Z',
      expiresAt: '2026-07-12T02:22:00.000Z',
    })

    expect(issued.nonce).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(JSON.stringify(issued.approval)).not.toContain(issued.nonce)

    const first = consumeApprovalNonce(issued.approval, {
      nonce: issued.nonce,
      intent,
      presentedAt: '2026-07-12T02:21:00.000Z',
    })
    expect(first.kind).toBe('accepted')
    if (first.kind !== 'accepted') {
      throw new Error('expected approval to be accepted')
    }
    expect(first.approval.state).toBe('consumed')

    expect(
      consumeApprovalNonce(first.approval, {
        nonce: issued.nonce,
        intent,
        presentedAt: '2026-07-12T02:21:01.000Z',
      }),
    ).toEqual({
      kind: 'rejected',
      reason: 'already-consumed',
      approval: first.approval,
    })
  })

  it('does not consume the approval for a wrong nonce or a changed intent', () => {
    const issued = issueApprovalNonce({
      intent,
      issuedAt: '2026-07-12T02:20:00.000Z',
      expiresAt: '2026-07-12T02:22:00.000Z',
    })

    const wrongNonce = consumeApprovalNonce(issued.approval, {
      nonce: 'definitely-not-the-secret',
      intent,
      presentedAt: '2026-07-12T02:21:00.000Z',
    })
    expect(wrongNonce).toEqual({
      kind: 'rejected',
      reason: 'nonce-mismatch',
      approval: issued.approval,
    })

    const wrongIntent = consumeApprovalNonce(issued.approval, {
      nonce: issued.nonce,
      intent: { ...intent, planDigest: 'sha256:changed' },
      presentedAt: '2026-07-12T02:21:00.000Z',
    })
    expect(wrongIntent).toEqual({
      kind: 'rejected',
      reason: 'intent-mismatch',
      approval: issued.approval,
    })
  })

  it('expires instead of accepting a late presentation', () => {
    const issued = issueApprovalNonce({
      intent,
      issuedAt: '2026-07-12T02:20:00.000Z',
      expiresAt: '2026-07-12T02:22:00.000Z',
    })

    const result = consumeApprovalNonce(issued.approval, {
      nonce: issued.nonce,
      intent,
      presentedAt: '2026-07-12T02:22:00.000Z',
    })

    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') {
      throw new Error('expected expired approval to be rejected')
    }
    expect(result.reason).toBe('expired')
    expect(result.approval.state).toBe('expired')
  })
})
