import { describe, expect, it } from 'vitest'

import {
  createReadGrant,
  createReadPlan,
  validateReadGrant,
} from './read-plan'

describe('ReadPlan and ReadGrant', () => {
  const requestedAt = '2026-07-12T02:20:00.000Z'

  it('creates the exact user-approved phase-one read boundary', () => {
    const plan = createReadPlan({
      requestedAt,
      capabilityReviewId: 'review-001',
      userOpenId: 'ou_current_user',
    })

    expect(plan).toEqual({
      version: 2,
      source: 'feishu-im',
      sourceLabel: '飞书消息搜索',
      requestedAt,
      account: {
        provider: 'feishu',
        identifier: 'user_open_id',
        capabilityReviewId: 'review-001',
        fingerprint: 'sha256:841f415e249b40138117747521983af4a807f010e1ff0d320b3a822f19127552',
      },
      window: {
        kind: 'absolute',
        fromInclusive: '2026-07-12T02:10:00.000Z',
        toExclusive: requestedAt,
        lookbackMinutes: 10,
      },
      scope: '当前用户全部可见会话',
      visibility: 'all-visible',
      fields: ['消息正文', '发送者', '会话', '时间', '@提及'],
      exclusions: ['附件内容', '飞书写入', 'macOS 设置'],
      attachments: 'exclude',
      retention: '消息正文不写入本地数据库',
      retentionPolicy: 'never-persist-message-content',
      writes: 0,
    })
    expect(JSON.stringify(plan)).not.toContain('ou_current_user')
  })

  it('represents an unbound capability review without inventing an account', () => {
    expect(
      createReadPlan({
        requestedAt,
        capabilityReviewId: 'review-unbound',
        userOpenId: null,
      }).account,
    ).toEqual({
      provider: 'feishu',
      identifier: 'user_open_id',
      capabilityReviewId: 'review-unbound',
      fingerprint: null,
    })
  })

  it('binds a grant to the canonical plan and its validity window', () => {
    const plan = createReadPlan({ requestedAt })
    const grant = createReadGrant(plan, {
      grantId: 'grant-001',
      grantedAt: '2026-07-12T02:20:05.000Z',
      expiresAt: '2026-07-12T02:22:05.000Z',
    })

    expect(
      validateReadGrant(plan, grant, '2026-07-12T02:21:00.000Z'),
    ).toEqual({ kind: 'valid' })

    const expandedPlan = {
      ...plan,
      attachments: 'include' as const,
    }
    expect(
      validateReadGrant(expandedPlan, grant, '2026-07-12T02:21:00.000Z'),
    ).toEqual({ kind: 'invalid', reason: 'plan-mismatch' })
  })

  it('rejects a grant before issue time or after expiry', () => {
    const plan = createReadPlan({ requestedAt })
    const grant = createReadGrant(plan, {
      grantId: 'grant-002',
      grantedAt: '2026-07-12T02:20:05.000Z',
      expiresAt: '2026-07-12T02:22:05.000Z',
    })

    expect(
      validateReadGrant(plan, grant, '2026-07-12T02:20:04.999Z'),
    ).toEqual({ kind: 'invalid', reason: 'not-yet-valid' })
    expect(
      validateReadGrant(plan, grant, '2026-07-12T02:22:05.000Z'),
    ).toEqual({ kind: 'invalid', reason: 'expired' })
  })

  it('rejects invalid timestamps and non-positive grant windows', () => {
    expect(() => createReadPlan({ requestedAt: 'not-a-date' })).toThrow(
      /requestedAt/,
    )

    const plan = createReadPlan({ requestedAt })
    expect(() =>
      createReadGrant(plan, {
        grantId: 'grant-003',
        grantedAt: '2026-07-12T02:22:05.000Z',
        expiresAt: '2026-07-12T02:22:05.000Z',
      }),
    ).toThrow(/expiresAt/)
  })
})
