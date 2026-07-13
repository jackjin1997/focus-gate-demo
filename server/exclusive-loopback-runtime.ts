import type { AddressInfo } from 'node:net'
import { createAdaptorServer } from '@hono/node-server'

type AdaptorOptions = Parameters<typeof createAdaptorServer>[0]
type FetchCallback = AdaptorOptions['fetch']

type RuntimePhase = 'starting' | 'ready' | 'draining' | 'closed'

interface ExclusiveLoopbackRuntimeOptions {
  hostname: string
  onRuntimeError?: (error: unknown) => void
}

interface StartOptions {
  port: number
  initialize: () => FetchCallback
  closeResources: () => void | Promise<void>
}

export class ExclusiveLoopbackRuntime {
  readonly server

  private readonly hostname: string
  private readonly onRuntimeError?: (error: unknown) => void
  private activeFetch: FetchCallback | null = null
  private acquisitionReject: ((error: unknown) => void) | null = null
  private phase: RuntimePhase = 'starting'
  private inFlight = 0
  private drainWaiters = new Set<() => void>()
  private ownsListener = false
  private startAttempted = false
  private closeResources: () => void | Promise<void> = () => {}
  private shutdownPromise: Promise<void> | null = null

  constructor(options: ExclusiveLoopbackRuntimeOptions) {
    this.hostname = options.hostname
    this.onRuntimeError = options.onRuntimeError
    this.server = createAdaptorServer({
      hostname: this.hostname,
      fetch: (request, env) => this.dispatch(request, env),
    })
    this.server.on('error', (error) => {
      if (this.acquisitionReject) {
        const reject = this.acquisitionReject
        this.acquisitionReject = null
        reject(error)
        return
      }
      this.onRuntimeError?.(error)
      void this.shutdown().catch((shutdownError) => {
        this.onRuntimeError?.(shutdownError)
      })
    })
  }

  async start(options: StartOptions): Promise<AddressInfo> {
    if (this.startAttempted) throw new Error('RUNTIME_START_ALREADY_ATTEMPTED')
    this.startAttempted = true
    this.closeResources = options.closeResources

    let address: AddressInfo
    try {
      address = await new Promise<AddressInfo>((resolve, reject) => {
        this.acquisitionReject = reject
        try {
          this.server.listen(
            { host: this.hostname, port: options.port, exclusive: true },
            () => {
              this.acquisitionReject = null
              this.ownsListener = true
              const serverAddress = this.server.address()
              if (!serverAddress || typeof serverAddress === 'string') {
                reject(new Error('RUNTIME_ADDRESS_UNAVAILABLE'))
                return
              }
              resolve(serverAddress)
            },
          )
        } catch (error) {
          this.acquisitionReject = null
          reject(error)
        }
      })
    } catch (error) {
      await this.shutdown()
      throw error
    }

    if (this.phase !== 'starting') {
      await this.shutdown()
      await this.releaseOwnership()
      throw new Error('RUNTIME_START_ABORTED')
    }

    // Initialization is deliberately after the kernel grants the listening socket.
    try {
      this.activeFetch = options.initialize()
      this.phase = 'ready'
      return address
    } catch (error) {
      await this.shutdown()
      throw error
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown()
    return this.shutdownPromise
  }

  private async performShutdown(): Promise<void> {
    await this.beginDrain()
    try {
      await this.closeResources()
    } finally {
      await this.releaseOwnership()
    }
  }

  private async dispatch(
    request: Parameters<FetchCallback>[0],
    env: Parameters<FetchCallback>[1],
  ) {
    const target = this.activeFetch
    if (this.phase !== 'ready' || !target) {
      return new Response(JSON.stringify({ code: 'RUNTIME_UNAVAILABLE' }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Retry-After': '1',
        },
      })
    }

    this.inFlight += 1
    try {
      return await target(request, env)
    } finally {
      this.inFlight -= 1
      if (this.inFlight === 0) {
        for (const resolve of this.drainWaiters) resolve()
        this.drainWaiters.clear()
      }
    }
  }

  private async beginDrain(): Promise<void> {
    if (this.phase === 'closed') return
    this.phase = 'draining'
    this.activeFetch = null
    if (this.inFlight === 0) return
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve))
  }

  private async releaseOwnership(): Promise<void> {
    if (!this.ownsListener) {
      this.phase = 'closed'
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    this.ownsListener = false
    this.phase = 'closed'
  }
}
