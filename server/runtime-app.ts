import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'

export function createRuntimeApp(input: { api: Hono; staticRoot: string }) {
  const app = new Hono()
  app.use('*', async (context, next) => {
    const url = new URL(context.req.url)
    if (url.hostname === '127.0.0.1' && !url.pathname.startsWith('/api/')) {
      const canonical = new URL(`${url.pathname}${url.search}`, 'http://localhost:4317')
      return context.redirect(canonical.toString(), 307)
    }
    await next()
  })
  app.route('/', input.api)
  app.all('/api/*', (context) => context.json({ code: 'NOT_FOUND' }, 404))
  app.use('/assets/*', serveStatic({ root: input.staticRoot }))
  app.get('*', serveStatic({ path: join(input.staticRoot, 'index.html') }))
  return app
}
