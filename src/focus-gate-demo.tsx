import {
  AlertTriangle,
  BellOff,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  CornerDownLeft,
  DoorOpen,
  FileText,
  LockKeyhole,
  MessageCircle,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './focus-gate.module.css'

type Stage =
  | 'prepare'
  | 'arming'
  | 'guarding'
  | 'knock'
  | 'closing'
  | 'reentry'
  | 'digest'
type Coverage = 'verified' | 'degraded'

const DEFAULT_THOUGHT = '专注之门一期，最该替我守住什么？'

function addMinutes(time: string, minutes: number) {
  const [hours, minute] = time.split(':').map(Number)
  const day = 24 * 60
  const total = ((hours * 60 + minute + minutes) % day + day) % day
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function FocusGateDemo() {
  const [stage, setStage] = useState<Stage>('prepare')
  const [thought, setThought] = useState(DEFAULT_THOUGHT)
  const [startTime, setStartTime] = useState('14:00')
  const [duration, setDuration] = useState(50)
  const [muteConfirmed, setMuteConfirmed] = useState(false)
  const [coverage, setCoverage] = useState<Coverage>('verified')
  const [captureOpen, setCaptureOpen] = useState(false)
  const [capture, setCapture] = useState('')
  const [captures, setCaptures] = useState<string[]>([])
  const [thinking, setThinking] = useState('')
  const [toast, setToast] = useState('')
  const [demoControlsOpen, setDemoControlsOpen] = useState(false)
  const [knockUsed, setKnockUsed] = useState(false)
  const [draftStored, setDraftStored] = useState(false)
  const [pendingDecision, setPendingDecision] = useState(false)
  const captureRef = useRef<HTMLInputElement>(null)
  const captureDialogRef = useRef<HTMLDivElement>(null)
  const captureTriggerRef = useRef<HTMLButtonElement>(null)

  const endTime = useMemo(() => addMinutes(startTime, duration), [duration, startTime])
  const knockDeadline = useMemo(() => addMinutes(endTime, -6), [endTime])
  const coverageGapTime = useMemo(
    () => addMinutes(startTime, Math.max(1, Math.min(duration - 1, Math.floor(duration * .62)))),
    [duration, startTime],
  )

  useEffect(() => {
    if (!captureOpen) return
    captureRef.current?.focus()
  }, [captureOpen])

  useEffect(() => {
    if (stage !== 'closing') return
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const timer = window.setTimeout(() => setStage('reentry'), reduceMotion ? 80 : 1200)
    return () => window.clearTimeout(timer)
  }, [stage])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [stage])

  useEffect(() => {
    document.querySelector<HTMLElement>('[data-stage-heading]')?.focus()
  }, [stage])

  function startPreflight() {
    if (!thought.trim()) return
    setStage('arming')
  }

  function enterFocus(deviceFocusConfirmed: boolean) {
    setMuteConfirmed(deviceFocusConfirmed)
    setStage('guarding')
    setToast('')
  }

  function storeCapture() {
    const cleanCapture = capture.trim()
    if (!cleanCapture) return
    setCaptures((current) => [...current, cleanCapture])
    setCapture('')
    closeCapture()
    setToast('已封存，继续想这一件事。')
  }

  function closeCapture() {
    setCaptureOpen(false)
    captureTriggerRef.current?.focus()
  }

  function handleCaptureKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeCapture()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = captureDialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled])',
    )
    if (!focusable?.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function triggerKnock() {
    if (knockUsed) return
    setKnockUsed(true)
    setDemoControlsOpen(false)
    setStage('knock')
    setToast('')
  }

  function holdKnock(message: string) {
    setPendingDecision(true)
    setStage('guarding')
    setToast(message)
  }

  function degradeCoverage() {
    setCoverage('degraded')
    setDemoControlsOpen(false)
    setToast('飞书连接已中断，守门承诺立即暂停。')
  }

  function beginExit() {
    setDemoControlsOpen(false)
    setCaptureOpen(false)
    setStage('closing')
    setToast('')
  }

  function openKnock() {
    setPendingDecision(true)
    beginExit()
  }

  function resetDemo() {
    setStage('prepare')
    setCoverage('verified')
    setCaptureOpen(false)
    setCapture('')
    setCaptures([])
    setThinking('')
    setToast('')
    setDemoControlsOpen(false)
    setKnockUsed(false)
    setDraftStored(false)
    setPendingDecision(false)
    setMuteConfirmed(false)
  }

  return (
    <main className={styles.root} data-stage={stage}>
      <div className={styles.prototypeNotice}>
        <span className={styles.prototypeLabel}>演示模式</span>
        <span>仅用于演示，不会修改真实飞书或 macOS 设置。</span>
      </div>

      {stage === 'prepare' && (
        <section className={`${styles.stage} ${styles.prepareStage}`} aria-labelledby="prepare-title">
          <header className={styles.wordmark}>
            <LockKeyhole aria-hidden="true" size={17} strokeWidth={1.7} />
            <span>专注之门</span>
          </header>

          <div className={styles.prepareContent}>
            <p className={styles.kicker}>把看守交出去，把注意力留下来。</p>
            <h1 id="prepare-title" className={styles.prepareTitle} data-stage-heading tabIndex={-1}>
              这一次，只想清楚一件事。
            </h1>

            <div className={styles.thoughtField}>
              <label htmlFor="focus-thought">写下这段时间唯一要思考的问题</label>
              <textarea
                id="focus-thought"
                rows={3}
                value={thought}
                onChange={(event) => setThought(event.target.value)}
                placeholder="写下一个真正值得被保护的问题"
              />
              <p>门内只保留这个问题。新想法会被封存，不会打断当前思考。</p>
            </div>

            <div className={styles.timeBoundary}>
              <div className={styles.timeInputGroup}>
                <label htmlFor="start-time">开始时间</label>
                <input
                  id="start-time"
                  type="time"
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                />
              </div>
              <div className={styles.durationGroup} aria-label="专注时长">
                <span>专注时长</span>
                <div className={styles.durationOptions}>
                  {[25, 50, 90].map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={duration === option ? styles.durationActive : undefined}
                      aria-pressed={duration === option}
                      onClick={() => setDuration(option)}
                    >
                      {option} 分钟
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.endTime}>
                <Clock3 aria-hidden="true" size={17} strokeWidth={1.7} />
                <span>{endTime} 开门</span>
              </div>
            </div>

            <div className={styles.contract} aria-label="本次守门范围">
              <div className={styles.contractHeading}>
                <span>入门检查将确认飞书托管与 macOS 专注模式</span>
                <span>{startTime} - {endTime}</span>
              </div>
            </div>

            <div className={styles.promise}>
              <p>接下来的 {duration} 分钟，只留这一件事。</p>
              <span>门外的消息，我替你守着。</span>
            </div>

            <button
              type="button"
              className={styles.primaryButton}
              onClick={startPreflight}
              disabled={!thought.trim()}
            >
              开始守门检查
              <ChevronRight aria-hidden="true" size={18} strokeWidth={1.8} />
            </button>
          </div>
        </section>
      )}

      {stage === 'arming' && (
        <section className={`${styles.stage} ${styles.armingStage}`} aria-labelledby="arming-title">
          <div className={styles.wallLabel}>边界 / 入门检查</div>
          <div className={styles.armingContent}>
            <p className={styles.kicker}>合门前检查</p>
            <h1 id="arming-title" className={styles.stageTitle} data-stage-heading tabIndex={-1}>合门前，逐项确认。</h1>
            <p className={styles.stageIntro}>
              当前是本地演示。飞书状态、日程和 macOS 专注模式均不会真实改变。
            </p>

            <div className={styles.preflightList}>
              <PreflightRow
                icon={<ShieldCheck aria-hidden="true" size={19} strokeWidth={1.7} />}
                title={`飞书「专注中」状态到 ${endTime}`}
                detail="演示预览，不会真实建立"
                state="preview"
              />
              <PreflightRow
                icon={<CalendarDays aria-hidden="true" size={19} strokeWidth={1.7} />}
                title={`专注日程 ${startTime} - ${endTime}`}
                detail="演示预览，不会真实建立"
                state="preview"
              />
              <PreflightRow
                icon={<MessageCircle aria-hidden="true" size={19} strokeWidth={1.7} />}
                title="消息收集起点"
                detail="演示预览，不会真实建立"
                state="preview"
              />
              <PreflightRow
                icon={<LockKeyhole aria-hidden="true" size={19} strokeWidth={1.7} />}
                title="Agent 代回授权"
                detail="本次未启用；如启用仅确认收到"
                state="preview"
              />
              <PreflightRow
                icon={<BellOff aria-hidden="true" size={19} strokeWidth={1.7} />}
                title="macOS 专注模式"
                detail={muteConfirmed ? '已由你手动确认' : '网页无法验证，需要你手动开启'}
                state={muteConfirmed ? 'ready' : 'warning'}
              />
            </div>

            {!muteConfirmed && (
              <button
                type="button"
                className={styles.manualConfirmButton}
                onClick={() => setMuteConfirmed(true)}
              >
                <Check aria-hidden="true" size={17} strokeWidth={1.8} />
                我已开启 macOS 专注模式
              </button>
            )}

            <div className={styles.armingActions}>
              <button type="button" className={styles.textButton} onClick={() => setStage('prepare')}>
                返回修改
              </button>
              {!muteConfirmed && (
                <button type="button" className={styles.secondaryButton} onClick={() => enterFocus(false)}>
                  暂不确认，继续演示
                </button>
              )}
              <button
                type="button"
                className={styles.boundaryButton}
                onClick={() => enterFocus(muteConfirmed)}
                disabled={!muteConfirmed}
              >
                进入专注之门
                <ChevronRight aria-hidden="true" size={18} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </section>
      )}

      {stage === 'guarding' && (
        <section className={`${styles.stage} ${styles.guardingStage}`} aria-labelledby="guarding-title">
          <div className={styles.focusTopline}>
            <span>{endTime} 开门</span>
            <span>{muteConfirmed ? 'macOS 专注模式已确认' : 'macOS 专注模式未确认'}</span>
          </div>

          <div className={styles.focusObject}>
            <h1 id="guarding-title" className={styles.focusQuestion} data-stage-heading tabIndex={-1}>{thought}</h1>
            <div className={styles.thinkingSurface}>
              <label htmlFor="thinking-surface">当前思考</label>
              <textarea
                id="thinking-surface"
                value={thinking}
                onChange={(event) => setThinking(event.target.value)}
                placeholder="从此刻最重要的判断开始写…"
              />
            </div>
          </div>

          <div className={styles.focusUtilities}>
            <button
              ref={captureTriggerRef}
              type="button"
              className={styles.quietButton}
              onClick={() => setCaptureOpen(true)}
            >
              <CornerDownLeft aria-hidden="true" size={17} strokeWidth={1.7} />
              封存一个杂念
            </button>
            <div
              className={`${styles.guardState} ${coverage === 'degraded' ? styles.guardStateDegraded : ''}`}
              role="status"
            >
              {coverage === 'verified' ? (
                <ShieldCheck aria-hidden="true" size={17} strokeWidth={1.7} />
              ) : (
                <ShieldAlert aria-hidden="true" size={17} strokeWidth={1.7} />
              )}
              <span>
                {coverage === 'verified'
                  ? '守门中，无需处理'
                  : '守门暂停，消息收集中断'}
              </span>
            </div>
            <button type="button" className={styles.quietButton} onClick={beginExit}>
              结束本次专注
              <DoorOpen aria-hidden="true" size={17} strokeWidth={1.7} />
            </button>
          </div>

          {captureOpen && (
            <div
              ref={captureDialogRef}
              className={styles.captureStage}
              role="dialog"
              aria-modal="true"
              aria-labelledby="capture-title"
              onKeyDown={handleCaptureKeyDown}
            >
              <button
                type="button"
                className={styles.captureClose}
                aria-label="关闭封存杂念"
                onClick={closeCapture}
              >
                <X aria-hidden="true" size={20} strokeWidth={1.7} />
              </button>
              <div className={styles.captureContent}>
                <p id="capture-title">先把它放在门边。</p>
                <label htmlFor="capture-input">封存杂念</label>
                <input
                  ref={captureRef}
                  id="capture-input"
                  value={capture}
                  onChange={(event) => setCapture(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    storeCapture()
                  }}
                  placeholder="写下一句话，然后按 Enter 回去"
                />
                <span>它不会变成任务，也不会触发 Agent 工作。</span>
              </div>
            </div>
          )}

          <PrototypeControls
            open={demoControlsOpen}
            knockUsed={knockUsed}
            coverage={coverage}
            onOpen={() => setDemoControlsOpen(true)}
            onClose={() => setDemoControlsOpen(false)}
            onKnock={triggerKnock}
            onDegrade={degradeCoverage}
          />
        </section>
      )}

      {stage === 'knock' && (
        <section
          className={`${styles.stage} ${styles.knockStage}`}
          aria-labelledby="knock-title"
          aria-describedby="knock-message"
        >
          <div className={styles.wallLabel}>边界 / 敲门</div>
          <div className={styles.knockContent}>
            <div className={styles.knockMark} aria-hidden="true">
              <AlertTriangle size={22} strokeWidth={1.7} />
            </div>
            <p className={styles.kicker}>模拟一次合格敲门</p>
            <h1
              id="knock-title"
              className={styles.stageTitle}
              data-stage-heading
              tabIndex={-1}
            >
              有人在敲门
            </h1>
            <div id="knock-message" className={styles.mockInterruption} role="alert">
              <div className={styles.mockInterruptionMeta}>
                <MessageCircle aria-hidden="true" size={17} strokeWidth={1.7} />
                <span>发布故障出现重复升级：</span>
              </div>
              <p>同一发布故障在 8 分钟内被 3 人独立报告，回滚窗口将在 {knockDeadline} 关闭，且只有你拥有发布权限。</p>
            </div>
            <dl className={styles.knockEvidence}>
              <div>
                <dt>为什么现在</dt>
                <dd>回滚窗口将在专注结束前关闭，继续等待会失去处理窗口。</dd>
              </div>
              <div>
                <dt>为什么需要你</dt>
                <dd>当前只有你拥有发布权限，无法由其他人替代。</dd>
              </div>
              <div>
                <dt>守门依据</dt>
                <dd>同一事故由 3 人独立报告，且截止时间早于 {endTime} 开门。</dd>
              </div>
            </dl>
            <div className={styles.knockActions}>
              <button type="button" className={styles.boundaryButton} onClick={openKnock}>
                开门处理
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => holdKnock('已留到专注结束后处理。')}
              >
                专注后处理
              </button>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => {
                  setDraftStored(true)
                  holdKnock('草稿已保存，未发送。')
                }}
              >
                保存回复草稿
              </button>
            </div>
            <p className={styles.knockFootnote}>演示使用本地固定数据，不读取真实飞书消息。</p>
          </div>
        </section>
      )}

      {stage === 'closing' && (
        <section className={`${styles.stage} ${styles.closingStage}`} aria-labelledby="closing-title">
          <div className={styles.closingSeam} aria-hidden="true" />
          <div className={styles.closingContent}>
            <LockKeyhole aria-hidden="true" size={25} strokeWidth={1.5} />
            <p id="closing-title" data-stage-heading tabIndex={-1}>正在生成交接单</p>
            <span>正在结束守门，并整理这段时间的消息。</span>
            <div className={styles.closingTrack} aria-hidden="true"><span /></div>
          </div>
        </section>
      )}

      {stage === 'reentry' && (
        <section className={`${styles.stage} ${styles.reentryStage}`} aria-labelledby="reentry-title">
          <div className={styles.reentryContent}>
            <p className={styles.kicker}>守门已结束</p>
            <h1 id="reentry-title" className={styles.reentryTitle} data-stage-heading tabIndex={-1}>门已打开</h1>
            {coverage === 'verified' ? (
              <p className={styles.reassurance}>
                {pendingDecision
                  ? '有 1 件事需要你处理，其余消息无需立即处理。'
                  : '你没有漏掉需要立即处理的事。'}
              </p>
            ) : (
              <div className={styles.coverageWarning} role="alert">
                <ShieldAlert aria-hidden="true" size={20} strokeWidth={1.7} />
                <div>
                  <strong>飞书消息收集不完整，请先查看缺口。</strong>
                  <span>演示模拟了连接中断，因此不会给出完整收集承诺。</span>
                </div>
              </div>
            )}

            <div className={styles.sampleLabel}>专注交接摘要</div>
            <div className={styles.summaryHandoff}>
              <div className={styles.summaryPrimary}>
                <span>现在处理</span>
                <strong>{pendingDecision ? '1 件' : '0 件'}</strong>
                <p>{pendingDecision ? '确认线上登录故障是否回滚' : '门外无事。此刻没有什么需要你。'}</p>
              </div>
              <div className={styles.summarySecondary}>
                <SummaryItem label="今天处理" value="2 项" />
                <SummaryItem label="知道即可" value="2 个话题" />
                <SummaryItem label="Agent 代回" value="0 次" />
              </div>
            </div>

            <div className={styles.reentryMeta}>
              <span>{startTime} - {endTime}</span>
              <span>{captures.length} 条杂念已封存</span>
              <span>{draftStored ? '1 个草稿未发送' : '没有待发送草稿'}</span>
            </div>

            <div className={styles.reentryActions}>
              <button type="button" className={styles.primaryButton} onClick={() => setStage('digest')}>
                打开交接单
                <FileText aria-hidden="true" size={18} strokeWidth={1.7} />
              </button>
              <button type="button" className={styles.textButton} onClick={resetDemo}>
                重新演示
              </button>
            </div>
          </div>
        </section>
      )}

      {stage === 'digest' && (
        <section className={`${styles.stage} ${styles.digestStage}`} aria-labelledby="digest-title">
          <div className={styles.digestContent}>
            <header className={styles.digestHeader}>
              <div>
                <h1 id="digest-title" className={styles.digestTitle} data-stage-heading tabIndex={-1}>专注交接单</h1>
              </div>
              <button type="button" className={styles.textButton} onClick={resetDemo}>
                重新演示
              </button>
            </header>

            {coverage === 'degraded' && (
              <div className={styles.digestGap} role="alert">
                <ShieldAlert aria-hidden="true" size={20} strokeWidth={1.7} />
                <div>
                  <strong>消息收集缺口</strong>
                  <p>{coverageGapTime} 后的飞书消息收集未完成。下面内容不能代表完整时段。</p>
                </div>
              </div>
            )}

            <DigestSection title="现在处理" count={pendingDecision ? '1' : '0'}>
              {pendingDecision ? (
                <DigestItem
                  title="确认生产发布是否回滚"
                  meta="开门前"
                  body="发布窗口仍然开放。建议先核对错误率，再给出回滚决定。"
                />
              ) : (
                <p className={styles.digestParagraph}>门外无事。此刻没有什么需要你。</p>
              )}
            </DigestSection>

            <DigestSection title="今天处理" count="2">
              <p className={styles.digestParagraph}>
                另外 2 件事今天处理即可，当前都未逾期。
              </p>
            </DigestSection>

            <DigestSection title="知道即可" count="2 个话题">
              <div className={styles.topicList}>
                <span>专注之门一期评审</span>
                <span>守门边界模型</span>
              </div>
            </DigestSection>

            <DigestSection title="消息收集与过滤" count={coverage === 'verified' ? '完整' : '有缺口'}>
              <dl className={styles.coverageLedger}>
                <div>
                  <dt>消息范围</dt>
                  <dd>{coverage === 'verified' ? `${startTime} - ${endTime} 演示数据已对账` : `${coverageGapTime} 后的演示数据标记为缺口`}</dd>
                </div>
                <div>
                  <dt>Agent 代回</dt>
                  <dd>0 次，本次未启用</dd>
                </div>
                <div>
                  <dt>起草但未发送</dt>
                  <dd>{draftStored ? '1 个草稿' : '无'}</dd>
                </div>
                <div>
                  <dt>原始内容保留</dt>
                  <dd>演示不读取或保留真实内容</dd>
                </div>
              </dl>
            </DigestSection>

            <div className={styles.digestExecutionBoundary}>
              <div>
                <span>演示边界</span>
                <strong>演示停在这份交接单，不会写入飞书。</strong>
                <p>任务、文档和回复等外部动作不在这次一期样机中执行。</p>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">
        {toast}
      </div>
    </main>
  )
}

