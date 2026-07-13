// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import type {
  CapabilityReview,
  RecentMessageWindow,
  StandardLarkMessage,
} from '../infrastructure/lark-cli'
import { FocusGateStore } from '../infrastructure/sqlite/focus-gate-store'
import { FocusGateApplication, type LarkGateway } from './focus-gate-application'

class FakeLarkGateway implements LarkGateway {
  readCount = 0
  reviewCount = 0

  constructor(
    public capabilities: CapabilityReview,
    private readonly messages: readonly StandardLarkMessage[] = [],
  ) {}

  async reviewCapabilities() {
    this.reviewCount += 1
    return this.capabilities
  }

  async readRecentMessages(_window: RecentMessageWindow) {
    this.readCount += 1
    return this.messages
  }
}

const stores: FocusGateStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function setup(input?: {
  capabilities?: CapabilityReview
  messages?: readonly StandardLarkMessage[]
  now?: () => Date
}) {
  const store = new FocusGateStore(':memory:')
  stores.push(store)
  const lark = new FakeLarkGateway(
    input?.capabilities ?? {
      cliVersion: '1.0.26',
      authenticated: true,
      identity: 'user',
      userOpenId: 'ou_current_user',
      scopes: ['search:message'],
      eventKeys: ['im.message.receive_v1'],
    },
    input?.messages,
  )
  let id = 0
  const application = new FocusGateApplication({
    store,
    lark,
    now: input?.now ?? (() => new Date('2026-07-12T02:00:00.000Z')),
    createId: (prefix) => `${prefix}-${++id}`,
  })
  return { application, lark, store }
}

