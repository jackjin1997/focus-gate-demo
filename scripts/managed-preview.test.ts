// @vitest-environment node

import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  startManagedPreview,
  type PreviewFetcher,
} from './managed-preview'

class FakePreviewProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn((_signal: NodeJS.Signals) => true)

  exit(exitCode: number | null, signalCode: NodeJS.Signals | null): void {
    this.exitCode = exitCode
    this.signalCode = signalCode
    this.emit('exit', exitCode, signalCode)
  }
}

function createLocalFetch(readiness: PreviewFetcher) {
  let preflight = true
  return vi.fn<PreviewFetcher>((url, init) => {
    if (preflight) {
      preflight = false
      return Promise.reject(new Error('connection refused'))
    }
    return readiness(url, init)
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startManagedPreview', () => {
  it('reuses an external URL without spawning or stopping a process', async () => {
    const spawn = vi.fn(() => {
      throw new Error('external previews must not spawn')
    })
    const fetch = vi.fn(() => {
      throw new Error('external previews must not probe localhost')
    })

    const target = await startManagedPreview({
      externalUrl: 'https://focus-gate.example.test',
      fetch,
      spawn,
    })

    expect(target.baseUrl).toBe('https://focus-gate.example.test')
    expect(target.managed).toBe(false)
    await expect(target.stop()).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects an existing healthy local service without spawning Vite', async () => {
    const spawn = vi.fn(() => new FakePreviewProcess())

    const outcome = await startManagedPreview({
      fetch: vi.fn(async () => ({ ok: true })),
      spawn,
    }).catch((error: unknown) => error)

    expect(outcome).toEqual(
      expect.objectContaining({
        message: 'Managed preview port is already in use.',
      }),
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('aborts and fails closed when the local port probe hangs', async () => {
    vi.useFakeTimers()
    const spawn = vi.fn(() => new FakePreviewProcess())
    let preflightSignal: AbortSignal | undefined
    const fetch = vi.fn<PreviewFetcher>((_url, init) => {
      preflightSignal = init.signal
      return new Promise<{ ok: boolean }>(() => undefined)
    })

    const outcomePromise = startManagedPreview({
      fetch,
      spawn,
      preflightTimeoutMs: 20,
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(20)

    expect(preflightSignal?.aborted).toBe(true)
    await expect(outcomePromise).resolves.toEqual(
      expect.objectContaining({
        message: 'Managed preview port probe timed out.',
      }),
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('starts Vite with fixed argv and waits for an OK response', async () => {
    const child = new FakePreviewProcess()
    const spawn = vi.fn(() => child)
    const fetch = createLocalFetch(async () => ({ ok: true }))
    const cwd = '/workspace/focus-gate'

    const target = await startManagedPreview({ cwd, spawn, fetch })

    expect(spawn).toHaveBeenCalledWith(
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
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4173',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(target).toMatchObject({
      baseUrl: 'http://127.0.0.1:4173',
      managed: true,
    })

    const stopPromise = target.stop()
    child.exit(0, 'SIGTERM')
    await expect(stopPromise).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('fails with a fixed error when Vite exits before readiness', async () => {
    const child = new FakePreviewProcess()
    const fetch = createLocalFetch(
      () => new Promise<{ ok: boolean }>(() => undefined),
    )

    const targetPromise = startManagedPreview({
      spawn: vi.fn(() => child),
      fetch,
    })
    child.exit(1, null)

    await expect(targetPromise).rejects.toThrow(
      'Managed preview exited before becoming ready.',
    )
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('detects a process that already exited before listeners attach', async () => {
    const child = new FakePreviewProcess()
    child.exitCode = 1

    await expect(startManagedPreview({
      spawn: vi.fn(() => child),
      fetch: createLocalFetch(
        () => new Promise<{ ok: boolean }>(() => undefined),
      ),
    })).rejects.toThrow('Managed preview exited before becoming ready.')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('rejects an OK response when the spawned process is already exited', async () => {
    const child = new FakePreviewProcess()
    child.exitCode = 1

    const outcome = await startManagedPreview({
      spawn: vi.fn(() => child),
      fetch: createLocalFetch(async () => ({ ok: true })),
    }).catch((error: unknown) => error)

    expect(outcome).toEqual(
      expect.objectContaining({
        message: 'Managed preview exited before becoming ready.',
      }),
    )
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('rejects when the process exits as an OK response is observed', async () => {
    const child = new FakePreviewProcess()

    const outcome = await startManagedPreview({
      spawn: vi.fn(() => child),
      fetch: createLocalFetch(async () => ({
        get ok(): boolean {
          child.exit(1, null)
          return true
        },
      })),
    }).catch((error: unknown) => error)

    expect(outcome).toEqual(
      expect.objectContaining({
        message: 'Managed preview exited before becoming ready.',
      }),
    )
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('maps synchronous spawn failures to a fixed error', async () => {
    const secret = 'preview-secret-output'

    const outcome = await startManagedPreview({
      fetch: createLocalFetch(async () => ({ ok: true })),
      spawn: vi.fn(() => {
        throw new Error(secret)
      }),
    }).catch((error: unknown) => error)

    expect(outcome).toEqual(
      expect.objectContaining({
        message: 'Managed preview could not be started.',
      }),
    )
    expect(JSON.stringify(outcome)).not.toContain(secret)
  })

  it('times out after polling and cleans up the managed process', async () => {
    vi.useFakeTimers()
    const child = new FakePreviewProcess()
    child.kill.mockImplementation((signal) => {
      child.exit(null, signal)
      return true
    })
    const fetch = createLocalFetch(async () => ({ ok: false }))
    const timers = {
      setTimeout: vi.fn(
        (callback: () => void, delayMs: number) =>
          setTimeout(callback, delayMs),
      ),
      clearTimeout: vi.fn(
        (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
      ),
    }

    const targetPromise = startManagedPreview({
      spawn: vi.fn(() => child),
      fetch,
      timers,
      readinessTimeoutMs: 50,
      pollIntervalMs: 10,
    })
    const outcomePromise = targetPromise.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)

    await expect(outcomePromise).resolves.toEqual(
      expect.objectContaining({
        message: 'Managed preview did not become ready before timeout.',
      }),
    )
    expect(fetch.mock.calls.length).toBeGreaterThan(1)
    expect(timers.setTimeout).toHaveBeenCalled()
    expect(timers.clearTimeout).toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('stops idempotently and escalates to SIGKILL after the grace period', async () => {
    vi.useFakeTimers()
    const child = new FakePreviewProcess()
    const target = await startManagedPreview({
      spawn: vi.fn(() => child),
      fetch: createLocalFetch(async () => ({ ok: true })),
      terminationGraceMs: 20,
    })

    const firstStop = target.stop()
    const secondStop = target.stop()
    expect(firstStop).toBe(secondStop)
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')

    await vi.advanceTimersByTimeAsync(20)
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    child.exit(null, 'SIGKILL')

    await expect(firstStop).resolves.toBeUndefined()
    await expect(target.stop()).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledTimes(2)
  })

  it('fails with a fixed error when SIGKILL cannot stop the process', async () => {
    vi.useFakeTimers()
    const child = new FakePreviewProcess()
    const target = await startManagedPreview({
      spawn: vi.fn(() => child),
      fetch: createLocalFetch(async () => ({ ok: true })),
      terminationGraceMs: 20,
    })

    const outcomePromise = target.stop().catch(
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(40)

    await expect(outcomePromise).resolves.toEqual(
      expect.objectContaining({
        message: 'Managed preview could not be stopped.',
      }),
    )
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('maps termination signal failures to a fixed error', async () => {
    const secret = 'vite-secret-process-details'
    const child = new FakePreviewProcess()
    child.kill.mockImplementation(() => {
      throw new Error(secret)
    })
    const target = await startManagedPreview({
      spawn: vi.fn(() => child),
      fetch: createLocalFetch(async () => ({ ok: true })),
    })

    const outcome = await target.stop().catch(
      (error: unknown) => error,
    )

    expect(outcome).toEqual(
      expect.objectContaining({
        message: 'Managed preview could not be stopped.',
      }),
    )
    expect(JSON.stringify(outcome)).not.toContain(secret)
  })

  it('reports a fixed cleanup error when readiness and stopping both fail', async () => {
    vi.useFakeTimers()
    const child = new FakePreviewProcess()

    const outcomePromise = startManagedPreview({
      spawn: vi.fn(() => child),
      fetch: createLocalFetch(async () => ({ ok: false })),
      readinessTimeoutMs: 10,
      terminationGraceMs: 5,
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(20)
    const outcome = await outcomePromise

    expect(outcome).toEqual(
      expect.objectContaining({
        message: 'Managed preview could not be stopped.',
      }),
    )
    expect(child.kill).toHaveBeenCalledTimes(2)
  })
})
