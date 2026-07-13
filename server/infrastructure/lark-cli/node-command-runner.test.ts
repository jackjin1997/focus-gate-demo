import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NodeCommandRunner,
  NodeCommandRunnerError,
  type CommandInvocation,
  type SpawnProcess,
} from './index'

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => true)
}

const invocation: CommandInvocation = {
  executable: 'lark-cli',
  args: ['auth', 'status'],
  options: { shell: false },
}

afterEach(() => {
  vi.useRealTimers()
})

describe('NodeCommandRunner', () => {
  it('pins the active CLI profile before allowing protected commands', async () => {
    const discoveryChild = new FakeChildProcess()
    const commandChild = new FakeChildProcess()
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => discoveryChild)
      .mockImplementationOnce(() => commandChild) as unknown as SpawnProcess
    const runner = new NodeCommandRunner({
      spawn,
      requireProfilePin: true,
      timeoutMs: 1_000,
    })

    await expect(runner.run(invocation)).rejects.toMatchObject({
      code: 'PROFILE_NOT_PINNED',
    })
    expect(spawn).not.toHaveBeenCalled()

    const pinPromise = runner.pinActiveProfile()
    discoveryChild.stdout.write(JSON.stringify([
      { name: 'focus-profile', active: true },
      { name: 'other-profile', active: false },
    ]))
    discoveryChild.emit('close', 0, null)
    await expect(pinPromise).resolves.toBe('focus-profile')

    const commandPromise = runner.run(invocation)
    commandChild.stdout.write('{"identity":"user"}')
    commandChild.emit('close', 0, null)
    await expect(commandPromise).resolves.toMatchObject({ exitCode: 0 })

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      'lark-cli',
      ['profile', 'list'],
      expect.objectContaining({ shell: false }),
    )
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      'lark-cli',
      ['--profile', 'focus-profile', 'auth', 'status'],
      expect.objectContaining({ shell: false }),
    )
  })

  it('spawns an argv array with shell disabled and captures bounded output', async () => {
    const child = new FakeChildProcess()
    const spawn = vi.fn(() => child) as unknown as SpawnProcess
    const runner = new NodeCommandRunner({
      spawn,
      timeoutMs: 1_000,
      env: {
        PATH: '/opt/homebrew/bin',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        http_proxy: 'http://127.0.0.1:7890',
        KEEP_ME: 'yes',
        LARK_CLI_NO_PROXY: '0',
      },
    })

    const resultPromise = runner.run(invocation)
    child.stdout.write('{"identity":"user"}')
    child.stderr.write('read-only warning')
    child.emit('close', 0, null)

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      stdout: '{"identity":"user"}',
      stderr: 'read-only warning',
    })
    expect(spawn).toHaveBeenCalledWith('lark-cli', ['auth', 'status'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        PATH: '/opt/homebrew/bin',
        KEEP_ME: 'yes',
        LARK_CLI_NO_PROXY: '1',
      },
    })
  })

  it('sends SIGTERM on timeout and returns a fixed error without process output', async () => {
    vi.useFakeTimers()
    const secret = 't-u-secret-token'
    const child = new FakeChildProcess()
    const spawn = vi.fn(() => child) as unknown as SpawnProcess
    const runner = new NodeCommandRunner({
      spawn,
      timeoutMs: 50,
      terminationGraceMs: 25,
    })

    const resultPromise = runner.run(invocation)
    const assertion = expect(resultPromise).rejects.toMatchObject({
      name: 'NodeCommandRunnerError',
      code: 'TIMED_OUT',
      message: 'The lark-cli process timed out.',
    })
    child.stderr.write(secret)
    await vi.advanceTimersByTimeAsync(50)

    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', null, 'SIGTERM')
    await assertion

    const error = await resultPromise.catch((reason: unknown) => reason)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('sends SIGTERM as soon as the combined output limit is exceeded', async () => {
    const child = new FakeChildProcess()
    const spawn = vi.fn(() => child) as unknown as SpawnProcess
    const runner = new NodeCommandRunner({
      spawn,
      maxOutputBytes: 8,
      timeoutMs: 1_000,
    })

    const resultPromise = runner.run(invocation)
    const assertion = expect(resultPromise).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT_EXCEEDED',
      message: 'The lark-cli process exceeded the output limit.',
    })
    child.stdout.write('123456789')

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', null, 'SIGTERM')
    await assertion
  })

  it('uses the grace timer if a terminated process does not close', async () => {
    vi.useFakeTimers()
    const child = new FakeChildProcess()
    const spawn = vi.fn(() => child) as unknown as SpawnProcess
    const runner = new NodeCommandRunner({
      spawn,
      timeoutMs: 40,
      terminationGraceMs: 20,
    })

    const resultPromise = runner.run(invocation)
    const assertion = expect(resultPromise).rejects.toMatchObject({
      code: 'TIMED_OUT',
    })
    await vi.advanceTimersByTimeAsync(60)

    await assertion
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('maps spawn errors to a serializable error with no cause details', async () => {
    const child = new FakeChildProcess()
    const spawn = vi.fn(() => child) as unknown as SpawnProcess
    const runner = new NodeCommandRunner({ spawn })

    const resultPromise = runner.run(invocation)
    const assertion = expect(resultPromise).rejects.toEqual(
      expect.objectContaining({
        code: 'SPAWN_FAILED',
        message: 'The lark-cli process could not be started.',
      }),
    )
    child.emit(
      'error',
      Object.assign(new Error('ENOENT token=t-u-secret'), { code: 'ENOENT' }),
    )
    await assertion
  })

  it('serializes only approved runner diagnostics', () => {
    const error = new NodeCommandRunnerError('OUTPUT_LIMIT_EXCEEDED')

    expect(error.toJSON()).toEqual({
      name: 'NodeCommandRunnerError',
      code: 'OUTPUT_LIMIT_EXCEEDED',
      message: 'The lark-cli process exceeded the output limit.',
    })
  })
})
