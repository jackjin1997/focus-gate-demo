import { describe, expect, it } from 'vitest'

import { createReadGrant, createReadPlan } from './read-plan'
import {
  createFocusEvent,
  InvalidFocusTransitionError,
  transitionFocusEvent,
} from './focus-event'

describe('FocusEvent state machine', () => {
  const createdAt = '2026-07-12T02:20:00.000Z'
  const plan = createReadPlan({ requestedAt: createdAt })
  const grant = createReadGrant(plan, {
    grantId: 'grant-focus-1',
    grantedAt: '2026-07-12T02:20:01.000Z',
    expiresAt: '2026-07-12T02:22:00.000Z',
  })

  it('moves through approval, focus, digest review and completion', () => {
    const draft = createFocusEvent({
      id: 'focus-1',
      thought: '专注之门一期最该替我守住什么？',
      createdAt,
    })
    expect(draft.state).toEqual({ kind: 'draft' })

    const awaiting = transitionFocusEvent(draft, {
      type: 'request-read-grant',
      plan,
      at: createdAt,
    })
    expect(awaiting.state.kind).toBe('awaiting-read-grant')

    const active = transitionFocusEvent(awaiting, {
      type: 'start',
      grant,
      at: '2026-07-12T02:20:05.000Z',
    })
    expect(active.state).toMatchObject({
      kind: 'active',
      readGrantId: 'grant-focus-1',
    })

    const digesting = transitionFocusEvent(active, {
      type: 'end',
      at: '2026-07-12T03:20:05.000Z',
    })
    expect(digesting.state.kind).toBe('digesting')

    const digestReady = transitionFocusEvent(digesting, {
      type: 'publish-digest',
      digestDigest: 'sha256:digest-1',
      at: '2026-07-12T03:20:06.000Z',
    })
    expect(digestReady.state.kind).toBe('digest-ready')

    const completed = transitionFocusEvent(digestReady, {
      type: 'complete',
      at: '2026-07-12T03:21:00.000Z',
    })
    expect(completed.state).toMatchObject({
      kind: 'completed',
      digestDigest: 'sha256:digest-1',
    })
  })

  it('will not start with a grant for a different plan', () => {
    const otherPlan = createReadPlan({
      requestedAt: '2026-07-12T02:21:00.000Z',
    })
    const awaiting = transitionFocusEvent(
      createFocusEvent({ id: 'focus-2', thought: 'One thing', createdAt }),
      { type: 'request-read-grant', plan: otherPlan, at: createdAt },
    )

    expect(() =>
      transitionFocusEvent(awaiting, {
        type: 'start',
        grant,
        at: '2026-07-12T02:21:05.000Z',
      }),
    ).toThrow(/plan-mismatch/)
  })

  it('rejects transitions that bypass required states', () => {
    const draft = createFocusEvent({
      id: 'focus-3',
      thought: 'One thing',
      createdAt,
    })

    expect(() =>
      transitionFocusEvent(draft, {
        type: 'end',
        at: '2026-07-12T02:21:00.000Z',
      }),
    ).toThrow(InvalidFocusTransitionError)
  })

  it('allows cancellation before entry but not while focus is active', () => {
    const draft = createFocusEvent({
      id: 'focus-4',
      thought: 'One thing',
      createdAt,
    })
    const cancelled = transitionFocusEvent(draft, {
      type: 'cancel',
      reason: 'user-cancelled',
      at: '2026-07-12T02:20:01.000Z',
    })
    expect(cancelled.state.kind).toBe('cancelled')

    const awaiting = transitionFocusEvent(draft, {
      type: 'request-read-grant',
      plan,
      at: createdAt,
    })
    const active = transitionFocusEvent(awaiting, {
      type: 'start',
      grant,
      at: '2026-07-12T02:20:05.000Z',
    })
    expect(() =>
      transitionFocusEvent(active, {
        type: 'cancel',
        reason: 'user-cancelled',
        at: '2026-07-12T02:20:06.000Z',
      }),
    ).toThrow(/must be ended/i)
  })
})
