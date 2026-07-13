export type LarkCliOperation =
  | 'capabilities.version'
  | 'capabilities.auth-status'
  | 'capabilities.scopes'
  | 'capabilities.events'
  | 'messages.search'

export interface CommandInvocation {
  readonly executable: 'lark-cli'
  readonly args: readonly string[]
  readonly options: Readonly<{
    shell: false
  }>
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandResult>
}

export interface CapabilityReview {
  readonly cliVersion: string | null
  readonly profileName?: string | null
  readonly authenticated: boolean
  readonly identity: 'user' | 'bot' | 'auto' | 'unknown'
  readonly userOpenId: string | null
  readonly scopes: readonly string[]
  readonly eventKeys: readonly string[]
}

export interface StandardMessageIdentity {
  readonly id?: string
  readonly name?: string
  readonly type?: string
}

export interface StandardMessageChat {
  readonly id: string
  readonly name?: string
  readonly type?: string
}

export interface StandardMessageMention {
  readonly id?: string
  readonly key?: string
  readonly name?: string
}

export interface StandardLarkMessage {
  readonly sourceId: string
  readonly occurredAt: string
  readonly type: string
  readonly sender: StandardMessageIdentity
  readonly chat: StandardMessageChat
  readonly content: string
  readonly mentions: readonly StandardMessageMention[]
  readonly deleted: boolean
  readonly updated: boolean
}

export interface RecentMessageWindow {
  readonly fromInclusive: Date
  readonly toExclusive: Date
  readonly timezoneOffsetMinutes?: number
}

export interface SafeLarkCliLogEvent {
  readonly component: 'lark-cli-adapter'
  readonly operation: LarkCliOperation
  readonly outcome: 'success' | 'error'
  readonly durationMs: number
  readonly exitCode?: number
  readonly errorCode?: string
  readonly itemCount?: number
}

export interface SafeLarkCliLogger {
  log(event: SafeLarkCliLogEvent): void
}
