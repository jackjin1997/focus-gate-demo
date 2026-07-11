import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FocusGateDemo } from './focus-gate-demo'

function enterFocus() {
  fireEvent.change(screen.getByLabelText('这次要想清楚的问题'), {
    target: { value: '我们是否应该先把专注之门做成飞书产品？' },
  })
  fireEvent.click(screen.getByRole('button', { name: '开始守门检查' }))
  fireEvent.click(screen.getByRole('button', { name: '我已手动开启系统专注' }))
  fireEvent.click(screen.getByRole('button', { name: '进入专注之门' }))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('FocusGateDemo', () => {
  it('starts with one thought, one time boundary, and an honest prototype notice', () => {
    render(<FocusGateDemo />)

    expect(screen.getByRole('heading', { name: '这一次，只想清楚一件事。' })).toBeInTheDocument()
    expect(screen.getByLabelText('这次要想清楚的问题')).toBeInTheDocument()
    expect(screen.getByText('体验样机，不会真实修改飞书状态、日历或消息。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始守门检查' })).toBeEnabled()
    expect(screen.queryByText(/未读|收件箱|风险分数/)).not.toBeInTheDocument()
  })

  it('moves through prepare, preflight, guarding, one knock, and the re-entry digest', () => {
    vi.useFakeTimers()
    render(<FocusGateDemo />)

    enterFocus()

    expect(screen.getByText('守门中 / no action needed')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '我们是否应该先把专注之门做成飞书产品？' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '封存一个杂念' }))
    fireEvent.change(screen.getByLabelText('封存杂念'), {
      target: { value: '记得确认下周的访谈时间' },
    })
    fireEvent.keyDown(screen.getByLabelText('封存杂念'), { key: 'Enter' })
    expect(screen.getByText('已封存，继续想这一件事。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '打开样机控制' }))
    fireEvent.click(screen.getByRole('button', { name: '触发一次敲门' }))
    expect(screen.getByRole('heading', { name: '有人在敲门' })).toBeInTheDocument()
    expect(screen.getByText(/回滚窗口将在 18 分钟后关闭/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '只起草回复' }))
    expect(screen.getByText('草稿已保存，未发送。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '打开样机控制' }))
    expect(screen.getByRole('button', { name: '敲门已演示' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '关闭样机控制' }))

    fireEvent.click(screen.getByRole('button', { name: '结束本次专注' }))
    expect(screen.getByText('正在完成全时段补偿查询')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1400)
    })

    expect(screen.getByRole('heading', { name: '门已打开' })).toBeInTheDocument()
    expect(screen.getByText('你没有漏掉需要立即处理的事。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '打开交接单' }))
    expect(screen.getByRole('heading', { name: '专注结束后的交接单' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '现在处理' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '今天处理' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '知道即可' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '覆盖与过滤' })).toBeInTheDocument()
  })

  it('removes reassurance immediately when Feishu coverage is unavailable', () => {
    vi.useFakeTimers()
    render(<FocusGateDemo />)

    enterFocus()
    fireEvent.click(screen.getByRole('button', { name: '打开样机控制' }))
    fireEvent.click(screen.getByRole('button', { name: '模拟覆盖中断' }))

    expect(screen.getByText('守门暂停 / coverage unavailable')).toBeInTheDocument()
    expect(screen.queryByText('守门中 / no action needed')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '结束本次专注' }))
    act(() => {
      vi.advanceTimersByTime(1400)
    })

    expect(screen.getByText('飞书覆盖不完整，请先查看缺口。')).toBeInTheDocument()
    expect(screen.queryByText('你没有漏掉需要立即处理的事。')).not.toBeInTheDocument()
  })
})
