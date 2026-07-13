import {
  CAPABILITY_INVOCATIONS,
  buildRecentMessagesSearchInvocation,
} from './commands'
import { LarkCliAdapterError } from './errors'
import { NodeCommandRunnerError } from './node-command-runner'
import { parseCapabilityReview, parseMessages } from './parsers'
import type {
  CapabilityReview,
  CommandInvocation,
  CommandResult,
  CommandRunner,
  LarkCliOperation,
  RecentMessageWindow,
  SafeLarkCliLogEvent,
  SafeLarkCliLogger,
  StandardLarkMessage,
} from './types'

export interface LarkCliAdapterOptions {
  readonly runner: CommandRunner
  readonly logger?: SafeLarkCliLogger
  readonly now?: () => number
  readonly pinProfile?: () => Promise<string>
}

export class LarkCliAdapter {
  private readonly runner: CommandRunner
  private readonly logger?: SafeLarkCliLogger
  private readonly now: () => number
  private readonly pinProfile?: () => Promise<string>

  constructor(options: LarkCliAdapterOptions) {
    this.runner = options.runner
    this.logger = options.logger
    this.now = options.now ?? Date.now
    this.pinProfile = options.pinProfile
  }

  async reviewCapabilities(): Promise<CapabilityReview> {
    const profileName = await this.pinProfile?.() ?? null
    const outputs = new Map<LarkCliOperation, string>()

    for (const [operation, command] of CAPABILITY_INVOCATIONS) {
      const result = await this.execute(operation, command)
      outputs.set(operation, result.stdout)
    }

    return {
      ...parseCapabilityReview({
        version: outputs.get('capabilities.version') ?? '',
        authStatus: outputs.get('capabilities.auth-status') ?? '',
        scopes: outputs.get('capabilities.scopes') ?? '',
        events: outputs.get('capabilities.events') ?? '',
      }),
      profileName,
    }
  }

  async readRecentMessages(
    window: RecentMessageWindow,
  ): Promise<readonly StandardLarkMessage[]> {
    const command = buildRecentMessagesSearchInvocation(window)
    const startedAt = this.now()

    try {
      await this.pinProfile?.()
      const result = await this.run(command, 'messages.search')
      const messages = parseMessages(result.stdout)
      assertMessagesInsideWindow(messages, window)
      this.log({
        component: 'lark-cli-adapter',
        operation: 'messages.search',
        outcome: 'success',
        durationMs: this.elapsed(startedAt),
        exitCode: result.exitCode,
        itemCount: messages.length,
      })
      return messages
    } catch (error) {
      const structuredError = this.normalizeError(error, 'messages.search')
      this.logError(structuredError, startedAt)
      throw structuredError
    }
  }

  private async execute(
    operation: LarkCliOperation,
    command: CommandInvocation,
  ): Promise<CommandResult> {
    const startedAt = this.now()

    try {
      const result = await this.run(command, operation)
      this.log({
        component: 'lark-cli-adapter',
        operation,
        outcome: 'success',
        durationMs: this.elapsed(startedAt),
        exitCode: result.exitCode,
      })
      return result
    } catch (error) {
      const structuredError = this.normalizeError(error, operation)
      this.logError(structuredError, startedAt)
      throw structuredError
    }
  }

  private async run(
    command: CommandInvocation,
    operation: LarkCliOperation,
  ): Promise<CommandResult> {
    let result: CommandResult

    try {
      result = await this.runner.run(command)
    } catch (error) {
      if (error instanceof NodeCommandRunnerError) {
        const code =
          error.code === 'SPAWN_FAILED'
            ? 'CLI_UNAVAILABLE'
            : 'COMMAND_FAILED'
        throw new LarkCliAdapterError({
          code,
          operation,
          retryable: error.code === 'TIMED_OUT',
        })
      }

      throw new LarkCliAdapterError({
        code: 'CLI_UNAVAILABLE',
        operation,
        retryable: false,
      })
    }

    if (result.exitCode !== 0) {
      throw classifyCommandFailure(result, operation)
    }

    return result
  }

  private normalizeError(
    error: unknown,
    operation: LarkCliOperation,
  ): LarkCliAdapterError {
    if (error instanceof LarkCliAdapterError) {
      return error
    }

    return new LarkCliAdapterError({
      code: 'COMMAND_FAILED',
      operation,
      retryable: false,
    })
  }

  private logError(error: LarkCliAdapterError, startedAt: number): void {
    this.log({
      component: 'lark-cli-adapter',
      operation: error.operation,
      outcome: 'error',
      durationMs: this.elapsed(startedAt),
      ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      errorCode: error.code,
    })
  }

  private log(event: SafeLarkCliLogEvent): void {
    this.logger?.log(Object.freeze(event))
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, this.now() - startedAt)
  }
}

const assertMessagesInsideWindow = (
  messages: readonly StandardLarkMessage[],
  window: RecentMessageWindow,
): void => {
  const fromInclusive = window.fromInclusive.getTime()
  const toExclusive = window.toExclusive.getTime()
  const outsideApprovedWindow = messages.some((message) => {
    const occurredAt = Date.parse(message.occurredAt)
    return !Number.isFinite(occurredAt) ||
      occurredAt < fromInclusive ||
      occurredAt >= toExclusive
  })

  if (outsideApprovedWindow) {
    throw new LarkCliAdapterError({
      code: 'OUT_OF_RANGE_RESULT',
      operation: 'messages.search',
      retryable: false,
    })
  }
}

const classifyCommandFailure = (
  result: CommandResult,
  operation: LarkCliOperation,
): LarkCliAdapterError => {
  const permissionDenied =
    /permission_violations|permission denied|access denied|99991672/i.test(
      result.stderr,
    )

  return new LarkCliAdapterError({
    code: permissionDenied ? 'PERMISSION_DENIED' : 'COMMAND_FAILED',
    operation,
    exitCode: result.exitCode,
    retryable: false,
  })
}
