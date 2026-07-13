import { createHash, randomUUID } from 'node:crypto'
import {
  assertReadPlan,
  canonicalDigest,
  createReadPlan,
  fingerprintUserOpenId,
  issueApprovalNonce,
  type ReadPlan,
} from '../domain'
import type {
  CapabilityReview,
  RecentMessageWindow,
  StandardLarkMessage,
} from '../infrastructure/lark-cli'
import { FocusGateStore } from '../infrastructure/sqlite/focus-gate-store'

export interface LarkGateway {
  reviewCapabilities(): Promise<CapabilityReview>
  readRecentMessages(window: RecentMessageWindow): Promise<readonly StandardLarkMessage[]>
}

interface FocusGateApplicationOptions {
  store: FocusGateStore
  lark: LarkGateway
  now?: () => Date
  createId?: (prefix: string) => string
}

export class FocusGateApplication {
  private readonly store: FocusGateStore
  private readonly lark: LarkGateway
  private readonly now: () => Date
  private readonly createId: (prefix: string) => string

  constructor(options: FocusGateApplicationOptions) {
    this.store = options.store
    this.lark = options.lark
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? ((prefix) => `${prefix}_${randomUUID()}`)
  }

  async createCapabilityReview() {
    const capability = await this.lark.reviewCapabilities()
    const userOpenId = activeUserOpenId(capability)
    const id = this.createId('review')
    const createdAt = this.now().toISOString()
    const result = {
      id,
      createdAt,
      runtime: {
        address: '127.0.0.1:4317',
        persistence: 'SQLite',
      },
      lark: {
        cliVersion: capability.cliVersion ?? 'unknown',
        profileName: capability.profileName ?? null,
        authenticated: capability.authenticated,
        identity: capability.identity,
        accountFingerprint: userOpenId
          ? fingerprintUserOpenId(userOpenId)
          : null,
        messageSearch: capability.scopes.includes('search:message'),
        eventReceiver: capability.eventKeys.includes('im.message.receive_v1'),
      },
      boundaries: [
        '能力研究不会读取消息',
        '机器人事件不代表完整个人收件箱',
        '所有写入保持关闭',
      ],
    }
    this.store.saveCapabilityReview({
      id,
      createdAt,
      report: {
        cliVersion: result.lark.cliVersion,
        profileName: result.lark.profileName,
        authenticated: result.lark.authenticated,
        identity: result.lark.identity,
        userOpenId,
        messageSearch: result.lark.messageSearch,
        eventReceiver: result.lark.eventReceiver,
      },
    })
    return result
  }

  previewReadPlan() {
    const requestedAt = this.now()
    const capabilityReview = this.store.getLatestCapabilityReview()
    const userOpenId = capabilityReviewUserOpenId(capabilityReview?.report)
    const domainPlan = createReadPlan({
      requestedAt: requestedAt.toISOString(),
      capabilityReviewId: capabilityReview?.id ?? null,
      userOpenId,
    })
    const digest = canonicalDigest(domainPlan)
    const expiresAt = new Date(requestedAt.getTime() + 5 * 60 * 1_000).toISOString()
    const approval = issueApprovalNonce({
      intent: domainPlan,
      issuedAt: requestedAt.toISOString(),
      expiresAt,
    })
    const id = this.createId('plan')

    this.store.saveReadPlan({
      id,
      digest,
      approvalNonceHash: approval.approval.nonceDigest,
      startsAt: domainPlan.window.fromInclusive,
      endsAt: domainPlan.window.toExclusive,
      expiresAt,
      manifest: domainPlan as unknown as Record<string, unknown>,
    })

    return {
      plan: {
        id,
        digest,
        startsAt: domainPlan.window.fromInclusive,
        endsAt: domainPlan.window.toExclusive,
        expiresAt,
        source: '飞书消息搜索',
        sourceKind: domainPlan.source,
        scope: domainPlan.scope,
        accountFingerprint: domainPlan.account.fingerprint,
        fields: domainPlan.fields,
        exclusions: domainPlan.exclusions,
        retention: domainPlan.retention,
        retentionPolicy: domainPlan.retentionPolicy,
        writes: domainPlan.writes,
      },
      approvalNonce: approval.nonce,
    }
  }

  inspectReadPlanBinding(input: { planId: string; digest?: string }) {
    const { storedPlan } = this.loadBoundReadPlan(input)
    return {
      planId: storedPlan.id,
      digest: storedPlan.digest,
      expiresAt: storedPlan.expiresAt,
    }
  }

