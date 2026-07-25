import { LarkCliAdapterError } from './errors'
import type {
  CapabilityReview,
  LarkCliOperation,
  StandardLarkMessage,
  StandardMessageChat,
  StandardMessageIdentity,
  StandardMessageMention,
} from './types'

type JsonRecord = Record<string, unknown>

export const parseCapabilityReview = (outputs: {
  readonly version: string
  readonly authStatus: string
  readonly scopes: string
  readonly events: string
}): CapabilityReview => {
  const authStatus = parseJsonRecord(
    outputs.authStatus,
    'capabilities.auth-status',
  )
  const scopeEnvelope = parseJsonRecord(outputs.scopes, 'capabilities.scopes')
  const eventEnvelope = parseJson(outputs.events, 'capabilities.events')
  const rootIdentity = normalizeIdentity(authStatus.identity)
  const identities = isRecord(authStatus.identities)
    ? authStatus.identities
    : null

  if (
    !identities &&
    !Object.prototype.hasOwnProperty.call(authStatus, 'identity')
  ) {
    throw invalidCapabilityResponse('capabilities.auth-status')
  }

  const appScopes = normalizeAppScopes(scopeEnvelope)
  const normalizedIdentity = identities
    ? normalizeCurrentIdentity(rootIdentity, identities)
    : normalizeLegacyIdentity(rootIdentity, authStatus)
  const scopes = normalizedIdentity.currentContract
    ? normalizedIdentity.authenticated
      ? intersectScopes(normalizedIdentity.tokenScopes, appScopes)
      : []
    : appScopes

  return {
    cliVersion: extractVersion(outputs.version),
    authenticated: normalizedIdentity.authenticated,
    identity: normalizedIdentity.identity,
    userOpenId: normalizedIdentity.userOpenId,
    scopes: Object.freeze(scopes),
    eventKeys: Object.freeze(extractEventKeys(eventEnvelope).sort()),
  }
}

export const parseMessages = (stdout: string): readonly StandardLarkMessage[] => {
  const payload = parseJson(stdout, 'messages.search')

  if (isTruncated(payload)) {
    throw new LarkCliAdapterError({
      code: 'INCOMPLETE_RESULT',
      operation: 'messages.search',
      retryable: true,
    })
  }

  const items = extractMessageItems(payload)

  return Object.freeze(items.map(normalizeMessage))
}

const isTruncated = (payload: unknown): boolean => {
  if (!isRecord(payload)) {
    return false
  }

  const envelope = isRecord(payload.data) ? payload.data : payload
  return envelope.has_more === true || envelope.hasMore === true
}

const parseJson = (raw: string, operation: LarkCliOperation): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    throw new LarkCliAdapterError({
      code: 'INVALID_RESPONSE',
      operation,
      retryable: false,
    })
  }
}

const parseJsonRecord = (raw: string, operation: LarkCliOperation): JsonRecord => {
  const value = parseJson(raw, operation)

  if (!isRecord(value)) {
    throw new LarkCliAdapterError({
      code: 'INVALID_RESPONSE',
      operation,
      retryable: false,
    })
  }

  return value
}

const extractVersion = (raw: string): string | null => {
  const match = raw.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)
  return match?.[1] ?? null
}

const normalizeIdentity = (
  value: unknown,
): CapabilityReview['identity'] => {
  if (value === 'user' || value === 'bot' || value === 'auto') {
    return value
  }

  return 'unknown'
}

interface NormalizedCapabilityIdentity {
  readonly authenticated: boolean
  readonly currentContract: boolean
  readonly identity: CapabilityReview['identity']
  readonly tokenScopes: readonly string[]
  readonly userOpenId: string | null
}

