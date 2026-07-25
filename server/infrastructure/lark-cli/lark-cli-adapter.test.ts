import { describe, expect, it, vi } from 'vitest'

import {
  LarkCliAdapter,
  LarkCliAdapterError,
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
  type SafeLarkCliLogEvent,
} from './index'

class RecordingRunner implements CommandRunner {
  readonly invocations: CommandInvocation[] = []

  constructor(private readonly results: CommandResult[]) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.invocations.push(invocation)
    const result = this.results.shift()

    if (!result) {
      throw new Error('No fake result was configured')
    }

    return result
  }
}

const success = (stdout: unknown): CommandResult => ({
  exitCode: 0,
  stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
  stderr: '',
})

describe('LarkCliAdapter capability review', () => {
  it('runs only the four approved, read-only capability commands', async () => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.26'),
      success({ identity: 'user', userOpenId: 'ou_private' }),
      success({ userScopes: ['search:message', 'im:message:readonly'] }),
      success([
        { key: 'im.message.receive_v1' },
        { key: 'im.message.reaction.created_v1' },
      ]),
    ])
    const pinProfile = vi.fn().mockResolvedValue('focus-profile')
    const adapter = new LarkCliAdapter({ runner, pinProfile })

    await expect(adapter.reviewCapabilities()).resolves.toEqual({
      cliVersion: '1.0.26',
      profileName: 'focus-profile',
      authenticated: true,
      identity: 'user',
      userOpenId: 'ou_private',
      scopes: ['im:message:readonly', 'search:message'],
      eventKeys: [
        'im.message.reaction.created_v1',
        'im.message.receive_v1',
      ],
    })

    expect(runner.invocations).toEqual([
      {
        executable: 'lark-cli',
        args: ['--version'],
        options: { shell: false },
      },
      {
        executable: 'lark-cli',
        args: ['auth', 'status', '--json', '--verify'],
        options: { shell: false },
      },
      {
        executable: 'lark-cli',
        args: ['auth', 'scopes', '--json'],
        options: { shell: false },
      },
      {
        executable: 'lark-cli',
        args: ['event', 'list', '--json'],
        options: { shell: false },
      },
    ])
    expect(pinProfile).toHaveBeenCalledTimes(1)
  })

  it('does not mistake a remembered user id for an active user token', async () => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.68'),
      success({
        identity: 'bot',
        verified: true,
        identities: {
          bot: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'im:message:readonly',
          },
          user: {
            status: 'missing',
            available: false,
            verified: null,
            scope: null,
            userName: 'Remembered User',
            openId: 'ou_remembered',
          },
        },
      }),
      success({ userScopes: ['search:message'] }),
      success([]),
    ])

    const review = await new LarkCliAdapter({ runner }).reviewCapabilities()

    expect(review.authenticated).toBe(false)
    expect(review.identity).toBe('bot')
    expect(review.userOpenId).toBeNull()
    expect(review.scopes).toEqual([])
    expect(JSON.stringify(review)).not.toContain('ou_remembered')
    expect(JSON.stringify(review)).not.toContain('Remembered User')
  })

  it('intersects the verified user token scope with the app scope directory', async () => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.68'),
      success({
        identity: 'bot',
        verified: true,
        identities: {
          bot: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message docx:document:readonly',
          },
          user: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'docx:document:readonly',
            userName: 'Active User',
            openId: 'ou_active',
          },
        },
      }),
      success({
        userScopes: ['search:message', 'docx:document:readonly'],
      }),
      success([]),
    ])

    const review = await new LarkCliAdapter({ runner }).reviewCapabilities()

    expect(review.authenticated).toBe(true)
    expect(review.identity).toBe('user')
    expect(review.userOpenId).toBe('ou_active')
    expect(review.scopes).toEqual(['docx:document:readonly'])
    expect(review.scopes).not.toContain('search:message')
  })

  it('exposes message search only when both the user token and app include it', async () => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.68'),
      success({
        identity: 'bot',
        verified: true,
        identities: {
          bot: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message',
          },
          user: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message',
            openId: 'ou_active',
          },
        },
      }),
      success({ userScopes: ['search:message'] }),
      success([]),
    ])

    const review = await new LarkCliAdapter({ runner }).reviewCapabilities()

    expect(review.authenticated).toBe(true)
    expect(review.scopes).toEqual(['search:message'])
  })

  it('does not let root bot verification replace nested user verification', async () => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.68'),
      success({
        identity: 'bot',
        verified: true,
        identities: {
          bot: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message',
          },
          user: {
            status: 'ready',
            available: true,
            verified: false,
            scope: 'search:message',
            openId: 'ou_unverified',
          },
        },
      }),
      success({ userScopes: ['search:message'] }),
      success([]),
    ])

    const review = await new LarkCliAdapter({ runner }).reviewCapabilities()

    expect(review.authenticated).toBe(false)
    expect(review.identity).toBe('bot')
    expect(review.userOpenId).toBeNull()
    expect(review.scopes).toEqual([])
    expect(JSON.stringify(review)).not.toContain('ou_unverified')
  })

  it('accepts a verified and available user token that needs refresh', async () => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.68'),
      success({
        identity: 'bot',
        verified: true,
        identities: {
          bot: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message',
          },
          user: {
            status: 'needs_refresh',
            available: true,
            verified: true,
            scope: 'search:message',
            openId: 'ou_refreshable',
          },
        },
      }),
      success({ userScopes: ['search:message'] }),
      success([]),
    ])

    const review = await new LarkCliAdapter({ runner }).reviewCapabilities()

    expect(review).toMatchObject({
      authenticated: true,
      identity: 'user',
      userOpenId: 'ou_refreshable',
      scopes: ['search:message'],
    })
  })

  it('normalizes whitespace-delimited token scopes before intersecting them', async () => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.68'),
      success({
        identity: 'bot',
        verified: true,
        identities: {
          bot: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message',
          },
          user: {
            status: 'ready',
            available: true,
            verified: true,
            scope:
              ' search:message\tdocx:document:readonly\nsearch:message  im:message:readonly ',
            openId: 'ou_active',
          },
        },
      }),
      success({
        userScopes: [
          'calendar:calendar:readonly',
          'search:message',
          'im:message:readonly',
          'docx:document:readonly',
        ],
      }),
      success([]),
    ])

    const review = await new LarkCliAdapter({ runner }).reviewCapabilities()

    expect(review.scopes).toEqual([
      'docx:document:readonly',
      'im:message:readonly',
      'search:message',
    ])
  })

  it('requires a user open id for legacy top-level authentication', async () => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.26'),
      success({ identity: 'user' }),
      success({ userScopes: [] }),
      success([]),
    ])

    const review = await new LarkCliAdapter({ runner }).reviewCapabilities()

    expect(review.authenticated).toBe(false)
    expect(review.identity).toBe('user')
    expect(review.userOpenId).toBeNull()
  })

  it.each([
    {
      reason: 'user status is unknown',
      authStatus: {
        identity: 'bot',
        userOpenId: 'ou_remembered_root',
        verified: true,
        identities: {
          bot: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message',
          },
          user: {
            status: 'unknown',
            available: true,
            verified: true,
            scope: 'search:message',
            openId: 'ou_unknown_status',
          },
        },
      },
      rejectedOpenIds: ['ou_remembered_root', 'ou_unknown_status'],
    },
    {
      reason: 'the user token is unavailable',
      authStatus: {
        identity: 'bot',
        userOpenId: 'ou_remembered_root',
        verified: true,
        identities: {
          bot: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message',
          },
          user: {
            status: 'ready',
            available: false,
            verified: true,
            scope: 'search:message',
            openId: 'ou_unavailable',
          },
        },
      },
      rejectedOpenIds: ['ou_remembered_root', 'ou_unavailable'],
    },
    {
      reason: 'the user open id is missing',
      authStatus: {
        identity: 'bot',
        userOpenId: 'ou_remembered_root',
        verified: true,
        identities: {
          bot: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message',
          },
          user: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message',
            userName: 'Remembered User',
          },
        },
      },
      rejectedOpenIds: ['ou_remembered_root'],
    },
  ])('fails closed when $reason', async ({ authStatus, rejectedOpenIds }) => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.68'),
      success(authStatus),
      success({ userScopes: [] }),
      success([]),
    ])

    const review = await new LarkCliAdapter({ runner }).reviewCapabilities()

    expect(review.authenticated).toBe(false)
    expect(review.identity).toBe('bot')
    expect(review.userOpenId).toBeNull()
    expect(review.scopes).toEqual([])
    for (const rejectedOpenId of rejectedOpenIds) {
      expect(JSON.stringify(review)).not.toContain(rejectedOpenId)
    }
  })

  it('rejects an unknown nested token scope type without exposing it', async () => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.68'),
      success({
        identity: 'bot',
        verified: true,
        identities: {
          bot: {
            status: 'ready',
            available: true,
            verified: true,
            scope: 'search:message',
          },
          user: {
            status: 'ready',
            available: true,
            verified: true,
            scope: { unexpected: 'secret-token-scope' },
            openId: 'ou_active',
          },
        },
      }),
      success({ userScopes: ['search:message'] }),
      success([]),
    ])
    const logger = { log: vi.fn() }

    const error = await new LarkCliAdapter({ runner, logger })
      .reviewCapabilities()
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: 'INVALID_RESPONSE',
      operation: 'capabilities.auth-status',
      retryable: false,
    })
    expect(JSON.stringify(error)).not.toContain('secret-token-scope')
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(
      'secret-token-scope',
    )
  })

  it.each([
    {
      source: 'top-level userScopes',
      scopeEnvelope: {
        userScopes: ['search:message', 'im:message:readonly', 'search:message'],
      },
    },
    {
      source: 'top-level scopes',
      scopeEnvelope: {
        scopes: ['search:message', 'im:message:readonly', 'search:message'],
      },
    },
    {
      source: 'data.userScopes',
      scopeEnvelope: {
        data: {
          userScopes: ['search:message', 'im:message:readonly', 'search:message'],
        },
      },
    },
    {
      source: 'data.scopes',
      scopeEnvelope: {
        data: {
          scopes: ['search:message', 'im:message:readonly', 'search:message'],
        },
      },
    },
  ])('normalizes, deduplicates, and sorts scopes from $source', async ({
    scopeEnvelope,
  }) => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.26'),
      success({ identity: 'user', userOpenId: 'ou_legacy' }),
      success(scopeEnvelope),
      success([]),
    ])

    const review = await new LarkCliAdapter({ runner }).reviewCapabilities()

    expect(review.scopes).toEqual(['im:message:readonly', 'search:message'])
  })

  it.each([
    {
      source: 'auth status',
      operation: 'capabilities.auth-status',
      authStatus: { unexpected: 'secret-auth-payload' },
      scopes: { userScopes: [] },
      events: [],
      secret: 'secret-auth-payload',
    },
    {
      source: 'scopes',
      operation: 'capabilities.scopes',
      authStatus: { identity: 'bot' },
      scopes: { unexpected: 'secret-scopes-payload' },
      events: [],
      secret: 'secret-scopes-payload',
    },
    {
      source: 'events',
      operation: 'capabilities.events',
      authStatus: { identity: 'bot' },
      scopes: { userScopes: [] },
      events: { unexpected: 'secret-events-payload' },
      secret: 'secret-events-payload',
    },
  ])('rejects an unrecognized $source response without exposing it', async ({
    operation,
    authStatus,
    scopes,
    events,
    secret,
  }) => {
    const runner = new RecordingRunner([
      success('lark-cli version 1.0.26'),
      success(authStatus),
      success(scopes),
      success(events),
    ])
    const logger = { log: vi.fn() }

    const error = await new LarkCliAdapter({ runner, logger })
      .reviewCapabilities()
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: 'INVALID_RESPONSE',
      operation,
      retryable: false,
    })
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(secret)
  })
})

