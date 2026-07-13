import { describe, expect, it } from 'vitest'

import { calculateSourceCoverage } from './source-coverage'

describe('SourceCoverage', () => {
  const window = {
    fromInclusive: '2026-07-12T02:10:00.000Z',
    toExclusive: '2026-07-12T02:20:00.000Z',
  }

  it('is complete only with an exhausted cursor, current heartbeat and no gaps', () => {
    const coverage = calculateSourceCoverage({
      source: 'feishu-im',
      window,
      cursor: {
        kind: 'exhausted',
        oldestObservedAt: '2026-07-12T02:09:59.000Z',
        newestObservedAt: '2026-07-12T02:19:59.000Z',
      },
      heartbeat: {
        kind: 'observed',
        lastObservedAt: '2026-07-12T02:20:02.000Z',
        maximumAgeMs: 30_000,
      },
      gaps: [],
      assessedAt: '2026-07-12T02:20:10.000Z',
    })

    expect(coverage.completeness).toEqual({ kind: 'complete' })
  })

  it('reports partial evidence for pagination, uncovered bounds and known gaps', () => {
    const coverage = calculateSourceCoverage({
      source: 'feishu-im',
      window,
      cursor: {
        kind: 'continuation',
        nextCursor: 'cursor-next',
        oldestObservedAt: '2026-07-12T02:12:00.000Z',
        newestObservedAt: '2026-07-12T02:19:30.000Z',
      },
      heartbeat: {
        kind: 'observed',
        lastObservedAt: '2026-07-12T02:20:01.000Z',
        maximumAgeMs: 30_000,
      },
      gaps: [
        {
          fromInclusive: '2026-07-12T02:15:00.000Z',
          toExclusive: '2026-07-12T02:16:00.000Z',
          reason: 'rate-limit',
        },
      ],
      assessedAt: '2026-07-12T02:20:10.000Z',
    })

    expect(coverage.completeness).toEqual({
      kind: 'partial',
      reasons: [
        'cursor-not-exhausted',
        'window-start-not-covered',
        'window-end-not-covered',
        'known-gaps',
      ],
    })
  })

  it('reports stale independently from partial cursor evidence', () => {
    const coverage = calculateSourceCoverage({
      source: 'feishu-im',
      window,
      cursor: {
        kind: 'exhausted',
        oldestObservedAt: '2026-07-12T02:09:59.000Z',
        newestObservedAt: '2026-07-12T02:19:59.000Z',
      },
      heartbeat: {
        kind: 'observed',
        lastObservedAt: '2026-07-12T02:19:00.000Z',
        maximumAgeMs: 30_000,
      },
      gaps: [],
      assessedAt: '2026-07-12T02:20:10.000Z',
    })

    expect(coverage.completeness).toEqual({
      kind: 'stale',
      reasons: ['heartbeat-stale'],
    })
  })

  it('reports unknown when required source evidence was not observed', () => {
    const coverage = calculateSourceCoverage({
      source: 'feishu-im',
      window,
      cursor: { kind: 'unavailable', reason: 'permission-denied' },
      heartbeat: { kind: 'missing', reason: 'listener-not-started' },
      gaps: [],
      assessedAt: '2026-07-12T02:20:10.000Z',
    })

    expect(coverage.completeness).toEqual({
      kind: 'unknown',
      reasons: ['cursor-unavailable', 'heartbeat-missing'],
    })
  })
})
