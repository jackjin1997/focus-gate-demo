import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RealFocusGate } from './real-focus-gate'

const {
  registerHumanPresence,
  authenticateReadPlan,
  supportsHumanPresence,
} = vi.hoisted(() => ({
  registerHumanPresence: vi.fn(),
  authenticateReadPlan: vi.fn(),
  supportsHumanPresence: vi.fn(() => true),
}))

vi.mock('./human-presence-client', () => ({
  registerHumanPresence,
  authenticateReadPlan,
  supportsHumanPresence,
}))

const capabilityReview = {
  id: 'review-1',
  createdAt: '2026-07-12T10:00:00.000Z',
  runtime: { address: '127.0.0.1:4317', persistence: 'SQLite' },
  lark: {
    cliVersion: '1.0.26',
    profileName: 'focus-profile',
    authenticated: true,
    identity: 'user',
    accountFingerprint: `sha256:${'b'.repeat(64)}`,
    messageSearch: true,
    eventReceiver: true,
  },
  humanPresence: {
    registered: true,
    method: 'passkey',
  },
  boundaries: [
    '能力研究不会读取消息',
    '机器人事件不代表完整个人收件箱',
    '所有写入保持关闭',
  ],
}

const readPlan = {
  plan: {
    id: 'plan-1',
    digest: 'sha256:plan-digest',
    startsAt: '2026-07-12T09:50:00.000Z',
    endsAt: '2026-07-12T10:00:00.000Z',
    expiresAt: '2026-07-12T10:05:00.000Z',
    source: '飞书消息搜索',
    scope: '当前用户全部可见会话',
    accountFingerprint: `sha256:${'b'.repeat(64)}`,
    fields: ['消息正文', '发送者', '会话', '时间', '@提及'],
    exclusions: ['附件内容', '飞书写入', 'macOS 设置'],
    retention: '消息正文不写入本地数据库',
    retentionPolicy: 'never-persist-message-content',
    writes: 0,
  },
  approvalNonce: 'one-time-nonce',
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('RealFocusGate', () => {
  it('does not inspect Feishu or request a read grant on mount', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(<RealFocusGate />)

    expect(screen.getByRole('heading', { name: '先证明这道门守得住' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始能力研究' })).toBeEnabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps capability research separate from the first message read plan', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse(capabilityReview))
      .mockImplementationOnce(() => jsonResponse(readPlan))
    vi.stubGlobal('fetch', fetchMock)
    render(<RealFocusGate />)

    fireEvent.click(screen.getByRole('button', { name: '开始能力研究' }))
    await screen.findByText('当前用户身份可用')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/capability-reviews',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(screen.getByText('这一步没有读取任何消息。')).toBeInTheDocument()

    scrollTo.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '审阅首次读取' }))
    await screen.findByRole('heading', { name: '这一次，系统准备读取什么' })

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/read-plans',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(screen.getByText('当前用户全部可见会话')).toBeInTheDocument()
    expect(screen.getAllByText(`sha256:${'b'.repeat(64)}`).length).toBeGreaterThan(0)
    expect(screen.getByText('0 项写入')).toBeInTheDocument()
    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' })
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('requires an explicit acknowledgement before activating the one-time read grant', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse(capabilityReview))
      .mockImplementationOnce(() => jsonResponse(readPlan))
    authenticateReadPlan.mockResolvedValue({
      runId: 'run-1',
      status: 'completed',
      itemCount: 4,
      coverage: 'bounded-search-complete',
      rawDeleted: true,
      rawPersisted: false,
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<RealFocusGate />)

    fireEvent.click(screen.getByRole('button', { name: '开始能力研究' }))
    await screen.findByText('当前用户身份可用')
    fireEvent.click(screen.getByRole('button', { name: '审阅首次读取' }))
    await screen.findByRole('heading', { name: '这一次，系统准备读取什么' })

    const approveButton = screen.getByRole('button', { name: 'Touch ID 确认并读取' })
    expect(approveButton).toBeDisabled()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '我确认只授权清单中的一次性读取，授权不会包含任何写入',
      }),
    )
    fireEvent.click(approveButton)

    await waitFor(() => expect(authenticateReadPlan).toHaveBeenCalledTimes(1))
    expect(authenticateReadPlan).toHaveBeenCalledWith({
      planId: 'plan-1',
      digest: 'sha256:plan-digest',
      approvalNonce: 'one-time-nonce',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await screen.findByRole('heading', { name: '首次读取已经完成' })).toBeInTheDocument()
    expect(screen.getByText('从未写入本地数据库')).toBeInTheDocument()
  })

  it('keeps the read wall closed when the current CLI has no user message-search grant', async () => {
    const disconnectedReview = {
      ...capabilityReview,
      lark: {
        ...capabilityReview.lark,
        authenticated: false,
        identity: 'bot',
        messageSearch: false,
      },
    }
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse(disconnectedReview))
      .mockImplementationOnce(() => jsonResponse(disconnectedReview))
    vi.stubGlobal('fetch', fetchMock)
    render(<RealFocusGate />)

    fireEvent.click(screen.getByRole('button', { name: '开始能力研究' }))
    await screen.findByText('需要重新授权')

    expect(
      screen.getByRole('heading', { name: '只需补充消息搜索权限' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "lark-cli --profile 'focus-profile' auth login --scope 'search:message'",
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('此命令只补充 search:message 权限，不会读取任何消息。'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '完成授权不等于批准读取。授权后返回这里并重新检查；后续仍需审阅读取计划，再用 Touch ID 明确批准。',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新检查飞书授权' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '审阅首次读取' })).not.toBeInTheDocument()
    expect(authenticateReadPlan).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '重新检查飞书授权' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/capability-reviews',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(authenticateReadPlan).not.toHaveBeenCalled()
  })

  it('prioritizes OAuth recovery when both Lark and Passkey are unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({
        ...capabilityReview,
        lark: {
          ...capabilityReview.lark,
          authenticated: false,
          identity: 'bot',
          messageSearch: false,
        },
        humanPresence: { registered: false, method: 'passkey' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    render(<RealFocusGate />)

    fireEvent.click(screen.getByRole('button', { name: '开始能力研究' }))

    expect(
      await screen.findByRole('heading', { name: '只需补充消息搜索权限' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新检查飞书授权' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '建立 Touch ID 门禁' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '审阅首次读取' })).not.toBeInTheDocument()
    expect(registerHumanPresence).not.toHaveBeenCalled()
    expect(authenticateReadPlan).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('renders a safely quoted command for an untrusted pinned profile', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({
        ...capabilityReview,
        lark: {
          ...capabilityReview.lark,
          profileName: "focus'; echo pwn #",
          authenticated: false,
          identity: 'bot',
          messageSearch: false,
        },
      }))
    vi.stubGlobal('fetch', fetchMock)
    render(<RealFocusGate />)

    fireEvent.click(screen.getByRole('button', { name: '开始能力研究' }))

    expect(
      await screen.findByText(
        "lark-cli --profile 'focus'\\''; echo pwn #' auth login --scope 'search:message'",
      ),
    ).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(authenticateReadPlan).not.toHaveBeenCalled()
  })

  it('does not fabricate an executable authorization command without a pinned profile', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({
        ...capabilityReview,
        lark: {
          ...capabilityReview.lark,
          profileName: null,
          authenticated: false,
          identity: 'bot',
          messageSearch: false,
        },
      }))
    vi.stubGlobal('fetch', fetchMock)
    render(<RealFocusGate />)

    fireEvent.click(screen.getByRole('button', { name: '开始能力研究' }))

    expect(
      await screen.findByText(
        '当前能力报告没有固定 Profile，无法安全生成授权命令。请先固定 lark-cli Profile，再重新检查。',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^lark-cli --profile/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新检查飞书授权' })).toBeEnabled()
    expect(authenticateReadPlan).not.toHaveBeenCalled()
  })

  it('requires an explicit passkey registration ceremony before plan review', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({
        ...capabilityReview,
        humanPresence: { registered: false, method: 'passkey' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    registerHumanPresence.mockResolvedValue({ verified: true })
    render(<RealFocusGate />)

    fireEvent.click(screen.getByRole('button', { name: '开始能力研究' }))
    await screen.findByText('尚未建立')

    expect(screen.queryByRole('button', { name: '审阅首次读取' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '建立 Touch ID 门禁' }))

    await waitFor(() => expect(registerHumanPresence).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('已绑定 Passkey')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '审阅首次读取' })).toBeEnabled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
