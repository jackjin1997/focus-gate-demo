import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FocusGateApplication } from './application/focus-gate-application'
import { HumanPresenceApplication } from './application/human-presence-application'
import { ExclusiveLoopbackRuntime } from './exclusive-loopback-runtime'
import { createFocusGateApi } from './http/focus-gate-api'
import {
  LarkCliAdapter,
  NodeCommandRunner,
  type SafeLarkCliLogEvent,
} from './infrastructure/lark-cli'
import { FocusGateStore } from './infrastructure/sqlite/focus-gate-store'
import { SqliteHumanPresenceRepository } from './infrastructure/sqlite/sqlite-human-presence-repository'
import { createRuntimeApp } from './runtime-app'
import { HumanPresenceService } from './security/human-presence'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(currentDirectory, '..')
const port = 4317
const hostname = '127.0.0.1'
const dataDirectory = process.env.FOCUS_GATE_DATA_DIR
  ?? join(homedir(), 'Library', 'Application Support', 'Focus Gate')
const databasePath = join(dataDirectory, 'focus-gate.sqlite')
const larkCliPath = process.env.LARK_CLI_PATH ?? '/opt/homebrew/bin/lark-cli'

const runtime = new ExclusiveLoopbackRuntime({
  hostname,
  onRuntimeError: (error) => {
    console.error(JSON.stringify({ component: 'runtime', code: safeErrorCode(error) }))
    process.exitCode = 1
  },
})
let store: FocusGateStore | null = null
let humanPresenceRepository: SqliteHumanPresenceRepository | null = null

async function shutdown() {
  await runtime.shutdown()
}

process.once('SIGINT', () => void shutdown().catch(reportShutdownFailure))
process.once('SIGTERM', () => void shutdown().catch(reportShutdownFailure))

async function main() {
  try {
    let recovery = { interruptedRuns: 0, orphanedPlans: 0 }
    const address = await runtime.start({
      port,
      closeResources,
      initialize: () => {
        store = new FocusGateStore(databasePath)
        recovery = store.recoverInterruptedReads(new Date().toISOString())
        humanPresenceRepository = new SqliteHumanPresenceRepository(databasePath)
        const runner = new NodeCommandRunner({
          executablePath: larkCliPath,
          requireProfilePin: true,
        })
        const lark = new LarkCliAdapter({
          runner,
          pinProfile: () => runner.pinActiveProfile(),
          logger: { log: (event: SafeLarkCliLogEvent) => console.info(JSON.stringify(event)) },
        })
        const application = new FocusGateApplication({ store, lark })
        const humanPresence = new HumanPresenceApplication({
          repository: humanPresenceRepository,
          service: new HumanPresenceService({ repository: humanPresenceRepository }),
        })
        const api = createFocusGateApi({ application, humanPresence })
        const app = createRuntimeApp({ api, staticRoot: join(projectRoot, 'dist') })
        return app.fetch
      },
    })

    console.info(`专注之门本机模式已启动：http://localhost:${address.port}`)
    console.info('当前不会读取飞书；请在界面中主动开始能力研究。')
    if (recovery.interruptedRuns > 0 || recovery.orphanedPlans > 0) {
      console.info(JSON.stringify({ component: 'read-recovery', ...recovery }))
    }
  } catch (error) {
    const code = safeErrorCode(error) === 'EADDRINUSE'
      ? 'FOCUS_GATE_ALREADY_RUNNING'
      : safeErrorCode(error)
    console.error(JSON.stringify({ component: 'startup', code }))
    await shutdown()
    process.exitCode = 1
  }
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
  ) {
    return error.code
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)) {
    return error.message
  }
  return 'RUNTIME_FAILURE'
}

function closeResources() {
  const errors: unknown[] = []
  try {
    humanPresenceRepository?.close()
  } catch (error) {
    errors.push(error)
  } finally {
    humanPresenceRepository = null
  }
  try {
    store?.close()
  } catch (error) {
    errors.push(error)
  } finally {
    store = null
  }
  if (errors.length > 0) {
    process.exitCode = 1
    for (const error of errors) reportShutdownFailure(error)
  }
}

function reportShutdownFailure(error: unknown) {
  console.error(JSON.stringify({ component: 'shutdown', code: safeErrorCode(error) }))
  process.exitCode = 1
}

void main().catch(reportShutdownFailure)