const normalizeCurrentIdentity = (
  rootIdentity: CapabilityReview['identity'],
  identities: JsonRecord,
): NormalizedCapabilityIdentity => {
  if (
    Object.prototype.hasOwnProperty.call(identities, 'user') &&
    !isRecord(identities.user)
  ) {
    throw invalidCapabilityResponse('capabilities.auth-status')
  }

  const nestedUser = isRecord(identities.user) ? identities.user : null
  const tokenScopes = normalizeTokenScopes(nestedUser?.scope)
  const userOpenId = nestedUser
    ? firstTrimmedString(nestedUser.openId, nestedUser.open_id)
    : undefined
  const statusAllowsUse =
    nestedUser?.status === 'ready' || nestedUser?.status === 'needs_refresh'
  const authenticated =
    statusAllowsUse &&
    nestedUser?.available === true &&
    nestedUser?.verified === true &&
    userOpenId !== undefined

  return {
    authenticated,
    currentContract: true,
    identity: authenticated ? 'user' : rootIdentity,
    tokenScopes,
    userOpenId: authenticated ? userOpenId : null,
  }
}

const normalizeLegacyIdentity = (
  rootIdentity: CapabilityReview['identity'],
  authStatus: JsonRecord,
): NormalizedCapabilityIdentity => {
  const userOpenId =
    rootIdentity === 'user'
      ? firstTrimmedString(authStatus.userOpenId, authStatus.user_open_id) ??
        null
      : null

  return {
    authenticated: rootIdentity === 'user' && userOpenId !== null,
    currentContract: false,
    identity: rootIdentity,
    tokenScopes: [],
    userOpenId,
  }
}

const normalizeTokenScopes = (value: unknown): readonly string[] => {
  if (value === undefined || value === null) {
    return []
  }

  if (typeof value !== 'string') {
    throw invalidCapabilityResponse('capabilities.auth-status')
  }

  return Object.freeze(
    [...new Set(value.split(/\s+/).filter(Boolean))].sort(),
  )
}

const normalizeAppScopes = (scopeEnvelope: JsonRecord): readonly string[] => {
  const scopeData = isRecord(scopeEnvelope.data) ? scopeEnvelope.data : null
  const rawScopes = [
    scopeEnvelope.userScopes,
    scopeEnvelope.scopes,
    scopeData?.userScopes,
    scopeData?.scopes,
  ].find(Array.isArray)

  if (
    !rawScopes ||
    !rawScopes.every((scope): scope is string => typeof scope === 'string')
  ) {
    throw invalidCapabilityResponse('capabilities.scopes')
  }

  return Object.freeze([...new Set(rawScopes)].sort())
}

const intersectScopes = (
  tokenScopes: readonly string[],
  appScopes: readonly string[],
): readonly string[] => {
  const appScopeSet = new Set(appScopes)
  return Object.freeze(tokenScopes.filter((scope) => appScopeSet.has(scope)))
}

const extractEventKeys = (value: unknown): string[] => {
  let candidates: unknown[]

  if (Array.isArray(value)) {
    candidates = value
  } else if (isRecord(value) && Array.isArray(value.items)) {
    candidates = value.items
  } else if (isRecord(value) && Array.isArray(value.events)) {
    candidates = value.events
  } else {
    throw invalidCapabilityResponse('capabilities.events')
  }

  return uniqueStrings(
    candidates.map((candidate) =>
      isRecord(candidate) ? candidate.key ?? candidate.event_type : undefined,
    ),
  )
}

const extractMessageItems = (payload: unknown): JsonRecord[] => {
  if (Array.isArray(payload)) {
    return assertRecordArray(payload)
  }

  if (!isRecord(payload)) {
    throw invalidMessageResponse()
  }

  const candidates: unknown[] = [
    payload.items,
    payload.messages,
    isRecord(payload.data) ? payload.data.items : undefined,
    isRecord(payload.data) ? payload.data.messages : undefined,
  ]
  const items = candidates.find(Array.isArray)

  if (!Array.isArray(items)) {
    throw invalidMessageResponse()
  }

  return assertRecordArray(items)
}

