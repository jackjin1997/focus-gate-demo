import type { LarkCliOperation } from './types'

export type LarkCliAdapterErrorCode =
  | 'CLI_UNAVAILABLE'
  | 'COMMAND_FAILED'
  | 'PERMISSION_DENIED'
  | 'INCOMPLETE_RESULT'
  | 'OUT_OF_RANGE_RESULT'
  | 'INVALID_ARGUMENT'
  | 'INVALID_RESPONSE'

const ERROR_MESSAGES: Record<LarkCliAdapterErrorCode, string> = {
  CLI_UNAVAILABLE: 'lark-cli is not available on this device.',
  COMMAND_FAILED: 'The lark-cli command could not be completed.',
  PERMISSION_DENIED: 'The current Feishu authorization does not allow this operation.',
  INCOMPLETE_RESULT: 'lark-cli could not return the complete message window.',
  OUT_OF_RANGE_RESULT: 'lark-cli returned a message outside the approved window.',
  INVALID_ARGUMENT: 'The lark-cli request parameters are invalid.',
  INVALID_RESPONSE: 'lark-cli returned an unsupported response.',
}

export interface LarkCliAdapterErrorOptions {
  readonly code: LarkCliAdapterErrorCode
  readonly operation: LarkCliOperation
  readonly exitCode?: number
  readonly retryable: boolean
}

export class LarkCliAdapterError extends Error {
  readonly code: LarkCliAdapterErrorCode
  readonly operation: LarkCliOperation
  readonly exitCode?: number
  readonly retryable: boolean

  constructor(options: LarkCliAdapterErrorOptions) {
    super(ERROR_MESSAGES[options.code])
    this.name = 'LarkCliAdapterError'
    this.code = options.code
    this.operation = options.operation
    this.exitCode = options.exitCode
    this.retryable = options.retryable
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      retryable: this.retryable,
      message: this.message,
    }
  }
}
