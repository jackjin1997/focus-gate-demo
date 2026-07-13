import { Hono } from 'hono'
import { z } from 'zod'
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { FocusGateApplication } from '../application/focus-gate-application'
import { HumanPresenceApplication } from '../application/human-presence-application'
import { HumanPresenceError } from '../security/human-presence'

const readPlanRequest = z.object({
  lookbackMinutes: z.literal(10),
  source: z.literal('all-visible'),
  includeAttachments: z.literal(false),
  retention: z.literal('delete-raw-on-digest'),
}).strict()

const approvalRequest = z.object({
  digest: z.string().min(1),
  approvalNonce: z.string().min(20),
  presenceCredential: z.record(z.string(), z.unknown()),
}).strict()

const emptyRequest = z.object({}).strict()
const credentialRequest = z.object({
  credential: z.record(z.string(), z.unknown()),
}).strict()

const canonicalPresenceOrigin = 'http://localhost:4317'

const defaultAllowedOrigins = new Set([
  'http://127.0.0.1:4317',
  'http://localhost:4317',
])

export function createFocusGateApi(input: {
  application: FocusGateApplication
  humanPresence: HumanPresenceApplication
  allowedOrigins?: ReadonlySet<string>
}) {
  const app = new Hono()
  const allowedOrigins = input.allowedOrigins ?? defaultAllowedOrigins

  app.use('/api/*', async (context, next) => {
    if (context.req.method === 'GET' || context.req.method === 'HEAD') {
      await next()
      return
    }

    const origin = context.req.header('Origin')
    if (!origin || !allowedOrigins.has(origin)) {
      return context.json({ code: 'UNTRUSTED_ORIGIN' }, 403)
    }
    if (requiresHumanPresenceOrigin(context.req.path) && origin !== canonicalPresenceOrigin) {
      return context.json({ code: 'CANONICAL_ORIGIN_REQUIRED' }, 403)
    }
    await next()
  })

  app.get('/api/health', (context) =>
    context.json({ status: 'ready', mode: 'local-real', writesEnabled: false }),
  )

  app.post('/api/capability-reviews', async (context) => {
    try {
      const review = await input.application.createCapabilityReview()
      return context.json({
        ...review,
        humanPresence: await input.humanPresence.status(),
      })
    } catch (error) {
      return apiError(context, error)
    }
  })

  app.post('/api/human-presence/registration/options', async (context) => {
    const parsed = emptyRequest.safeParse(await safeJson(context.req.raw))
    if (!parsed.success) return context.json({ code: 'INVALID_PRESENCE_REQUEST' }, 400)
    try {
      return context.json(await input.humanPresence.registrationOptions())
    } catch (error) {
      return apiError(context, error)
    }
  })

  app.post('/api/human-presence/registration/verify', async (context) => {
    const parsed = credentialRequest.safeParse(await safeJson(context.req.raw))
    if (!parsed.success) return context.json({ code: 'INVALID_PRESENCE_REQUEST' }, 400)
    try {
      return context.json(await input.humanPresence.verifyRegistration(
        parsed.data.credential as unknown as RegistrationResponseJSON,
      ))
    } catch (error) {
      return apiError(context, error)
    }
  })

  app.post('/api/read-plans', async (context) => {
    const parsed = readPlanRequest.safeParse(await safeJson(context.req.raw))
    if (!parsed.success) return context.json({ code: 'INVALID_READ_PLAN_REQUEST' }, 400)
    return context.json(input.application.previewReadPlan())
  })

  app.post('/api/read-plans/:planId/presence/options', async (context) => {
    const parsed = emptyRequest.safeParse(await safeJson(context.req.raw))
    if (!parsed.success) return context.json({ code: 'INVALID_PRESENCE_REQUEST' }, 400)
    try {
      const binding = input.application.inspectReadPlanBinding({
        planId: context.req.param('planId'),
      })
      return context.json(await input.humanPresence.planAuthenticationOptions(binding))
    } catch (error) {
      return apiError(context, error)
    }
  })

  app.post('/api/read-plans/:planId/approve', async (context) => {
    const parsed = approvalRequest.safeParse(await safeJson(context.req.raw))
    if (!parsed.success) return context.json({ code: 'INVALID_APPROVAL_REQUEST' }, 400)
    try {
      const binding = input.application.inspectReadPlanBinding({
        planId: context.req.param('planId'),
        digest: parsed.data.digest,
      })
      await input.humanPresence.verifyPlanAuthentication(
        binding,
        parsed.data.presenceCredential as unknown as AuthenticationResponseJSON,
      )
      const result = await input.application.approveReadPlan({
        planId: context.req.param('planId'),
        digest: parsed.data.digest,
        approvalNonce: parsed.data.approvalNonce,
      })
      return context.json(result)
    } catch (error) {
      return apiError(context, error)
    }
  })

  return app
}

function requiresHumanPresenceOrigin(path: string) {
  return path.startsWith('/api/human-presence/') ||
    path.endsWith('/presence/options') ||
    path.endsWith('/approve')
}

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function apiError(context: { json: (body: unknown, status: 400 | 409 | 428 | 500) => Response }, error: unknown) {
  const code = error instanceof Error ? error.message : 'INTERNAL_ERROR'
  if (
    code === 'FEISHU_USER_AUTH_REQUIRED' ||
    code === 'READ_PLAN_IDENTITY_UNBOUND' ||
    code === 'HUMAN_PRESENCE_NOT_REGISTERED'
  ) {
    return context.json({ code }, 428)
  }
  if (
    code === 'READ_PLAN_MISMATCH' ||
    code === 'READ_PLAN_ALREADY_CLAIMED' ||
    code === 'READ_PLAN_IDENTITY_CHANGED' ||
    code === 'HUMAN_PRESENCE_ALREADY_REGISTERED'
  ) {
    return context.json({ code }, 409)
  }
  if (code === 'READ_PLAN_EXPIRED' || code === 'READ_PLAN_NOT_FOUND') {
    return context.json({ code }, 400)
  }
  if (error instanceof HumanPresenceError) {
    return context.json({ code: error.code }, 400)
  }
  return context.json({ code: 'INTERNAL_ERROR' }, 500)
}
