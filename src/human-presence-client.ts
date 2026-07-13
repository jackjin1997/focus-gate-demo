import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'

export interface ReadRunResult {
  runId: string
  status: string
  itemCount: number
  coverage: string
  rawDeleted: boolean
  rawPersisted?: boolean
}

export function supportsHumanPresence() {
  return browserSupportsWebAuthn()
}

export async function registerHumanPresence() {
  if (!supportsHumanPresence()) throw new Error('WEBAUTHN_UNAVAILABLE')

  const options = await postJson<PublicKeyCredentialCreationOptionsJSON>(
    '/api/human-presence/registration/options',
    {},
  )
  const credential = await startRegistration({ optionsJSON: options })
  const verification = await postJson<{ verified: boolean }>(
    '/api/human-presence/registration/verify',
    { credential },
  )

  if (!verification.verified) throw new Error('HUMAN_PRESENCE_REGISTRATION_FAILED')
  return verification
}

export async function authenticateReadPlan(input: {
  planId: string
  digest: string
  approvalNonce: string
}): Promise<ReadRunResult> {
  if (!supportsHumanPresence()) throw new Error('WEBAUTHN_UNAVAILABLE')

  const planPath = `/api/read-plans/${encodeURIComponent(input.planId)}`
  const options = await postJson<PublicKeyCredentialRequestOptionsJSON>(
    `${planPath}/presence/options`,
    {},
  )
  const presenceCredential = await startAuthentication({ optionsJSON: options })

  return postJson<ReadRunResult>(`${planPath}/approve`, {
    digest: input.digest,
    approvalNonce: input.approvalNonce,
    presenceCredential,
  })
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: string } | null
    throw new Error(payload?.code ?? `REQUEST_FAILED_${response.status}`)
  }
  return response.json() as Promise<T>
}
