// @vitest-environment node

import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { startManagedPreview } from './managed-preview'

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

afterEach(() => {
  vi.useRealTimers()
})

describe('startManagedPreview', () => {
  it('reuses an external URL without spawning or stopping a process', async () => {
    const spawn = vi.fn(() => {
      throw new Error('external previews must not spawn')
    })

    const target = await startManagedPreview({
      externalUrl: 'https://focus-gate.example.test',
      spawn,
    })

    expect(target.baseUrl).toBe('https://focus-gate.example.test')
    expect(target.managed).toBe(false)
    await expect(target.stop()).resolves.toBeUndefined()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('starts Vite with fixed argv and waits for an OK response', async () => {
    const child = new FakePreviewProcess()
    const spawn = vi.fn(() => child)
    const fetch = vi.fn(async () => ({ ok: true }))
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
    const fetch = vi.fn(
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
      fetch: vi.fn(
        () => new Promise<{ ok: boolean }>(() => undefined),
      ),
    })).rejects.toThrow('Managed preview exited before becoming ready.')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('maps synchronous spawn failures to a fixed error', async () => {
    const secret = 'preview-secret-output'

    const outcome = await startManagedPreview({
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
    const fetch = vi.fn(async () => ({ ok: false }))
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
      fetch: vi.fn(async () => ({ ok: true })),
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
})
