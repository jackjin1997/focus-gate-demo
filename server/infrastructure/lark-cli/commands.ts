import { LarkCliAdapterError } from './errors'
import type { CommandInvocation, LarkCliOperation, RecentMessageWindow } from './types'

const TEN_MINUTES_MS = 10 * 60 * 1_000
const MAX_TIMEZONE_OFFSET_MINUTES = 14 * 60

const invocation = (args: readonly string[]): CommandInvocation =>
  Object.freeze({
    executable: 'lark-cli' as const,
    args: Object.freeze([...args]),
    options: Object.freeze({ shell: false as const }),
  })

export const CAPABILITY_INVOCATIONS: ReadonlyArray<
  readonly [LarkCliOperation, CommandInvocation]
> = Object.freeze([
  ['capabilities.version', invocation(['--version'])],
  ['capabilities.auth-status', invocation(['auth', 'status'])],
  ['capabilities.scopes', invocation(['auth', 'scopes'])],
  ['capabilities.events', invocation(['event', 'list', '--json'])],
])

export const buildRecentMessagesSearchInvocation = (
  window: RecentMessageWindow,
): CommandInvocation => {
  const startTime = window.fromInclusive.getTime()
  const endTime = window.toExclusive.getTime()
  const timezoneOffsetMinutes =
    window.timezoneOffsetMinutes ?? -window.toExclusive.getTimezoneOffset()

  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    endTime - startTime !== TEN_MINUTES_MS ||
    !Number.isInteger(timezoneOffsetMinutes) ||
    Math.abs(timezoneOffsetMinutes) > MAX_TIMEZONE_OFFSET_MINUTES
  ) {
    throw new LarkCliAdapterError({
      code: 'INVALID_ARGUMENT',
      operation: 'messages.search',
      retryable: false,
    })
  }

  return invocation([
    'im',
    '+messages-search',
    '--query',
    '',
    '--start',
    formatIsoWithOffset(window.fromInclusive, timezoneOffsetMinutes),
    '--end',
    formatIsoWithOffset(window.toExclusive, timezoneOffsetMinutes),
    '--page-size',
    '50',
    '--page-all',
    '--format',
    'json',
    '--as',
    'user',
  ])
}

export const buildRecentMessagesSearchArgs = (
  window: RecentMessageWindow,
): readonly string[] => buildRecentMessagesSearchInvocation(window).args

const formatIsoWithOffset = (date: Date, offsetMinutes: number): string => {
  const localTime = new Date(date.getTime() + offsetMinutes * 60_000)
  const dateTime = localTime.toISOString().slice(0, 23)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0')
  const minutes = String(absoluteOffset % 60).padStart(2, '0')

  return `${dateTime}${sign}${hours}:${minutes}`
}
