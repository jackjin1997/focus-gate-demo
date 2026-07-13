import { canonicalDigest } from './canonical'
import { assertChronological, parseInstant } from './instant'
import {
  type ReadGrant,
  type ReadPlan,
  validateReadGrant,
} from './read-plan'

export type FocusEventState =
  | { readonly kind: 'draft' }
  | {
      readonly kind: 'awaiting-read-grant'
      readonly readPlan: ReadPlan
      readonly readPlanDigest: string
      readonly requestedAt: string
    }
  | {
      readonly kind: 'active'
      readonly readPlanDigest: string
      readonly readGrantId: string
      readonly startedAt: string
    }
  | {
      readonly kind: 'digesting'
      readonly readPlanDigest: string
      readonly readGrantId: string
      readonly startedAt: string
      readonly endedAt: string
    }
  | {
      readonly kind: 'digest-ready'
      readonly readPlanDigest: string
      readonly readGrantId: string
      readonly startedAt: string
      readonly endedAt: string
      readonly digestDigest: string
      readonly digestReadyAt: string
    }
  | {
      readonly kind: 'completed'
      readonly readPlanDigest: string
      readonly readGrantId: string
      readonly startedAt: string
      readonly endedAt: string
      readonly digestDigest: string
      readonly completedAt: string
    }
  | {
      readonly kind: 'cancelled'
      readonly reason: string
      readonly cancelledAt: string
    }

export interface FocusEvent {
  readonly version: 1
  readonly id: string
  readonly thought: string
  readonly createdAt: string
  readonly state: FocusEventState
}

export type FocusEventCommand =
  | {
      readonly type: 'request-read-grant'
      readonly plan: ReadPlan
      readonly at: string
    }
  | {
      readonly type: 'start'
      readonly grant: ReadGrant
      readonly at: string
    }
  | { readonly type: 'end'; readonly at: string }
  | {
      readonly type: 'publish-digest'
      readonly digestDigest: string
      readonly at: string
    }
  | { readonly type: 'complete'; readonly at: string }
  | {
      readonly type: 'cancel'
      readonly reason: string
      readonly at: string
    }

export class InvalidFocusTransitionError extends Error {
  readonly from: FocusEventState['kind']
  readonly command: FocusEventCommand['type']

  constructor(
    from: FocusEventState['kind'],
    command: FocusEventCommand['type'],
    detail?: string,
  ) {
    super(
      `Cannot apply ${command} while FocusEvent is ${from}${detail ? `: ${detail}` : ''}`,
    )
    this.name = 'InvalidFocusTransitionError'
    this.from = from
    this.command = command
  }
}

export function createFocusEvent(input: {
  readonly id: string
  readonly thought: string
  readonly createdAt: string
}): FocusEvent {
  if (input.id.trim().length === 0) {
    throw new TypeError('FocusEvent id must not be empty')
  }
  if (input.thought.trim().length === 0) {
    throw new TypeError('FocusEvent thought must not be empty')
  }
  parseInstant('createdAt', input.createdAt)

  return {
    version: 1,
    id: input.id,
    thought: input.thought,
    createdAt: input.createdAt,
    state: { kind: 'draft' },
  }
}

export function transitionFocusEvent(
  event: FocusEvent,
  command: FocusEventCommand,
): FocusEvent {
  parseInstant('command.at', command.at)
  assertChronological('event.createdAt', event.createdAt, 'command.at', command.at)

  switch (command.type) {
    case 'request-read-grant':
      requireState(event, command, 'draft')
      return changeState(event, {
        kind: 'awaiting-read-grant',
        readPlan: command.plan,
        readPlanDigest: canonicalDigest(command.plan),
        requestedAt: command.at,
      })

    case 'start': {
      const state = requireState(event, command, 'awaiting-read-grant')
      assertChronological('state.requestedAt', state.requestedAt, 'command.at', command.at)
      const validation = validateReadGrant(state.readPlan, command.grant, command.at)
      if (validation.kind === 'invalid') {
        throw new InvalidFocusTransitionError(
          state.kind,
          command.type,
          validation.reason,
        )
      }
      return changeState(event, {
        kind: 'active',
        readPlanDigest: state.readPlanDigest,
        readGrantId: command.grant.grantId,
        startedAt: command.at,
      })
    }

    case 'end': {
      const state = requireState(event, command, 'active')
      assertChronological('state.startedAt', state.startedAt, 'command.at', command.at)
      return changeState(event, {
        ...state,
        kind: 'digesting',
        endedAt: command.at,
      })
    }

    case 'publish-digest': {
      const state = requireState(event, command, 'digesting')
      assertChronological('state.endedAt', state.endedAt, 'command.at', command.at)
      if (command.digestDigest.trim().length === 0) {
        throw new TypeError('digestDigest must not be empty')
      }
      return changeState(event, {
        ...state,
        kind: 'digest-ready',
        digestDigest: command.digestDigest,
        digestReadyAt: command.at,
      })
    }

    case 'complete': {
      const state = requireState(event, command, 'digest-ready')
      assertChronological(
        'state.digestReadyAt',
        state.digestReadyAt,
        'command.at',
        command.at,
      )
      return changeState(event, {
        kind: 'completed',
        readPlanDigest: state.readPlanDigest,
        readGrantId: state.readGrantId,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        digestDigest: state.digestDigest,
        completedAt: command.at,
      })
    }

    case 'cancel': {
      if (event.state.kind === 'active') {
        throw new InvalidFocusTransitionError(
          event.state.kind,
          command.type,
          'an active focus event must be ended before it can close',
        )
      }
      if (
        event.state.kind !== 'draft' &&
        event.state.kind !== 'awaiting-read-grant'
      ) {
        throw new InvalidFocusTransitionError(event.state.kind, command.type)
      }
      if (command.reason.trim().length === 0) {
        throw new TypeError('cancellation reason must not be empty')
      }
      return changeState(event, {
        kind: 'cancelled',
        reason: command.reason,
        cancelledAt: command.at,
      })
    }
  }
}

function requireState<K extends FocusEventState['kind']>(
  event: FocusEvent,
  command: FocusEventCommand,
  expected: K,
): Extract<FocusEventState, { readonly kind: K }> {
  if (event.state.kind !== expected) {
    throw new InvalidFocusTransitionError(event.state.kind, command.type)
  }

  return event.state as Extract<FocusEventState, { readonly kind: K }>
}

function changeState(event: FocusEvent, state: FocusEventState): FocusEvent {
  return { ...event, state }
}
