// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExclusiveLoopbackRuntime } from './exclusive-loopback-runtime'
import { FocusGateStore } from './infrastructure/sqlite/focus-gate-store'

const hostname = '127.0.0.1'
const temporaryDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('ExclusiveLoopbackRuntime', () => {
  it('does not initialize or recover persistence when another instance owns the socket', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'focus-gate-runtime-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'focus-gate.sqlite')
    const initialStore = new FocusGateStore(databasePath)
    initialStore.createReadRun({
      id: 'run-active',
      planId: 'plan-active',
      startedAt: '2026-07-12T10:01:00.000Z',
    })
    initialStore.close()

    const owner = createServer()
    servers.push(owner)
    const port = await listenOnAvailablePort(owner)
    const initialize = vi.fn(() => {
      const store = new FocusGateStore(databasePath)
      store.recoverInterruptedReads('2026-07-12T10:02:00.000Z')
      return () => new Response('ready')
    })
    const loser = new ExclusiveLoopbackRuntime({ hostname })

    await expect(loser.start({
      port,
      initialize,
      closeResources: () => {},
    })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    })
    expect(initialize).not.toHaveBeenCalled()

    const untouchedStore = new FocusGateStore(databasePath)
    expect(untouchedStore.getReadRun('run-active')).toEqual({
      id: 'run-active',
      planId: 'plan-active',
      status: 'running',
      startedAt: '2026-07-12T10:01:00.000Z',
      completedAt: null,
      failureCode: null,
    })
    untouchedStore.close()

    await closeServer(owner)
    servers.splice(servers.indexOf(owner), 1)

    const persistence: { store?: FocusGateStore } = {}
    const winner = new ExclusiveLoopbackRuntime({ hostname })
    await winner.start({
      port,
      closeResources: () => persistence.store?.close(),
      initialize: () => {
        persistence.store = new FocusGateStore(databasePath)
        expect(persistence.store.recoverInterruptedReads('2026-07-12T10:02:00.000Z'))
          .toEqual({ interruptedRuns: 1, orphanedPlans: 0 })
        return () => new Response('ready')
      },
    })
    expect(persistence.store?.getReadRun('run-active')).toMatchObject({
      status: 'failed',
      failureCode: 'PROCESS_INTERRUPTED_RESULT_UNKNOWN',
    })
    await winner.shutdown()
  })

  it('keeps ownership until an in-flight request drains and resources close', async () => {
    let finishRequest: (() => void) | undefined
    const requestGate = new Promise<void>((resolve) => {
      finishRequest = resolve
    })
    const events: string[] = []
    const runtime = new ExclusiveLoopbackRuntime({ hostname })
    const address = await runtime.start({
      port: 0,
      closeResources: () => {
        events.push('resources:closed')
      },
      initialize: () => async () => {
        events.push('request:start')
        await requestGate
        events.push('request:end')
        return new Response('ready')
      },
    })
    const request = fetch(`http://${hostname}:${address.port}`)
    await vi.waitFor(() => expect(events).toContain('request:start'))

    const shutdown = runtime.shutdown()
    const competitor = createServer()
    servers.push(competitor)
    await expect(listen(competitor, address.port)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    })
    expect(events).not.toContain('resources:closed')

    finishRequest?.()
    await expect(request).resolves.toMatchObject({ status: 200 })
    await shutdown
    expect(events).toEqual(['request:start', 'request:end', 'resources:closed'])

    await listen(competitor, address.port)
  })

  it('closes resources and releases ownership when initialization fails', async () => {
    const events: string[] = []
    let ownedPort: number | undefined
    const runtime = new ExclusiveLoopbackRuntime({ hostname })

    await expect(runtime.start({
      port: 0,
      initialize: () => {
        ownedPort = (runtime.server.address() as AddressInfo).port
        events.push('initialize')
        throw new Error('INITIALIZATION_FAILED')
      },
      closeResources: () => {
        events.push('resources:closed')
      },
    })).rejects.toThrow('INITIALIZATION_FAILED')
    expect(events).toEqual(['initialize', 'resources:closed'])

    const competitor = createServer()
    servers.push(competitor)
    expect(ownedPort).toBeTypeOf('number')
    await listen(competitor, ownedPort!)
  })

  it('fails closed when the owned listener emits a runtime error', async () => {
    const events: string[] = []
    let runtime!: ExclusiveLoopbackRuntime
    runtime = new ExclusiveLoopbackRuntime({
      hostname,
      onRuntimeError: () => events.push('runtime:error'),
    })
    const address = await runtime.start({
      port: 0,
      initialize: () => () => new Response('ready'),
      closeResources: () => {
        events.push('resources:closed')
      },
    })

    runtime.server.emit('error', Object.assign(new Error('listener failed'), {
      code: 'EIO',
    }))
    await runtime.shutdown()
    expect(events).toEqual(['runtime:error', 'resources:closed'])

    const competitor = createServer()
    servers.push(competitor)
    await listen(competitor, address.port)
  })

  it('serializes shutdown that begins between listen and initialization', async () => {
    let releaseCleanup: (() => void) | undefined
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const events: string[] = []
    const initialize = vi.fn(() => () => new Response('ready'))
    const runtime = new ExclusiveLoopbackRuntime({ hostname })
    const closeSpy = vi.spyOn(runtime.server, 'close')
    let ownedPort: number | undefined
    let shutdown: Promise<void> | undefined
    runtime.server.once('listening', () => {
      ownedPort = (runtime.server.address() as AddressInfo).port
      shutdown = runtime.shutdown()
    })

    const start = runtime.start({
      port: 0,
      initialize,
      closeResources: async () => {
        events.push('resources:closing')
        await cleanupGate
        events.push('resources:closed')
      },
    })
    await vi.waitFor(() => expect(events).toContain('resources:closing'))

    const competitor = createServer()
    servers.push(competitor)
    expect(ownedPort).toBeTypeOf('number')
    await expect(listen(competitor, ownedPort!)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    })
    expect(closeSpy).not.toHaveBeenCalled()

    releaseCleanup?.()
    await expect(start).rejects.toThrow('RUNTIME_START_ABORTED')
    await shutdown
    expect(initialize).not.toHaveBeenCalled()
    expect(events).toEqual(['resources:closing', 'resources:closed'])
    expect(closeSpy).toHaveBeenCalledTimes(1)
    await listen(competitor, ownedPort!)
  })
})

function listenOnAvailablePort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: hostname, port: 0, exclusive: true }, () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: hostname, port, exclusive: true })
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