function PreflightRow({
  icon,
  title,
  detail,
  state,
}: {
  icon: React.ReactNode
  title: string
  detail: string
  state: 'ready' | 'warning' | 'preview'
}) {
  return (
    <div className={styles.preflightRow}>
      <div className={styles.preflightIcon}>{icon}</div>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div className={state === 'ready' ? styles.readyMark : state === 'warning' ? styles.warningMark : styles.previewMark}>
        {state === 'ready' ? (
          <Check aria-hidden="true" size={17} strokeWidth={1.9} />
        ) : state === 'warning' ? (
          <AlertTriangle aria-hidden="true" size={17} strokeWidth={1.8} />
        ) : (
          <span aria-hidden="true">—</span>
        )}
      </div>
    </div>
  )
}

function PrototypeControls({
  open,
  knockUsed,
  coverage,
  onOpen,
  onClose,
  onKnock,
  onDegrade,
}: {
  open: boolean
  knockUsed: boolean
  coverage: Coverage
  onOpen: () => void
  onClose: () => void
  onKnock: () => void
  onDegrade: () => void
}) {
  if (!open) {
    return (
      <div className={styles.demoControlCluster}>
        <button
          type="button"
          className={styles.demoInterruptTrigger}
          aria-label={knockUsed ? '合格敲门已演示' : '模拟合格敲门'}
          title={knockUsed ? '合格敲门已演示' : '模拟合格敲门'}
          onClick={onKnock}
          disabled={knockUsed}
        >
          <AlertTriangle aria-hidden="true" size={16} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          className={styles.demoControlTrigger}
          aria-label="演示设置"
          title="演示设置"
          onClick={onOpen}
        >
          <SlidersHorizontal aria-hidden="true" size={16} strokeWidth={1.7} />
        </button>
      </div>
    )
  }

  return (
    <aside className={styles.demoControls} aria-label="演示设置">
      <div className={styles.demoControlsHeader}>
        <strong>演示状态</strong>
        <button type="button" aria-label="关闭演示设置" onClick={onClose}>
          <X aria-hidden="true" size={17} strokeWidth={1.7} />
        </button>
      </div>
      <p>这里只改变当前浏览器里的演示状态。</p>
      <button type="button" onClick={onDegrade} disabled={coverage === 'degraded'}>
        {coverage === 'degraded' ? '消息收集已中断' : '模拟消息收集中断'}
      </button>
    </aside>
  )
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.summaryItem}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function DigestSection({
  title,
  count,
  children,
}: {
  title: string
  count: string
  children: React.ReactNode
}) {
  return (
    <section className={styles.digestSection}>
      <header>
        <h2>{title}</h2>
        <span>{count}</span>
      </header>
      <div>{children}</div>
    </section>
  )
}

function DigestItem({ title, meta, body }: { title: string; meta: string; body: string }) {
  return (
    <article className={styles.digestItem}>
      <div>
        <h3>{title}</h3>
        <span>{meta}</span>
      </div>
      <p>{body}</p>
    </article>
  )
}
