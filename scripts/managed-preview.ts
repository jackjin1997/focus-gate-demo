import {
  spawn as nodeSpawn,
  type ChildProcess,
} from 'node:child_process'
import { resolve } from 'node:path'

const LOCAL_BASE_URL = 'http://127.0.0.1:4173'
const PROCESS_ENDED = Symbol('process-ended')
const READINESS_TIMED_OUT = Symbol('readiness-timed-out')
const POLL_READY = Symbol('poll-ready')
const TERMINATION_GRACE_ENDED = Symbol('termination-grace-ended')
const PORT_PROBE_TIMED_OUT = Symbol('port-probe-timed-out')
const DEFAULT_READINESS_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 100
const DEFAULT_TERMINATION_GRACE_MS = 500
const DEFAULT_PORT_PROBE_TIMEOUT_MS = 500
const STOP_ERROR_MESSAGE = 'Managed preview could not be stopped.'

export interface ManagedPreviewTarget {
  readonly baseUrl: string
  readonly managed: boolean
  stop(): Promise<void>
}

export interface PreviewProcess {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  once(
    event: 'exit',
    listener: (
      exitCode: number | null,
      signalCode: NodeJS.Signals | null,
    ) => void,
  ): this
  once(event: 'error', listener: (error: Error) => void): this
  kill(signal: NodeJS.Signals): boolean
}

export interface PreviewSpawnOptions {
  readonly cwd: string
  readonly shell: false
  readonly stdio: 'ignore'
  readonly windowsHide: true
}

export type PreviewSpawner = (
  executable: string,
  args: readonly string[],
  options: PreviewSpawnOptions,
) => PreviewProcess

export type PreviewFetcher = (
  url: string,
  init: { readonly signal: AbortSignal },
) => PromiseLike<{ readonly ok: boolean }>

export interface PreviewTimers {
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

export interface ManagedPreviewOptions {
  readonly externalUrl?: string
  readonly cwd?: string
  readonly spawn?: PreviewSpawner
  readonly fetch?: PreviewFetcher
  readonly timers?: PreviewTimers
  readonly readinessTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly terminationGraceMs?: number
  readonly preflightTimeoutMs?: number
}

export async function startManagedPreview(
  options: ManagedPreviewOptions = {},
): Promise<ManagedPreviewTarget> {
  if (options.externalUrl !== undefined) {
    return {
      baseUrl: options.externalUrl,
      managed: false,
      stop: async () => undefined,
    }
  }

  const cwd = options.cwd ?? process.cwd()
  const spawn = options.spawn ?? defaultSpawn
  const fetch = options.fetch ?? defaultFetch
  const timers = options.timers ?? defaultTimers
  const readinessTimeoutMs =
    options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const terminationGraceMs =
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS
  const preflightTimeoutMs =
    options.preflightTimeoutMs ?? DEFAULT_PORT_PROBE_TIMEOUT_MS
  const portInUse = await probeLocalPort(
    fetch,
    timers,
    preflightTimeoutMs,
  )
  if (portInUse) {
    throw new Error('Managed preview port is already in use.')
  }

  let child: PreviewProcess
  try {
    child = spawn(
      process.execPath,
      [
        resolve(cwd, 'node_modules/vite/bin/vite.js'),
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        '4173',
        '--strictPort',
      ],
      {
        cwd,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    )
  } catch {
    throw new Error('Managed preview could not be started.')
  }
  const processExit = waitForProcessExit(child)
  const abortController = new AbortController()
  let stopPromise: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      try {
        if (hasExited(child)) return
        child.kill('SIGTERM')
        const exitedAfterTerm = await exitsWithinGrace(
          child,
          processExit,
          timers,
          terminationGraceMs,
        )
        if (exitedAfterTerm) return

        child.kill('SIGKILL')
        const exitedAfterKill = await exitsWithinGrace(
          child,
          processExit,
          timers,
          terminationGraceMs,
        )
        if (!exitedAfterKill) {
          throw new Error(STOP_ERROR_MESSAGE)
        }
      } catch {
        throw new Error(STOP_ERROR_MESSAGE)
      }
    })()
    return stopPromise
  }

  try {
    await waitUntilReady({
      fetch,
      signal: abortController.signal,
      processExit,
      processHasExited: () => hasExited(child),
      timers,
      readinessTimeoutMs,
      pollIntervalMs,
    })

    return {
      baseUrl: LOCAL_BASE_URL,
      managed: true,
      stop,
    }
  } catch (error) {
    abortController.abort()
    try {
      await stop()
    } catch {
      throw new Error(STOP_ERROR_MESSAGE)
    }
    throw error
  }
}

