import { spawn as nodeSpawn } from 'node:child_process'

import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from './types'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_TERMINATION_GRACE_MS = 2_000

export type NodeCommandRunnerErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INVOCATION'
  | 'SPAWN_FAILED'
  | 'PROFILE_NOT_PINNED'
  | 'PROFILE_DISCOVERY_FAILED'
  | 'TIMED_OUT'
  | 'OUTPUT_LIMIT_EXCEEDED'

const ERROR_MESSAGES: Record<NodeCommandRunnerErrorCode, string> = {
  INVALID_CONFIGURATION: 'The lark-cli runner configuration is invalid.',
  INVALID_INVOCATION: 'The lark-cli process invocation is invalid.',
  SPAWN_FAILED: 'The lark-cli process could not be started.',
  PROFILE_NOT_PINNED: 'The lark-cli profile has not been pinned.',
  PROFILE_DISCOVERY_FAILED: 'The active lark-cli profile could not be pinned.',
  TIMED_OUT: 'The lark-cli process timed out.',
  OUTPUT_LIMIT_EXCEEDED: 'The lark-cli process exceeded the output limit.',
}

export class NodeCommandRunnerError extends Error {
  readonly code: NodeCommandRunnerErrorCode

  constructor(code: NodeCommandRunnerErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'NodeCommandRunnerError'
    this.code = code
  }

  toJSON(): Record<string, string> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    }
  }
}

export interface SpawnReadable {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): this
}

export interface SpawnedProcess {
  readonly stdout: SpawnReadable
  readonly stderr: SpawnReadable
  on(event: 'error', listener: (error: Error) => void): this
  on(
    event: 'close',
    listener: (exitCode: number | null, signal: string | null) => void,
  ): this
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean
}

export interface SafeSpawnOptions {
  readonly shell: false
  readonly stdio: readonly ['ignore', 'pipe', 'pipe']
  readonly windowsHide: true
  readonly env: Readonly<Record<string, string>>
}

export type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SafeSpawnOptions,
) => SpawnedProcess

export interface NodeCommandRunnerOptions {
  readonly executablePath?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly terminationGraceMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly spawn?: SpawnProcess
  readonly requireProfilePin?: boolean
}

export class NodeCommandRunner implements CommandRunner {
  private readonly executablePath?: string
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly terminationGraceMs: number
  private readonly env: Readonly<Record<string, string>>
  private readonly spawn: SpawnProcess
  private readonly requireProfilePin: boolean
  private profileName: string | undefined
  private profilePinPromise: Promise<string> | undefined

  constructor(options: NodeCommandRunnerOptions = {}) {
    this.executablePath = options.executablePath
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS
    this.env = sanitizeEnvironment(options.env ?? process.env)
    this.spawn = options.spawn ?? defaultSpawn
    this.requireProfilePin = options.requireProfilePin ?? false

    if (
      !isPositiveInteger(this.timeoutMs) ||
      !isPositiveInteger(this.maxOutputBytes) ||
      !isPositiveInteger(this.terminationGraceMs) ||
      (this.executablePath !== undefined && this.executablePath.length === 0)
    ) {
      throw new NodeCommandRunnerError('INVALID_CONFIGURATION')
    }
  }

  run(invocation: CommandInvocation): Promise<CommandResult> {
    if (
      invocation.executable !== 'lark-cli' ||
      !Array.isArray(invocation.args) ||
      !invocation.args.every((arg) => typeof arg === 'string') ||
      invocation.options.shell !== false
    ) {
      return Promise.reject(new NodeCommandRunnerError('INVALID_INVOCATION'))
    }

    if (this.requireProfilePin && this.profileName === undefined) {
      return Promise.reject(new NodeCommandRunnerError('PROFILE_NOT_PINNED'))
    }

    const args = this.profileName === undefined
      ? invocation.args
      : ['--profile', this.profileName, ...invocation.args]
    return this.execute(invocation, args)
  }

