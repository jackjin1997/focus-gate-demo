// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FocusGateStore } from './focus-gate-store'

const stores: FocusGateStore[] = []
const temporaryDirectories: string[] = []

function openStore(path = ':memory:') {
  const store = new FocusGateStore(path)
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('FocusGateStore', () => {
  it('persists the latest capability review without storing credentials', () => {
    const store = openStore()
    store.saveCapabilityReview({
      id: 'review-1',
      createdAt: '2026-07-12T10:00:00.000Z',
      report: {
        cliVersion: '1.0.26',
        identity: 'bot',
        userOpenId: null,
        messageSearch: false,
      },
    })

    expect(store.getLatestCapabilityReview()).toEqual({
      id: 'review-1',
      createdAt: '2026-07-12T10:00:00.000Z',
      report: {
        cliVersion: '1.0.26',
        identity: 'bot',
        userOpenId: null,
        messageSearch: false,
      },
    })
    expect(JSON.stringify(store.getLatestCapabilityReview())).not.toMatch(/token|secret/i)
  })

  it('uses insertion order when capability reviews have the same timestamp', () => {
    const store = openStore()
    const createdAt = '2026-07-12T10:00:00.000Z'
    store.saveCapabilityReview({
      id: 'review-first',
      createdAt,
      report: { userOpenId: 'ou_first' },
    })
    store.saveCapabilityReview({
      id: 'review-second',
      createdAt,
      report: { userOpenId: 'ou_second' },
    })

    expect(store.getLatestCapabilityReview()).toMatchObject({
      id: 'review-second',
      report: { userOpenId: 'ou_second' },
    })
  })

  it('restores an immutable read plan after the companion restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'focus-gate-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'focus-gate.sqlite')

    const first = openStore(databasePath)
    first.saveReadPlan({
      id: 'plan-1',
      digest: 'digest-1',
      approvalNonceHash: 'nonce-1',
      startsAt: '2026-07-12T09:50:00.000Z',
      endsAt: '2026-07-12T10:00:00.000Z',
      expiresAt: '2026-07-12T10:05:00.000Z',
      manifest: { source: 'lark.im', retention: 'delete-raw-on-digest' },
    })
    first.close()
    stores.splice(stores.indexOf(first), 1)

    const second = openStore(databasePath)
    expect(second.getReadPlan('plan-1')).toMatchObject({
      id: 'plan-1',
      digest: 'digest-1',
      status: 'pending',
      manifest: { source: 'lark.im', retention: 'delete-raw-on-digest' },
    })
  })

  it('claims an approved plan at most once and rejects a changed digest', () => {
    const store = openStore()
    store.saveReadPlan({
      id: 'plan-1',
      digest: 'digest-1',
      approvalNonceHash: 'nonce-1',
      startsAt: '2026-07-12T09:50:00.000Z',
      endsAt: '2026-07-12T10:00:00.000Z',
      expiresAt: '2026-07-12T10:05:00.000Z',
      manifest: {},
    })

    expect(() =>
      store.claimReadPlan({
        id: 'plan-1',
        digest: 'changed',
        approvalNonceHash: 'nonce-1',
        now: '2026-07-12T10:01:00.000Z',
      }),
    ).toThrow('READ_PLAN_MISMATCH')

    expect(
      store.claimReadPlan({
        id: 'plan-1',
        digest: 'digest-1',
        approvalNonceHash: 'nonce-1',
        now: '2026-07-12T10:01:00.000Z',
      }),
    ).toMatchObject({ status: 'approved' })

    expect(() =>
      store.claimReadPlan({
        id: 'plan-1',
        digest: 'digest-1',
        approvalNonceHash: 'nonce-1',
        now: '2026-07-12T10:01:01.000Z',
      }),
    ).toThrow('READ_PLAN_ALREADY_CLAIMED')
  })

  it('treats the exact expiry instant as expired', () => {
    const store = openStore()
    store.saveReadPlan({
      id: 'plan-expiring',
      digest: 'digest-expiring',
      approvalNonceHash: 'nonce-expiring',
      startsAt: '2026-07-12T09:50:00.000Z',
      endsAt: '2026-07-12T10:00:00.000Z',
      expiresAt: '2026-07-12T10:05:00.000Z',
      manifest: {},
    })

    expect(() =>
      store.claimReadPlan({
        id: 'plan-expiring',
        digest: 'digest-expiring',
        approvalNonceHash: 'nonce-expiring',
        now: '2026-07-12T10:05:00.000Z',
      }),
    ).toThrow('READ_PLAN_EXPIRED')
  })

  it('deduplicates inbound metadata while message content is null from first insert', () => {
    const store = openStore()
    store.createReadRun({
      id: 'run-1',
      planId: 'plan-1',
      startedAt: '2026-07-12T10:01:00.000Z',
    })

    const event = {
      runId: 'run-1',
      sourceId: 'om_1',
      occurredAt: '2026-07-12T09:58:00.000Z',
      senderOpenId: 'ou_sender',
      chatId: 'oc_chat',
      metadata: { mentionsMe: true },
      observedAt: '2026-07-12T10:01:01.000Z',
    }
    store.upsertInboundEvent(event)
    store.upsertInboundEvent({
      ...event,
      occurredAt: '2026-07-12T09:58:01.000Z',
      observedAt: '2026-07-12T10:01:02.000Z',
    })

    expect(store.listInboundEvents('run-1')).toHaveLength(1)
    expect(store.listInboundEvents('run-1')[0]).toMatchObject({
      content: null,
      rawDeletedAt: '2026-07-12T10:01:02.000Z',
      occurredAt: '2026-07-12T09:58:01.000Z',
    })

    store.saveDigestAndCompleteRun({
      id: 'digest-1',
      runId: 'run-1',
      createdAt: '2026-07-12T10:02:00.000Z',
      summary: { now: 1, today: 0, fyi: 0 },
    })

    expect(store.getDigestByRunId('run-1')).toMatchObject({
      id: 'digest-1',
      summary: { now: 1, today: 0, fyi: 0 },
    })
    expect(store.listInboundEvents('run-1')[0]).toMatchObject({
      content: null,
      rawDeletedAt: '2026-07-12T10:01:02.000Z',
    })
    expect(store.getReadRun('run-1')).toMatchObject({ status: 'completed' })
  })

  it('records a failed run without creating any inbound event', () => {
    const store = openStore()
    store.createReadRun({
      id: 'run-failed',
      planId: 'plan-1',
      startedAt: '2026-07-12T10:01:00.000Z',
    })

    store.failReadRun({
      id: 'run-failed',
      failedAt: '2026-07-12T10:01:01.000Z',
      failureCode: 'READ_RESULT_OUTSIDE_PLAN',
    })

    expect(store.getReadRun('run-failed')).toEqual({
      id: 'run-failed',
      planId: 'plan-1',
      status: 'failed',
      startedAt: '2026-07-12T10:01:00.000Z',
      completedAt: '2026-07-12T10:01:01.000Z',
      failureCode: 'READ_RESULT_OUTSIDE_PLAN',
    })
    expect(store.listInboundEvents('run-failed')).toEqual([])
  })

  it('recovers interrupted and claimed-without-run reads as explicit unknown failures', () => {
    const store = openStore()
    store.saveReadPlan({
      id: 'plan-orphan',
      digest: 'digest-orphan',
      approvalNonceHash: 'nonce-orphan',
      startsAt: '2026-07-12T09:50:00.000Z',
      endsAt: '2026-07-12T10:00:00.000Z',
      expiresAt: '2026-07-12T10:05:00.000Z',
      manifest: {},
    })
    store.claimReadPlan({
      id: 'plan-orphan',
      digest: 'digest-orphan',
      approvalNonceHash: 'nonce-orphan',
      now: '2026-07-12T10:01:00.000Z',
    })
    store.createReadRun({
      id: 'run-interrupted',
      planId: 'plan-running',
      startedAt: '2026-07-12T10:01:00.000Z',
    })

    expect(store.recoverInterruptedReads('2026-07-12T10:02:00.000Z')).toEqual({
      interruptedRuns: 1,
      orphanedPlans: 1,
    })
    expect(store.getReadRun('run-interrupted')).toMatchObject({
      status: 'failed',
      completedAt: '2026-07-12T10:02:00.000Z',
      failureCode: 'PROCESS_INTERRUPTED_RESULT_UNKNOWN',
    })
    expect(store.listReadRunsForPlan('plan-orphan')).toEqual([
      expect.objectContaining({
        status: 'failed',
        failureCode: 'PROCESS_INTERRUPTED_BEFORE_RUN',
      }),
    ])
    expect(store.recoverInterruptedReads('2026-07-12T10:03:00.000Z')).toEqual({
      interruptedRuns: 0,
      orphanedPlans: 0,
    })
  })
})
