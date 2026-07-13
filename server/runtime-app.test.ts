// @vitest-environment node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeApp } from './runtime-app'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('createRuntimeApp', () => {
  it('serves the local real UI and keeps API routes on the same origin', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'focus-gate-static-'))
    directories.push(directory)
    mkdirSync(join(directory, 'assets'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>专注之门</title>')
    writeFileSync(join(directory, 'assets', 'app.js'), 'console.log("focus")')
    const api = new Hono().get('/api/health', (context) => context.json({ status: 'ready' }))
    const app = createRuntimeApp({ api, staticRoot: directory })

    const health = await app.request('/api/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ready' })

    const index = await app.request('/')
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('<title>专注之门</title>')

    const asset = await app.request('/assets/app.js')
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('focus')

    const loopbackIp = await app.request('http://127.0.0.1:4317/')
    expect(loopbackIp.status).toBe(307)
    expect(loopbackIp.headers.get('location')).toBe('http://localhost:4317/')
  })

  it('does not turn an unknown API route into the HTML application', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'focus-gate-static-'))
    directories.push(directory)
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>专注之门</title>')
    const app = createRuntimeApp({ api: new Hono(), staticRoot: directory })

    const response = await app.request('/api/unknown')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})
