import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FocusGateDemo } from './focus-gate-demo'

function enterFocus() {
  fireEvent.change(screen.getByLabelText('写下这段时间唯一要思考的问题'), {
    target: { value: '我们是否应该先把专注之门做成飞书产品？' },
  })
  fireEvent.click(screen.getByRole('button', { name: '开始守门检查' }))
  fireEvent.click(screen.getByRole('button', { name: '我已开启 macOS 专注模式' }))
  fireEvent.click(screen.getByRole('button', { name: '进入专注之门' }))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('FocusGateDemo', () => {
  it('starts with one thought, one time boundary, and no inbox-like prelude', () => {
    render(<FocusGateDemo />)

    expect(screen.getByRole('heading', { name: '这一次，只想清楚一件事。' })).toBeInTheDocument()
    expect(screen.getByLabelText('写下这段时间唯一要思考的问题')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始守门检查' })).toBeEnabled()
    expect(screen.queryByText('飞书（演示界面）')).not.toBeInTheDocument()
    expect(screen.queryByText(/演示信号|门外仍在发生|你的 \+1|同团队/)).not.toBeInTheDocument()
    expect(screen.getByText('仅用于演示，不会修改真实飞书或 macOS 设置。')).toBeInTheDocument()
  })

  it('previews unexecuted custody changes and moves focus with each stage', () => {
    render(<FocusGateDemo />)

    expect(screen.getByRole('heading', { name: '这一次，只想清楚一件事。' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '开始守门检查' }))

    expect(screen.getByRole('heading', { name: '合门前，逐项确认。' })).toHaveFocus()
    expect(screen.getAllByText('演示预览，不会真实建立').length).toBeGreaterThan(0)
    expect(screen.queryByText('演示状态已建立')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '我已开启 macOS 专注模式' }))
    fireEvent.click(screen.getByRole('button', { name: '进入专注之门' }))
    expect(screen.getByRole('heading', { name: '专注之门一期，最该替我守住什么？' })).toHaveFocus()
  })

  it('moves through prepare, preflight, guarding, one knock, and the re-entry digest', () => {
    vi.useFakeTimers()
    render(<FocusGateDemo />)

    enterFocus()

    expect(screen.getByText('守门中，无需处理')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '我们是否应该先把专注之门做成飞书产品？' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '封存一个杂念' }))
    fireEvent.change(screen.getByLabelText('封存杂念'), {
      target: { value: '记得确认下周的访谈时间' },
    })
    fireEvent.keyDown(screen.getByLabelText('封存杂念'), { key: 'Enter' })
    expect(screen.getByText('已封存，继续想这一件事。')).toBeInTheDocument()

    const interruptButton = screen.getByRole('button', { name: '模拟合格敲门' })
    expect(interruptButton).toBeEnabled()
    fireEvent.click(interruptButton)
    expect(screen.getByRole('heading', { name: '有人在敲门' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('同一发布故障在 8 分钟内被 3 人独立报告')

    fireEvent.click(screen.getByRole('button', { name: '保存回复草稿' }))
    expect(screen.getByText('草稿已保存，未发送。')).toBeInTheDocument()

    expect(screen.getByRole('button', { name: '合格敲门已演示' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '结束本次专注' }))
    expect(screen.getByText('正在生成交接单')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1400)
    })

    expect(screen.getByRole('heading', { name: '门已打开' })).toBeInTheDocument()
    expect(screen.getByText('有 1 件事需要你处理，其余消息无需立即处理。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '打开交接单' }))
    expect(screen.getByRole('heading', { name: '专注交接单' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '专注交接单' })).toHaveFocus()
    expect(screen.getByRole('heading', { name: '现在处理' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '今天处理' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '知道即可' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '消息收集与过滤' })).toBeInTheDocument()
    expect(screen.getByText('演示停在这份交接单，不会写入飞书。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /写入/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/飞书待办|飞书文档|已交回飞书/)).not.toBeInTheDocument()
  })

  it('lets the presenter simulate one policy-qualified Knock from focus mode', () => {
    render(<FocusGateDemo />)

    enterFocus()
    fireEvent.click(screen.getByRole('button', { name: '模拟合格敲门' }))

    expect(screen.getByRole('heading', { name: '有人在敲门' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('同一发布故障在 8 分钟内被 3 人独立报告')
    expect(screen.getByRole('button', { name: '开门处理' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '专注后处理' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '保存回复草稿' })).toBeEnabled()
  })

  it('closes the interruption capture with Escape and returns to the focus thought', () => {
    render(<FocusGateDemo />)

    enterFocus()
    const trigger = screen.getByRole('button', { name: '封存一个杂念' })
    fireEvent.click(trigger)
    const input = screen.getByLabelText('封存杂念')
    expect(input).toHaveFocus()

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('removes reassurance immediately when Feishu coverage is unavailable', () => {
    vi.useFakeTimers()
    render(<FocusGateDemo />)

    enterFocus()
    fireEvent.click(screen.getByRole('button', { name: '演示设置' }))
    fireEvent.click(screen.getByRole('button', { name: '模拟消息收集中断' }))

    expect(screen.getByText('守门暂停，消息收集中断')).toBeInTheDocument()
    expect(screen.queryByText('守门中，无需处理')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '结束本次专注' }))
    act(() => {
      vi.advanceTimersByTime(1400)
    })

    expect(screen.getByText('飞书消息收集不完整，请先查看缺口。')).toBeInTheDocument()
    expect(screen.queryByText('你没有漏掉需要立即处理的事。')).not.toBeInTheDocument()
  })

  it('returns an honest empty handoff when no policy-qualified Knock occurred', () => {
    vi.useFakeTimers()
    render(<FocusGateDemo />)

    enterFocus()
    fireEvent.click(screen.getByRole('button', { name: '结束本次专注' }))
    act(() => {
      vi.advanceTimersByTime(1400)
    })

    expect(screen.getByText('你没有漏掉需要立即处理的事。')).toBeInTheDocument()
    expect(screen.getByText('门外无事。此刻没有什么需要你。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '打开交接单' }))
    expect(screen.getByText('门外无事。此刻没有什么需要你。')).toBeInTheDocument()
    expect(screen.queryByText('确认生产发布是否回滚')).not.toBeInTheDocument()
    expect(screen.getByText('0 次，本次未启用')).toBeInTheDocument()
  })

  it('derives the Knock deadline and coverage gap from a non-default FocusEvent', () => {
    vi.useFakeTimers()
    render(<FocusGateDemo />)

    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '09:00' } })
    fireEvent.click(screen.getByRole('button', { name: '25 分钟' }))
    enterFocus()

    fireEvent.click(screen.getByRole('button', { name: '模拟合格敲门' }))
    expect(screen.getByRole('alert')).toHaveTextContent('回滚窗口将在 09:19 关闭')
    expect(screen.getByText('同一事故由 3 人独立报告，且截止时间早于 09:25 开门。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '专注后处理' }))
    fireEvent.click(screen.getByRole('button', { name: '演示设置' }))
    fireEvent.click(screen.getByRole('button', { name: '模拟消息收集中断' }))
    fireEvent.click(screen.getByRole('button', { name: '结束本次专注' }))
    act(() => {
      vi.advanceTimersByTime(1400)
    })
    fireEvent.click(screen.getByRole('button', { name: '打开交接单' }))

    expect(screen.getByText('09:15 后的飞书消息收集未完成。下面内容不能代表完整时段。')).toBeInTheDocument()
    expect(screen.getByText('09:15 后的演示数据标记为缺口')).toBeInTheDocument()
  })
})