const assertRecordArray = (items: unknown[]): JsonRecord[] => {
  if (!items.every(isRecord)) {
    throw invalidMessageResponse()
  }

  return items
}

const normalizeMessage = (message: JsonRecord): StandardLarkMessage => {
  const sourceId = firstString(message.message_id, message.id)
  const chatId = firstString(message.chat_id)
  const occurredAt = normalizeTimestamp(message.create_time ?? message.createTime)

  if (!sourceId || !chatId || !occurredAt) {
    throw invalidMessageResponse()
  }

  const senderSource = isRecord(message.sender) ? message.sender : {}
  const sender = compactIdentity({
    id: firstString(
      senderSource.id,
      senderSource.open_id,
      senderSource.sender_id,
      message.sender_id,
    ),
    name: firstString(senderSource.name, senderSource.display_name),
    type: firstString(senderSource.sender_type, senderSource.type),
  })
  const chat = compactChat({
    id: chatId,
    name: firstString(message.chat_name),
    type: firstString(message.chat_type),
  })

  return {
    sourceId,
    occurredAt,
    type: firstString(message.msg_type, message.message_type) ?? 'unknown',
    sender,
    chat,
    content: normalizeContent(message.content),
    mentions: normalizeMentions(message.mentions),
    deleted: message.deleted === true,
    updated: message.updated === true,
  }
}

const compactIdentity = (
  identity: StandardMessageIdentity,
): StandardMessageIdentity => ({
  ...(identity.id ? { id: identity.id } : {}),
  ...(identity.name ? { name: identity.name } : {}),
  ...(identity.type ? { type: identity.type } : {}),
})

const compactChat = (chat: StandardMessageChat): StandardMessageChat => ({
  id: chat.id,
  ...(chat.name ? { name: chat.name } : {}),
  ...(chat.type ? { type: chat.type } : {}),
})

const normalizeMentions = (value: unknown): StandardMessageMention[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isRecord).map((mention) => ({
    ...(firstString(mention.id, mention.open_id)
      ? { id: firstString(mention.id, mention.open_id) }
      : {}),
    ...(firstString(mention.key) ? { key: firstString(mention.key) } : {}),
    ...(firstString(mention.name) ? { name: firstString(mention.name) } : {}),
  }))
}

const normalizeContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  if (value === undefined || value === null) {
    return ''
  }

  try {
    return JSON.stringify(value)
  } catch {
    throw invalidMessageResponse()
  }
}

const normalizeTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }

  const raw = String(value)
  const numericTimestamp = /^\d+$/.test(raw) ? Number(raw) : null
  const date =
    numericTimestamp === null
      ? new Date(raw)
      : new Date(raw.length <= 10 ? numericTimestamp * 1_000 : numericTimestamp)

  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

const uniqueStrings = (values: unknown): string[] => {
  if (!Array.isArray(values)) {
    return []
  }

  return [...new Set(values.filter((value): value is string => typeof value === 'string'))]
}

const firstString = (...values: unknown[]): string | undefined =>
  values.find((value): value is string =>
    typeof value === 'string' && value.length > 0,
  )

const firstNonBlankString = (...values: unknown[]): string | undefined =>
  values.find((value): value is string =>
    typeof value === 'string' && value.trim().length > 0,
  )

const firstTrimmedString = (...values: unknown[]): string | undefined => {
  const value = firstNonBlankString(...values)
  return value?.trim()
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const invalidMessageResponse = (): LarkCliAdapterError =>
  new LarkCliAdapterError({
    code: 'INVALID_RESPONSE',
    operation: 'messages.search',
    retryable: false,
  })

const invalidCapabilityResponse = (
  operation:
    | 'capabilities.auth-status'
    | 'capabilities.scopes'
    | 'capabilities.events',
): LarkCliAdapterError =>
  new LarkCliAdapterError({
    code: 'INVALID_RESPONSE',
    operation,
    retryable: false,
  })