describe('LarkCliAdapter recent message search', () => {
  it('builds an all-visible ten-minute search with fixed argv and no shell', async () => {
    const runner = new RecordingRunner([success({ items: [] })])
    const pinProfile = vi.fn().mockResolvedValue('focus-profile')
    const adapter = new LarkCliAdapter({ runner, pinProfile })

    await adapter.readRecentMessages({
      fromInclusive: new Date('2026-07-12T14:10:00+08:00'),
      toExclusive: new Date('2026-07-12T14:20:00+08:00'),
      timezoneOffsetMinutes: 8 * 60,
    })

    expect(runner.invocations).toEqual([
      {
        executable: 'lark-cli',
        args: [
          'im',
          '+messages-search',
          '--query',
          '',
          '--start',
          '2026-07-12T14:10:00.000+08:00',
          '--end',
          '2026-07-12T14:20:00.000+08:00',
          '--page-size',
          '50',
          '--page-all',
          '--format',
          'json',
          '--as',
          'user',
        ],
        options: { shell: false },
      },
    ])
    expect(pinProfile).toHaveBeenCalledTimes(1)
  })

  it('normalizes enriched CLI JSON without dropping message semantics', async () => {
    const runner = new RecordingRunner([
      success({
        data: {
          items: [
            {
              message_id: 'om_123',
              create_time: '1783836900000',
              msg_type: 'text',
              sender: {
                id: 'ou_123',
                name: '周启明',
                sender_type: 'user',
              },
              chat_id: 'oc_123',
              chat_type: 'group',
              chat_name: '专注之门',
              content: '登录失败率升至 27%，请确认是否回滚。',
              mentions: [{ id: 'ou_me', key: '@_user_1', name: '靳泽旭' }],
              deleted: false,
              updated: true,
            },
          ],
        },
      }),
    ])

    const messages = await new LarkCliAdapter({ runner }).readRecentMessages({
      fromInclusive: new Date('2026-07-12T14:10:00+08:00'),
      toExclusive: new Date('2026-07-12T14:20:00+08:00'),
      timezoneOffsetMinutes: 480,
    })

    expect(messages).toEqual([
      {
        sourceId: 'om_123',
        occurredAt: '2026-07-12T06:15:00.000Z',
        type: 'text',
        sender: { id: 'ou_123', name: '周启明', type: 'user' },
        chat: { id: 'oc_123', name: '专注之门', type: 'group' },
        content: '登录失败率升至 27%，请确认是否回滚。',
        mentions: [{ id: 'ou_me', key: '@_user_1', name: '靳泽旭' }],
        deleted: false,
        updated: true,
      },
    ])
  })

  it('accepts a top-level message array and renders structured content safely', async () => {
    const runner = new RecordingRunner([
      success([
        {
          message_id: 'om_post',
          create_time: '2026-07-12T14:19:00+08:00',
          msg_type: 'post',
          sender: { open_id: 'ou_sender' },
          chat_id: 'oc_chat',
          content: { title: '发布检查', text: '请审阅' },
        },
      ]),
    ])

    const [message] = await new LarkCliAdapter({ runner }).readRecentMessages({
      fromInclusive: new Date('2026-07-12T14:10:00+08:00'),
      toExclusive: new Date('2026-07-12T14:20:00+08:00'),
      timezoneOffsetMinutes: 480,
    })

    expect(message).toMatchObject({
      sourceId: 'om_post',
      occurredAt: '2026-07-12T06:19:00.000Z',
      content: '{"title":"发布检查","text":"请审阅"}',
      mentions: [],
      deleted: false,
      updated: false,
    })
  })

  it('normalizes second timestamps and emits metadata-only success logs', async () => {
    const body = '这段正文不得出现在日志中'
    const runner = new RecordingRunner([
      success({
        messages: [
          {
            message_id: 'om_seconds',
            create_time: '1783837140',
            chat_id: 'oc_chat',
            content: body,
          },
        ],
      }),
    ])
    const logs: SafeLarkCliLogEvent[] = []

    const [message] = await new LarkCliAdapter({
      runner,
      logger: { log: (event) => logs.push(event) },
      now: () => 1_000,
    }).readRecentMessages({
      fromInclusive: new Date('2026-07-12T14:10:00+08:00'),
      toExclusive: new Date('2026-07-12T14:20:00+08:00'),
      timezoneOffsetMinutes: 480,
    })

    expect(message.occurredAt).toBe('2026-07-12T06:19:00.000Z')
    expect(logs).toEqual([
      {
        component: 'lark-cli-adapter',
        operation: 'messages.search',
        outcome: 'success',
        durationMs: 0,
        exitCode: 0,
        itemCount: 1,
      },
    ])
    expect(JSON.stringify(logs)).not.toContain(body)
  })

  it('rejects an invalid timezone before invoking the CLI', async () => {
    const runner = new RecordingRunner([])

    await expect(
      new LarkCliAdapter({ runner }).readRecentMessages({
        fromInclusive: new Date('2026-07-12T14:10:00+08:00'),
        toExclusive: new Date('2026-07-12T14:20:00+08:00'),
        timezoneOffsetMinutes: 15 * 60,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      operation: 'messages.search',
    })
    expect(runner.invocations).toEqual([])
  })

  it('rejects a window that differs from the approved ten minutes', async () => {
    const runner = new RecordingRunner([])

    await expect(
      new LarkCliAdapter({ runner }).readRecentMessages({
        fromInclusive: new Date('2026-07-12T14:10:00+08:00'),
        toExclusive: new Date('2026-07-12T14:20:00.001+08:00'),
        timezoneOffsetMinutes: 480,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      operation: 'messages.search',
    })
    expect(runner.invocations).toEqual([])
  })

  it('fails closed when page-all reports a truncated result set', async () => {
    const body = '不完整结果中的正文'
    const pageToken = 'pagination-token-must-not-be-logged'
    const runner = new RecordingRunner([
      success({
        items: [
          {
            message_id: 'om_truncated',
            create_time: '1783837140000',
            chat_id: 'oc_chat',
            content: body,
          },
        ],
        has_more: true,
        page_token: pageToken,
      }),
    ])
    const logs: SafeLarkCliLogEvent[] = []

    await expect(
      new LarkCliAdapter({
        runner,
        logger: { log: (event) => logs.push(event) },
      }).readRecentMessages({
        fromInclusive: new Date('2026-07-12T14:10:00+08:00'),
        toExclusive: new Date('2026-07-12T14:20:00+08:00'),
        timezoneOffsetMinutes: 480,
      }),
    ).rejects.toMatchObject({
      code: 'INCOMPLETE_RESULT',
      operation: 'messages.search',
      retryable: true,
    })

    expect(JSON.stringify(logs)).not.toContain(body)
    expect(JSON.stringify(logs)).not.toContain(pageToken)
  })
})

describe('LarkCliAdapter failures and observability', () => {
  it('returns a structured permission error and never logs stderr, token, or body', async () => {
    const secret = 't-u-secret-access-token'
    const body = '绝密项目正文'
    const runner = new RecordingRunner([
      {
        exitCode: 1,
        stdout: '',
        stderr: JSON.stringify({
          code: 99991672,
          msg: `Access denied token=${secret} body=${body}`,
          permission_violations: [{ scope: 'search:message' }],
        }),
      },
    ])
    const logs: SafeLarkCliLogEvent[] = []
    const adapter = new LarkCliAdapter({
      runner,
      logger: { log: (event) => logs.push(event) },
    })

    const attempt = adapter.readRecentMessages({
      fromInclusive: new Date('2026-07-12T14:10:00+08:00'),
      toExclusive: new Date('2026-07-12T14:20:00+08:00'),
      timezoneOffsetMinutes: 480,
    })

    await expect(attempt).rejects.toMatchObject({
      name: 'LarkCliAdapterError',
      code: 'PERMISSION_DENIED',
      operation: 'messages.search',
      exitCode: 1,
      retryable: false,
    })

    expect(logs).toEqual([
      expect.objectContaining({
        operation: 'messages.search',
        outcome: 'error',
        errorCode: 'PERMISSION_DENIED',
        exitCode: 1,
      }),
    ])
    expect(JSON.stringify(logs)).not.toContain(secret)
    expect(JSON.stringify(logs)).not.toContain(body)
  })

  it('turns invalid JSON into a structured response error without a raw snippet', async () => {
    const raw = 'not-json t-u-secret-body'
    const runner = new RecordingRunner([success(raw)])
    const logger = { log: vi.fn() }

    await expect(
      new LarkCliAdapter({ runner, logger }).readRecentMessages({
        fromInclusive: new Date('2026-07-12T14:10:00+08:00'),
        toExclusive: new Date('2026-07-12T14:20:00+08:00'),
        timezoneOffsetMinutes: 480,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'INVALID_RESPONSE',
        operation: 'messages.search',
      }),
    )

    const errorEvent = logger.log.mock.calls[0]?.[0]
    expect(JSON.stringify(errorEvent)).not.toContain(raw)
  })

  it('rejects the entire response when any message is outside [from, to)', async () => {
    const runner = new RecordingRunner([
      success({
        items: [
          {
            message_id: 'om_at_exclusive_end',
            create_time: '2026-07-12T14:20:00+08:00',
            chat_id: 'oc_chat',
            content: '这段正文不得进入上层',
          },
        ],
      }),
    ])

    await expect(
      new LarkCliAdapter({ runner }).readRecentMessages({
        fromInclusive: new Date('2026-07-12T14:10:00+08:00'),
        toExclusive: new Date('2026-07-12T14:20:00+08:00'),
        timezoneOffsetMinutes: 480,
      }),
    ).rejects.toMatchObject({
      code: 'OUT_OF_RANGE_RESULT',
      operation: 'messages.search',
    })
  })

  it('exports a serializable error with only approved diagnostic fields', () => {
    const error = new LarkCliAdapterError({
      code: 'COMMAND_FAILED',
      operation: 'capabilities.version',
      exitCode: 127,
      retryable: false,
    })

    expect(error.toJSON()).toEqual({
      name: 'LarkCliAdapterError',
      code: 'COMMAND_FAILED',
      operation: 'capabilities.version',
      exitCode: 127,
      retryable: false,
      message: 'The lark-cli command could not be completed.',
    })
  })
})
