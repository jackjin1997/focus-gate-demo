import { parseInstant } from './instant'

export type CursorEvidence =
  | {
      readonly kind: 'exhausted'
      readonly oldestObservedAt: string
      readonly newestObservedAt: string
    }
  | {
      readonly kind: 'continuation'
      readonly nextCursor: string
      readonly oldestObservedAt: string
      readonly newestObservedAt: string
    }
  | {
      readonly kind: 'unavailable'
      readonly reason: string
    }

export type HeartbeatEvidence =
  | {
      readonly kind: 'observed'
      readonly lastObservedAt: string
      readonly maximumAgeMs: number
    }
  | {
      readonly kind: 'missing'
      readonly reason: string
    }

export interface CoverageGap {
  readonly fromInclusive: string
  readonly toExclusive: string
  readonly reason: string
}

export type CoverageCompleteness =
  | { readonly kind: 'complete' }
  | {
      readonly kind: 'partial' | 'stale' | 'unknown'
      readonly reasons: readonly string[]
    }

export interface SourceCoverage {
  readonly source: string
  readonly window: {
    readonly fromInclusive: string
    readonly toExclusive: string
  }
  readonly cursor: CursorEvidence
  readonly heartbeat: HeartbeatEvidence
  readonly gaps: readonly CoverageGap[]
  readonly assessedAt: string
  readonly completeness: CoverageCompleteness
}

export function calculateSourceCoverage(input: Omit<SourceCoverage, 'completeness'>): SourceCoverage {
  const fromMs = parseInstant('window.fromInclusive', input.window.fromInclusive)
  const toMs = parseInstant('window.toExclusive', input.window.toExclusive)
  const assessedAtMs = parseInstant('assessedAt', input.assessedAt)

  if (toMs <= fromMs) {
    throw new RangeError('window.toExclusive must be after window.fromInclusive')
  }

  validateGaps(input.gaps, fromMs, toMs)

  if (input.cursor.kind === 'unavailable' || input.heartbeat.kind === 'missing') {
    const unknownReasons: string[] = []
    if (input.cursor.kind === 'unavailable') {
      unknownReasons.push('cursor-unavailable')
    }
    if (input.heartbeat.kind === 'missing') {
      unknownReasons.push('heartbeat-missing')
    }
    return withCompleteness(input, { kind: 'unknown', reasons: unknownReasons })
  }

  const cursor = input.cursor
  const heartbeat = input.heartbeat
  const heartbeatMs = parseInstant(
    'heartbeat.lastObservedAt',
    heartbeat.lastObservedAt,
  )
  if (!Number.isSafeInteger(heartbeat.maximumAgeMs) || heartbeat.maximumAgeMs <= 0) {
    throw new RangeError('heartbeat.maximumAgeMs must be a positive integer')
  }

  const heartbeatAgeMs = assessedAtMs - heartbeatMs
  if (heartbeatAgeMs < 0) {
    throw new RangeError('heartbeat.lastObservedAt must not be after assessedAt')
  }
  if (heartbeatAgeMs > heartbeat.maximumAgeMs) {
    return withCompleteness(input, {
      kind: 'stale',
      reasons: ['heartbeat-stale'],
    })
  }

  const partialReasons: string[] = []
  if (cursor.kind === 'continuation') {
    if (cursor.nextCursor.trim().length === 0) {
      throw new TypeError('cursor.nextCursor must not be empty')
    }
    partialReasons.push('cursor-not-exhausted')
  }

  const oldestMs = parseInstant('cursor.oldestObservedAt', cursor.oldestObservedAt)
  const newestMs = parseInstant('cursor.newestObservedAt', cursor.newestObservedAt)
  if (newestMs < oldestMs) {
    throw new RangeError('cursor newest observation must not precede oldest observation')
  }
  if (oldestMs > fromMs) {
    partialReasons.push('window-start-not-covered')
  }
  if (toMs - newestMs >= heartbeat.maximumAgeMs) {
    partialReasons.push('window-end-not-covered')
  }
  if (input.gaps.length > 0) {
    partialReasons.push('known-gaps')
  }

  return withCompleteness(
    input,
    partialReasons.length === 0
      ? { kind: 'complete' }
      : { kind: 'partial', reasons: partialReasons },
  )
}

function validateGaps(
  gaps: readonly CoverageGap[],
  windowFromMs: number,
  windowToMs: number,
): void {
  for (const [index, gap] of gaps.entries()) {
    const fromMs = parseInstant(`gaps[${index}].fromInclusive`, gap.fromInclusive)
    const toMs = parseInstant(`gaps[${index}].toExclusive`, gap.toExclusive)
    if (toMs <= fromMs) {
      throw new RangeError(`gaps[${index}] must have a positive duration`)
    }
    if (fromMs < windowFromMs || toMs > windowToMs) {
      throw new RangeError(`gaps[${index}] must be within the requested window`)
    }
    if (gap.reason.trim().length === 0) {
      throw new TypeError(`gaps[${index}].reason must not be empty`)
    }
  }
}

function withCompleteness(
  input: Omit<SourceCoverage, 'completeness'>,
  completeness: CoverageCompleteness,
): SourceCoverage {
  return { ...input, completeness }
}