  async approveReadPlan(input: {
    planId: string
    digest: string
    approvalNonce: string
  }) {
    const { storedPlan, domainPlan } = this.loadBoundReadPlan(input)
    if (storedPlan.approvalNonceHash !== hashNonce(input.approvalNonce)) {
      throw new Error('READ_PLAN_MISMATCH')
    }

    const capabilities = await this.lark.reviewCapabilities()
    const currentUserOpenId = activeUserOpenId(capabilities)
    if (
      !capabilities.authenticated ||
      capabilities.identity !== 'user' ||
      !currentUserOpenId ||
      !capabilities.scopes.includes('search:message')
    ) {
      throw new Error('FEISHU_USER_AUTH_REQUIRED')
    }
    if (fingerprintUserOpenId(currentUserOpenId) !== domainPlan.account.fingerprint) {
      throw new Error('READ_PLAN_IDENTITY_CHANGED')
    }

    const approvedAt = this.now().toISOString()
    const claimedPlan = this.store.claimReadPlan({
      id: input.planId,
      digest: input.digest,
      approvalNonceHash: hashNonce(input.approvalNonce),
      now: approvedAt,
    })

    const runId = this.createId('run')
    this.store.createReadRun({ id: runId, planId: claimedPlan.id, startedAt: approvedAt })
    try {
      const messages = await this.lark.readRecentMessages({
        fromInclusive: new Date(domainPlan.window.fromInclusive),
        toExclusive: new Date(domainPlan.window.toExclusive),
        timezoneOffsetMinutes: 480,
      })
      assertMessagesInsidePlan(messages, domainPlan)
      const observedAt = this.now().toISOString()

      for (const message of messages) {
        this.store.upsertInboundEvent({
          runId,
          sourceId: message.sourceId,
          occurredAt: message.occurredAt,
          senderOpenId: message.sender.id,
          chatId: message.chat.id,
          metadata: messageMetadata(message),
          observedAt,
        })
      }

      const uniqueEvents = this.store.listInboundEvents(runId)
      const completedAt = this.now().toISOString()
      this.store.saveDigestAndCompleteRun({
        id: this.createId('digest'),
        runId,
        createdAt: completedAt,
        summary: {
          readPlanDigest: input.digest,
          readPlan: domainPlan as unknown as Record<string, unknown>,
          itemCount: uniqueEvents.length,
          sourceIds: uniqueEvents.map((event) => event.sourceId),
          coverage: 'bounded-search-unverified',
        },
      })

      return {
        runId,
        status: 'completed',
        itemCount: uniqueEvents.length,
        coverage: 'bounded-search-unverified',
        rawPersisted: false,
        rawDeleted: this.store
          .listInboundEvents(runId)
          .every((event) => event.content === null && event.rawDeletedAt !== null),
      }
    } catch (error) {
      this.store.failReadRun({
        id: runId,
        failedAt: this.now().toISOString(),
        failureCode: safeFailureCode(error),
      })
      throw error
    }
  }

  private loadBoundReadPlan(input: { planId: string; digest?: string }) {
    const storedPlan = this.store.getReadPlan(input.planId)
    if (!storedPlan) throw new Error('READ_PLAN_NOT_FOUND')
    const expectedDigest = input.digest ?? storedPlan.digest
    if (storedPlan.digest !== expectedDigest) throw new Error('READ_PLAN_MISMATCH')
    if (storedPlan.status !== 'pending') throw new Error('READ_PLAN_ALREADY_CLAIMED')

    const inspectedAt = this.now().getTime()
    const expiresAt = Date.parse(storedPlan.expiresAt)
    if (!Number.isFinite(inspectedAt) || !Number.isFinite(expiresAt) || inspectedAt >= expiresAt) {
      throw new Error('READ_PLAN_EXPIRED')
    }

    const manifest: unknown = storedPlan.manifest
    try {
      assertReadPlan(manifest)
    } catch {
      throw new Error('READ_PLAN_MISMATCH')
    }
    const domainPlan = manifest
    if (canonicalDigest(domainPlan) !== expectedDigest) throw new Error('READ_PLAN_MISMATCH')
    if (domainPlan.account.fingerprint === null) {
      throw new Error('READ_PLAN_IDENTITY_UNBOUND')
    }

    return { storedPlan, domainPlan }
  }
}

function hashNonce(nonce: string) {
  return createHash('sha256').update(nonce, 'utf8').digest('hex')
}

function messageMetadata(message: StandardLarkMessage) {
  return {
    type: message.type,
    senderType: message.sender.type ?? null,
    chatType: message.chat.type ?? null,
    mentionIds: message.mentions.flatMap((mention) => mention.id ?? []),
    deleted: message.deleted,
    updated: message.updated,
  }
}

function activeUserOpenId(capability: CapabilityReview): string | null {
  return capability.authenticated &&
    capability.identity === 'user' &&
    typeof capability.userOpenId === 'string' &&
    capability.userOpenId.length > 0
    ? capability.userOpenId
    : null
}

function capabilityReviewUserOpenId(report: Record<string, unknown> | undefined): string | null {
  if (!report || report.authenticated !== true || report.identity !== 'user') return null
  return typeof report.userOpenId === 'string' && report.userOpenId.length > 0
    ? report.userOpenId
    : null
}

function assertMessagesInsidePlan(
  messages: readonly StandardLarkMessage[],
  plan: ReadPlan,
): void {
  const fromInclusive = Date.parse(plan.window.fromInclusive)
  const toExclusive = Date.parse(plan.window.toExclusive)
  if (messages.some((message) => {
    const occurredAt = Date.parse(message.occurredAt)
    return !Number.isFinite(occurredAt) ||
      occurredAt < fromInclusive ||
      occurredAt >= toExclusive
  })) {
    throw new Error('READ_RESULT_OUTSIDE_PLAN')
  }
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && error.message === 'READ_RESULT_OUTSIDE_PLAN') {
    return error.message
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
  ) {
    return error.code
  }
  return 'READ_RUN_FAILED'
}