describe('FocusGateApplication', () => {
  it('researches capabilities without reading any message', async () => {
    const { application, lark, store } = setup()

    await expect(application.createCapabilityReview()).resolves.toMatchObject({
      runtime: { address: '127.0.0.1:4317', persistence: 'SQLite' },
      lark: {
        cliVersion: '1.0.26',
        authenticated: true,
        identity: 'user',
        accountFingerprint: 'sha256:841f415e249b40138117747521983af4a807f010e1ff0d320b3a822f19127552',
        messageSearch: true,
        eventReceiver: true,
      },
    })
    expect(lark.readCount).toBe(0)
    expect(store.getLatestCapabilityReview()).toMatchObject({
      id: 'review-1',
      report: {
        cliVersion: '1.0.26',
        identity: 'user',
        userOpenId: 'ou_current_user',
        messageSearch: true,
      },
    })
  })

  it('previews an immutable ten-minute plan bound to the latest researched account', async () => {
    const { application, lark } = setup()

    await application.createCapabilityReview()

    const preview = application.previewReadPlan()

    expect(preview.plan).toMatchObject({
      startsAt: '2026-07-12T01:50:00.000Z',
      endsAt: '2026-07-12T02:00:00.000Z',
      scope: '当前用户全部可见会话',
      accountFingerprint: 'sha256:841f415e249b40138117747521983af4a807f010e1ff0d320b3a822f19127552',
      fields: ['消息正文', '发送者', '会话', '时间', '@提及'],
      exclusions: ['附件内容', '飞书写入', 'macOS 设置'],
      retention: '消息正文不写入本地数据库',
      writes: 0,
    })
    expect(preview.plan.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(preview.approvalNonce.length).toBeGreaterThan(20)
    expect(lark.readCount).toBe(0)
  })

  it('inspects a bound pending plan without a nonce, claim, capability call, or read', async () => {
    const { application, lark, store } = setup()
    await application.createCapabilityReview()
    const preview = application.previewReadPlan()

    const binding = application.inspectReadPlanBinding({
      planId: preview.plan.id,
      digest: preview.plan.digest,
    })
    const serverResolvedBinding = application.inspectReadPlanBinding({
      planId: preview.plan.id,
    })

    expect(binding).toEqual({
      planId: preview.plan.id,
      digest: preview.plan.digest,
      expiresAt: '2026-07-12T02:05:00.000Z',
    })
    expect(serverResolvedBinding).toEqual(binding)
    expect(binding).not.toHaveProperty('approvalNonce')
    expect(store.getReadPlan(preview.plan.id)?.status).toBe('pending')
    expect(lark.reviewCount).toBe(1)
    expect(lark.readCount).toBe(0)
  })

  it('rejects missing, changed, expired, unbound, and already claimed plan bindings', async () => {
    let clock = '2026-07-12T02:00:00.000Z'
    const bound = setup({ now: () => new Date(clock) })
    await bound.application.createCapabilityReview()
    const preview = bound.application.previewReadPlan()

    expect(() => bound.application.inspectReadPlanBinding({
      planId: 'plan-missing',
      digest: preview.plan.digest,
    })).toThrow('READ_PLAN_NOT_FOUND')
    expect(() => bound.application.inspectReadPlanBinding({
      planId: preview.plan.id,
      digest: 'sha256:changed',
    })).toThrow('READ_PLAN_MISMATCH')

    clock = '2026-07-12T02:05:00.000Z'
    expect(() => bound.application.inspectReadPlanBinding({
      planId: preview.plan.id,
      digest: preview.plan.digest,
    })).toThrow('READ_PLAN_EXPIRED')

    const unbound = setup({
      capabilities: {
        cliVersion: '1.0.26',
        authenticated: false,
        identity: 'bot',
        userOpenId: null,
        scopes: [],
        eventKeys: [],
      },
    })
    await unbound.application.createCapabilityReview()
    const unboundPreview = unbound.application.previewReadPlan()
    expect(() => unbound.application.inspectReadPlanBinding({
      planId: unboundPreview.plan.id,
      digest: unboundPreview.plan.digest,
    })).toThrow('READ_PLAN_IDENTITY_UNBOUND')

    const claimed = setup()
    await claimed.application.createCapabilityReview()
    const claimedPreview = claimed.application.previewReadPlan()
    await claimed.application.approveReadPlan({
      planId: claimedPreview.plan.id,
      digest: claimedPreview.plan.digest,
      approvalNonce: claimedPreview.approvalNonce,
    })
    expect(() => claimed.application.inspectReadPlanBinding({
      planId: claimedPreview.plan.id,
      digest: claimedPreview.plan.digest,
    })).toThrow('READ_PLAN_ALREADY_CLAIMED')
  })

  it('blocks the message read when the current CLI identity is not an authorized user', async () => {
    const { application, lark } = setup()
    await application.createCapabilityReview()
    const preview = application.previewReadPlan()
    lark.capabilities = {
      cliVersion: '1.0.26',
      authenticated: false,
      identity: 'bot',
      userOpenId: null,
      scopes: [],
      eventKeys: ['im.message.receive_v1'],
    }

    await expect(
      application.approveReadPlan({
        planId: preview.plan.id,
        digest: preview.plan.digest,
        approvalNonce: preview.approvalNonce,
      }),
    ).rejects.toThrow('FEISHU_USER_AUTH_REQUIRED')
    expect(lark.readCount).toBe(0)
  })

  it('refuses approval when the latest capability research did not bind a user id', async () => {
    const { application, lark } = setup({
      capabilities: {
        cliVersion: '1.0.26',
        authenticated: false,
        identity: 'bot',
        userOpenId: null,
        scopes: [],
        eventKeys: [],
      },
    })
    await application.createCapabilityReview()
    const preview = application.previewReadPlan()
    lark.capabilities = {
      cliVersion: '1.0.26',
      authenticated: true,
      identity: 'user',
      userOpenId: 'ou_current_user',
      scopes: ['search:message'],
      eventKeys: [],
    }

    await expect(
      application.approveReadPlan({
        planId: preview.plan.id,
        digest: preview.plan.digest,
        approvalNonce: preview.approvalNonce,
      }),
    ).rejects.toThrow('READ_PLAN_IDENTITY_UNBOUND')
    expect(lark.readCount).toBe(0)
  })

  it('refuses approval without consuming the plan when the current account changed', async () => {
    const { application, lark, store } = setup()
    await application.createCapabilityReview()
    const preview = application.previewReadPlan()
    lark.capabilities = {
      ...lark.capabilities,
      userOpenId: 'ou_different_user',
    }

    await expect(
      application.approveReadPlan({
        planId: preview.plan.id,
        digest: preview.plan.digest,
        approvalNonce: preview.approvalNonce,
      }),
    ).rejects.toThrow('READ_PLAN_IDENTITY_CHANGED')
    expect(store.getReadPlan(preview.plan.id)?.status).toBe('pending')
    expect(lark.readCount).toBe(0)
  })

  it('consumes the exact plan once, deduplicates messages, and deletes raw text', async () => {
    const message: StandardLarkMessage = {
      sourceId: 'om_1',
      occurredAt: '2026-07-12T01:58:00.000Z',
      type: 'text',
      sender: { id: 'ou_sender', name: '周启明', type: 'user' },
      chat: { id: 'oc_chat', name: '发布保障群', type: 'group' },
      content: '登录失败率升至 27%，请确认是否回滚。',
      mentions: [{ id: 'ou_me', name: 'Jack' }],
      deleted: false,
      updated: false,
    }
    const { application, lark, store } = setup({ messages: [message, message] })
    await application.createCapabilityReview()
    const preview = application.previewReadPlan()

    await expect(
      application.approveReadPlan({
        planId: preview.plan.id,
        digest: preview.plan.digest,
        approvalNonce: preview.approvalNonce,
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      itemCount: 1,
      coverage: 'bounded-search-unverified',
      rawPersisted: false,
      rawDeleted: true,
    })
    expect(lark.readCount).toBe(1)

    const events = store.listInboundEvents('run-3')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      content: null,
      rawDeletedAt: '2026-07-12T02:00:00.000Z',
    })
    expect(events[0]?.metadata).not.toHaveProperty('content')

    await expect(
      application.approveReadPlan({
        planId: preview.plan.id,
        digest: preview.plan.digest,
        approvalNonce: preview.approvalNonce,
      }),
    ).rejects.toThrow('READ_PLAN_ALREADY_CLAIMED')
    expect(lark.readCount).toBe(1)
  })

  it('fails the whole run and stores no event when a gateway returns one out-of-window message', async () => {
    const message: StandardLarkMessage = {
      sourceId: 'om_outside',
      occurredAt: '2026-07-12T02:00:00.000Z',
      type: 'text',
      sender: { id: 'ou_sender' },
      chat: { id: 'oc_chat' },
      content: '不得落库的边界外正文',
      mentions: [],
      deleted: false,
      updated: false,
    }
    const { application, store } = setup({ messages: [message] })
    await application.createCapabilityReview()
    const preview = application.previewReadPlan()

    await expect(
      application.approveReadPlan({
        planId: preview.plan.id,
        digest: preview.plan.digest,
        approvalNonce: preview.approvalNonce,
      }),
    ).rejects.toThrow('READ_RESULT_OUTSIDE_PLAN')

    const run = store.getReadRun('run-3')
    expect(run).toMatchObject({ status: 'failed' })
    expect(store.listInboundEvents('run-3')).toEqual([])
  })
})