  async pinActiveProfile(): Promise<string> {
    if (this.profileName !== undefined) return this.profileName
    if (this.profilePinPromise !== undefined) return this.profilePinPromise

    const discovery = this.discoverActiveProfile()
    this.profilePinPromise = discovery
    try {
      return await discovery
    } catch (error) {
      this.profilePinPromise = undefined
      throw error
    }
  }

  private async discoverActiveProfile(): Promise<string> {
    const result = await this.execute(
      {
        executable: 'lark-cli',
        args: ['profile', 'list'],
        options: { shell: false },
      },
      ['profile', 'list'],
    )
    if (result.exitCode !== 0) {
      throw new NodeCommandRunnerError('PROFILE_DISCOVERY_FAILED')
    }

    try {
      const parsed: unknown = JSON.parse(result.stdout)
      const profiles = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.profiles)
          ? parsed.profiles
          : []
      const active = profiles.filter(
        (profile): profile is Record<string, unknown> =>
          isRecord(profile) && profile.active === true &&
          typeof profile.name === 'string' && profile.name.length > 0,
      )
      if (active.length !== 1) throw new Error('active profile is ambiguous')
      this.profileName = active[0].name as string
      return this.profileName
    } catch {
      throw new NodeCommandRunnerError('PROFILE_DISCOVERY_FAILED')
    }
  }

  private execute(
    invocation: CommandInvocation,
    args: readonly string[],
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let child: SpawnedProcess

      try {
        child = this.spawn(
          this.executablePath ?? invocation.executable,
          [...args],
          {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: this.env,
          },
        )
      } catch {
        reject(new NodeCommandRunnerError('SPAWN_FAILED'))
        return
      }

      const stdout: Uint8Array[] = []
      const stderr: Uint8Array[] = []
      let outputBytes = 0
      let settled = false
      let stopReason: NodeCommandRunnerErrorCode | null = null
      let graceTimer: ReturnType<typeof setTimeout> | undefined

      const cleanup = (): void => {
        clearTimeout(timeoutTimer)
        if (graceTimer !== undefined) {
          clearTimeout(graceTimer)
        }
      }

      const fail = (code: NodeCommandRunnerErrorCode): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new NodeCommandRunnerError(code))
      }

      const stop = (code: NodeCommandRunnerErrorCode): void => {
        if (settled || stopReason !== null) return
        stopReason = code
        graceTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // The fixed runner error remains the only outward diagnostic.
          } finally {
            fail(code)
          }
        }, this.terminationGraceMs)
        try {
          child.kill('SIGTERM')
        } catch {
          fail(code)
        }
      }

      const capture = (target: Uint8Array[], chunk: Uint8Array | string): void => {
        if (settled || stopReason !== null) return
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
        outputBytes += bytes.byteLength

        if (outputBytes > this.maxOutputBytes) {
          stop('OUTPUT_LIMIT_EXCEEDED')
          return
        }

        target.push(bytes)
      }

      const timeoutTimer = setTimeout(
        () => stop('TIMED_OUT'),
        this.timeoutMs,
      )

      child.stdout.on('data', (chunk) => capture(stdout, chunk))
      child.stderr.on('data', (chunk) => capture(stderr, chunk))
      child.on('error', () => fail(stopReason ?? 'SPAWN_FAILED'))
      child.on('close', (exitCode) => {
        if (settled) return
        if (stopReason !== null) {
          fail(stopReason)
          return
        }

        settled = true
        cleanup()
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        })
      })
    })
  }
}

const defaultSpawn: SpawnProcess = (executable, args, options) =>
  nodeSpawn(executable, [...args], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: options.windowsHide,
    env: { ...options.env },
  }) as unknown as SpawnedProcess

const sanitizeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const sanitized: Record<string, string> = {}

  for (const [key, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      !['http_proxy', 'https_proxy', 'all_proxy'].includes(key.toLowerCase())
    ) {
      sanitized[key] = value
    }
  }

  sanitized.LARK_CLI_NO_PROXY = '1'
  return Object.freeze(sanitized)
}

const isPositiveInteger = (value: number): boolean =>
  Number.isInteger(value) && value > 0

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
