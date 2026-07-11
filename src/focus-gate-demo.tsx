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

type Stage = 'prepare' | 'arming' | 'guarding' | 'knock' | 'closing' | 'reentry' | 'digest'
type Coverage = 'verified' | 'degraded'

const DEFAULT_THOUGHT = '我们是否应该把 Decision Theatre 先做成飞书专注产品？'

function addMinutes(time: string, minutes: number) {
  const [hours, minute] = time.split(':').map(Number)
  const total = (hours * 60 + minute + minutes) % (24 * 60)
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
  const captureRef = useRef<HTMLInputElement>(null)

  const endTime = useMemo(() => addMinutes(startTime, duration), [duration, startTime])

  useEffect(() => {
    if (!captureOpen) return
    captureRef.current?.focus()
  }, [captureOpen])

  useEffect(() => {
    if (stage !== 'closing') return
    const timer = window.setTimeout(() => setStage('reentry'), 1200)
    return () => window.clearTimeout(timer)
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
    setCaptureOpen(false)
    setToast('已封存，继续想这一件事。')
  }

  function triggerKnock() {
    if (knockUsed) return
    setKnockUsed(true)
    setDemoControlsOpen(false)
    setStage('knock')
    setToast('')
  }

  function holdKnock(message: string) {
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
    setMuteConfirmed(false)
  }

  return (
    <main className={styles.root} data-stage={stage}>
      <div className={styles.prototypeNotice}>
        <span className={styles.prototypeLabel}>体验样机</span>
        <span>体验样机，不会真实修改飞书状态、日历或消息。</span>
      </div>

      {stage === 'prepare' && (
        <section className={`${styles.stage} ${styles.prepareStage}`} aria-labelledby="prepare-title">
          <header className={styles.wordmark}>
            <LockKeyhole aria-hidden="true" size={17} strokeWidth={1.7} />
            <span>专注之门</span>
          </header>

          <div className={styles.prepareContent}>
            <p className={styles.kicker}>把看守交出去，把注意力留下来。</p>
            <h1 id="prepare-title" className={styles.prepareTitle}>
              这一次，只想清楚一件事。
            </h1>

            <div className={styles.thoughtField}>
              <label htmlFor="focus-thought">这次要想清楚的问题</label>
              <textarea
                id="focus-thought"
                rows={3}
                value={thought}
                onChange={(event) => setThought(event.target.value)}
                placeholder="写下一个真正值得被保护的问题"
              />
              <p>门内只保留这一个问题。你可以继续写，但不会出现新的任务。</p>
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
                <span>保护时长</span>
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
                <span>本次守门范围</span>
                <span>{startTime} - {endTime}</span>
              </div>
              <div className={styles.contractRow}>
                <CalendarDays aria-hidden="true" size={18} strokeWidth={1.6} />
                <span>飞书状态与专注日程</span>
                <strong>进入前确认</strong>
              </div>
              <div className={styles.contractRow}>
                <MessageCircle aria-hidden="true" size={18} strokeWidth={1.6} />
                <span>可见消息由守门 Agent 托管</span>
                <strong>仅限本时段</strong>
              </div>
              <div className={styles.contractRow}>
                <ShieldCheck aria-hidden="true" size={18} strokeWidth={1.6} />
                <span>自动回复只确认收到</span>
                <strong>每人最多 1 次</strong>
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
          <div className={styles.wallLabel}>BOUNDARY / PREFLIGHT</div>
          <div className={styles.armingContent}>
            <p className={styles.kicker}>合门前检查</p>
            <h1 id="arming-title" className={styles.stageTitle}>合门前，逐项确认。</h1>
            <p className={styles.stageIntro}>
              这是本地体验结果。样机不会调用飞书，也不会声称网页能静音你的设备。
            </p>

            <div className={styles.preflightList}>
              <PreflightRow
                icon={<ShieldCheck aria-hidden="true" size={19} strokeWidth={1.7} />}
                title={`飞书「专注中」状态到 ${endTime}`}
                detail="样机状态已建立"
                state="ready"
              />
              <PreflightRow
                icon={<CalendarDays aria-hidden="true" size={19} strokeWidth={1.7} />}
                title={`专注日程 ${startTime} - ${endTime}`}
                detail="样机日程已占用"
                state="ready"
              />
              <PreflightRow
                icon={<MessageCircle aria-hidden="true" size={19} strokeWidth={1.7} />}
                title="消息增量扫描基线"
                detail="本地数据已就绪"
                state="ready"
              />
              <PreflightRow
                icon={<LockKeyhole aria-hidden="true" size={19} strokeWidth={1.7} />}
                title="自动回复授权"
                detail="仅确认收到，每人最多 1 次"
                state="ready"
              />
              <PreflightRow
                icon={<BellOff aria-hidden="true" size={19} strokeWidth={1.7} />}
                title="系统静音"
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
                我已手动开启系统专注
              </button>
            )}

            <div className={styles.armingActions}>
              <button type="button" className={styles.textButton} onClick={() => setStage('prepare')}>
                返回修改
              </button>
              {!muteConfirmed && (
                <button type="button" className={styles.secondaryButton} onClick={() => enterFocus(false)}>
                  以未验证静音进入
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
            <span>{muteConfirmed ? '系统专注已手动确认' : '设备静音未验证'}</span>
          </div>

          <div className={styles.focusObject}>
            <h1 id="guarding-title" className={styles.focusQuestion}>{thought}</h1>
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
            <button type="button" className={styles.quietButton} onClick={() => setCaptureOpen(true)}>
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
                  ? '守门中 / no action needed'
                  : '守门暂停 / coverage unavailable'}
              </span>
            </div>
            <button type="button" className={styles.quietButton} onClick={beginExit}>
              结束本次专注
              <DoorOpen aria-hidden="true" size={17} strokeWidth={1.7} />
            </button>
          </div>

          {captureOpen && (
            <div className={styles.captureStage} role="dialog" aria-modal="true" aria-labelledby="capture-title">
              <button
                type="button"
                className={styles.captureClose}
                aria-label="关闭封存杂念"
                onClick={() => setCaptureOpen(false)}
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
        <section className={`${styles.stage} ${styles.knockStage}`} aria-labelledby="knock-title">
          <div className={styles.wallLabel}>BOUNDARY / KNOCK</div>
          <div className={styles.knockContent}>
            <div className={styles.knockMark} aria-hidden="true">
              <AlertTriangle size={22} strokeWidth={1.7} />
            </div>
            <p className={styles.kicker}>一次有界中断</p>
            <h1 id="knock-title" className={styles.stageTitle}>有人在敲门</h1>
            <p className={styles.knockSummary}>
              同一发布故障在 8 分钟内被 3 人升级，回滚窗口将在 18 分钟后关闭，且需要你确认。
            </p>
            <dl className={styles.knockEvidence}>
              <div>
                <dt>为什么现在</dt>
                <dd>等待到专注结束会错过回滚窗口。</dd>
              </div>
              <div>
                <dt>为什么需要你</dt>
                <dd>当前没有其他审批人可以确认回滚。</dd>
              </div>
              <div>
                <dt>守门依据</dt>
                <dd>多人独立升级，同一事故，截止时间早于开门时间。</dd>
              </div>
            </dl>
            <div className={styles.knockActions}>
              <button type="button" className={styles.boundaryButton} onClick={beginExit}>
                开门处理
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => holdKnock('已压到出门，守门继续。')}
              >
                压到出门
              </button>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => {
                  setDraftStored(true)
                  holdKnock('草稿已保存，未发送。')
                }}
              >
                只起草回复
              </button>
            </div>
            <p className={styles.knockFootnote}>这里只解释敲门理由，不会打开完整收件箱。</p>
          </div>
        </section>
      )}

      {stage === 'closing' && (
        <section className={`${styles.stage} ${styles.closingStage}`} aria-labelledby="closing-title">
          <div className={styles.closingSeam} aria-hidden="true" />
          <div className={styles.closingContent}>
            <LockKeyhole aria-hidden="true" size={25} strokeWidth={1.5} />
            <p id="closing-title">正在完成全时段补偿查询</p>
            <span>先关闭守门授权，再封存一份有限交接单。</span>
            <div className={styles.closingTrack} aria-hidden="true"><span /></div>
          </div>
        </section>
      )}

      {stage === 'reentry' && (
        <section className={`${styles.stage} ${styles.reentryStage}`} aria-labelledby="reentry-title">
          <div className={styles.reentryContent}>
            <p className={styles.kicker}>守门已结束</p>
            <h1 id="reentry-title" className={styles.reentryTitle}>门已打开</h1>
            {coverage === 'verified' ? (
              <p className={styles.reassurance}>你没有漏掉需要立即处理的事。</p>
            ) : (
              <div className={styles.coverageWarning} role="alert">
                <ShieldAlert aria-hidden="true" size={20} strokeWidth={1.7} />
                <div>
                  <strong>飞书覆盖不完整，请先查看缺口。</strong>
                  <span>样机模拟了连接中断，因此不会给出完整覆盖承诺。</span>
                </div>
              </div>
            )}

            <div className={styles.sampleLabel}>样例交接摘要</div>
            <div className={styles.summaryGrid}>
              <SummaryItem label="现在处理" value="2" />
              <SummaryItem label="今天处理" value="3" />
              <SummaryItem label="知道即可" value="4 个话题" />
              <SummaryItem label="已代为确认收到" value="5 人" />
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
                重新开始
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
                <p className={styles.kicker}>有限交接单</p>
                <h1 id="digest-title" className={styles.digestTitle}>专注结束后的交接单</h1>
              </div>
              <button type="button" className={styles.textButton} onClick={resetDemo}>
                关闭交接单
              </button>
            </header>

            {coverage === 'degraded' && (
              <div className={styles.digestGap} role="alert">
                <ShieldAlert aria-hidden="true" size={20} strokeWidth={1.7} />
                <div>
                  <strong>覆盖缺口</strong>
                  <p>14:31 后的飞书消息搜索未完成。下面的内容不能代表完整时段。</p>
                </div>
              </div>
            )}

            <DigestSection title="现在处理" count="2">
              <DigestItem
                title="确认生产发布是否回滚"
                meta="15:18 前"
                body="发布窗口仍然开放。建议先核对错误率，再给出回滚决定。"
              />
              <DigestItem
                title="确认客户演示材料"
                meta="16:00 前"
                body="演示负责人需要最终版本选择。没有代理回复或承诺。"
              />
            </DigestSection>

            <DigestSection title="今天处理" count="3">
              <p className={styles.digestParagraph}>
                两项项目跟进和一项日程调整可以在今天处理，均没有早于当前时间的截止点。
              </p>
            </DigestSection>

            <DigestSection title="知道即可" count="4 个话题">
              <div className={styles.topicList}>
                <span>专注之门 MVP 评审</span>
                <span>Decision Theatre 边界模型</span>
                <span>下周用户访谈</span>
                <span>飞书权限申请进度</span>
              </div>
            </DigestSection>

            <DigestSection title="覆盖与过滤" count={coverage === 'verified' ? '完整' : '有缺口'}>
              <dl className={styles.coverageLedger}>
                <div>
                  <dt>消息范围</dt>
                  <dd>{coverage === 'verified' ? `${startTime} - ${endTime} 已完成补偿查询` : '14:31 后未完成补偿查询'}</dd>
                </div>
                <div>
                  <dt>代为确认收到</dt>
                  <dd>5 人，每人最多 1 次，均使用样例模板</dd>
                </div>
                <div>
                  <dt>起草但未发送</dt>
                  <dd>{draftStored ? '1 个草稿' : '无'}</dd>
                </div>
                <div>
                  <dt>原始内容保留</dt>
                  <dd>样机不读取或保留真实内容</dd>
                </div>
              </dl>
            </DigestSection>
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
  state: 'ready' | 'warning'
}) {
  return (
    <div className={styles.preflightRow}>
      <div className={styles.preflightIcon}>{icon}</div>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div className={state === 'ready' ? styles.readyMark : styles.warningMark}>
        {state === 'ready' ? (
          <Check aria-hidden="true" size={17} strokeWidth={1.9} />
        ) : (
          <AlertTriangle aria-hidden="true" size={17} strokeWidth={1.8} />
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
      <button type="button" className={styles.demoControlTrigger} aria-label="打开样机控制" onClick={onOpen}>
        <SlidersHorizontal aria-hidden="true" size={16} strokeWidth={1.7} />
        <span>样机控制</span>
      </button>
    )
  }

  return (
    <aside className={styles.demoControls} aria-label="样机控制">
      <div className={styles.demoControlsHeader}>
        <strong>本地状态模拟</strong>
        <button type="button" aria-label="关闭样机控制" onClick={onClose}>
          <X aria-hidden="true" size={17} strokeWidth={1.7} />
        </button>
      </div>
      <p>这些按钮只改变当前浏览器里的样机状态。</p>
      <button type="button" onClick={onKnock} disabled={knockUsed}>
        {knockUsed ? '敲门已演示' : '触发一次敲门'}
      </button>
      <button type="button" onClick={onDegrade} disabled={coverage === 'degraded'}>
        {coverage === 'degraded' ? '覆盖已中断' : '模拟覆盖中断'}
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