const defaultSpawn: PreviewSpawner = (
  executable,
  args,
  options,
): ChildProcess => nodeSpawn(executable, [...args], options)

const defaultFetch: PreviewFetcher = (url, init) => fetch(url, init)

const defaultTimers: PreviewTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
}

async function probeLocalPort(
  fetch: PreviewFetcher,
  timers: PreviewTimers,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController()
  const timeout = createDelay(
    timers,
    timeoutMs,
    PORT_PROBE_TIMED_OUT,
  )

  try {
    let probe: Promise<boolean>
    try {
      probe = Promise.resolve(
        fetch(LOCAL_BASE_URL, { signal: controller.signal }),
      ).then(
        (response) => {
          try {
            return response.ok
          } catch {
            return false
          }
        },
        () => false,
      )
    } catch {
      return false
    }

    const result = await Promise.race([
      probe,
      timeout.promise,
    ])
    if (result === PORT_PROBE_TIMED_OUT) {
      throw new Error('Managed preview port probe timed out.')
    }
    return result
  } finally {
    timeout.cancel()
    controller.abort()
  }
}

function hasExited(child: PreviewProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForProcessExit(child: PreviewProcess): Promise<void> {
  return new Promise((resolve) => {
    if (hasExited(child)) {
      resolve()
      return
    }

    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    child.once('exit', finish)
    child.once('error', finish)

    if (hasExited(child)) finish()
  })
}

interface ReadinessOptions {
  readonly fetch: PreviewFetcher
  readonly signal: AbortSignal
  readonly processExit: Promise<void>
  readonly processHasExited: () => boolean
  readonly timers: PreviewTimers
  readonly readinessTimeoutMs: number
  readonly pollIntervalMs: number
}

async function waitUntilReady(options: ReadinessOptions): Promise<void> {
  const timeout = createDelay(
    options.timers,
    options.readinessTimeoutMs,
    READINESS_TIMED_OUT,
  )

  try {
    while (true) {
      if (options.processHasExited()) {
        throw new Error('Managed preview exited before becoming ready.')
      }

      const probe = options.fetch(LOCAL_BASE_URL, {
        signal: options.signal,
      }).then(
        (response) => response.ok,
        () => false,
      )
      const probeResult = await Promise.race([
        options.processExit.then(() => PROCESS_ENDED),
        timeout.promise,
        probe,
      ])

      if (
        probeResult === PROCESS_ENDED ||
        options.processHasExited()
      ) {
        throw new Error('Managed preview exited before becoming ready.')
      }
      if (probeResult === READINESS_TIMED_OUT) {
        throw new Error(
          'Managed preview did not become ready before timeout.',
        )
      }
      if (probeResult) return

      const poll = createDelay(
        options.timers,
        options.pollIntervalMs,
        POLL_READY,
      )
      const pollResult = await Promise.race([
        options.processExit.then(() => PROCESS_ENDED),
        timeout.promise,
        poll.promise,
      ])
      poll.cancel()

      if (pollResult === PROCESS_ENDED) {
        throw new Error('Managed preview exited before becoming ready.')
      }
      if (pollResult === READINESS_TIMED_OUT) {
        throw new Error(
          'Managed preview did not become ready before timeout.',
        )
      }
    }
  } finally {
    timeout.cancel()
  }
}

function createDelay<T>(
  timers: PreviewTimers,
  delayMs: number,
  value: T,
): {
  readonly promise: Promise<T>
  cancel(): void
} {
  let timer: ReturnType<typeof setTimeout>
  const promise = new Promise<T>((resolve) => {
    timer = timers.setTimeout(() => resolve(value), delayMs)
  })
  return {
    promise,
    cancel: () => timers.clearTimeout(timer),
  }
}

async function exitsWithinGrace(
  child: PreviewProcess,
  processExit: Promise<void>,
  timers: PreviewTimers,
  graceMs: number,
): Promise<boolean> {
  if (hasExited(child)) return true

  const grace = createDelay(
    timers,
    graceMs,
    TERMINATION_GRACE_ENDED,
  )
  const result = await Promise.race([
    processExit.then(() => PROCESS_ENDED),
    grace.promise,
  ])
  grace.cancel()
  return result === PROCESS_ENDED || hasExited(child)
}
