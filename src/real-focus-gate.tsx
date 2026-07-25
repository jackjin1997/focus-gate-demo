import {
  ArrowLeft,
  Check,
  ChevronRight,
  Database,
  Eye,
  Fingerprint,
  LockKeyhole,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  authenticateReadPlan,
  registerHumanPresence,
  supportsHumanPresence,
  type ReadRunResult,
} from './human-presence-client'
import { buildLarkAuthCommand } from './lark-auth-command'
import styles from './real-focus-gate.module.css'

interface CapabilityReview {
  id: string
  createdAt: string
  runtime: { address: string; persistence: string }
  lark: {
    cliVersion: string
    profileName?: string | null
    authenticated: boolean
    identity: string
    accountFingerprint: string | null
    messageSearch: boolean
    eventReceiver: boolean
  }
  humanPresence?: {
    registered: boolean
    method: 'passkey'
  }
  boundaries: string[]
}

interface ReadPlanResponse {
  plan: {
    id: string
    digest: string
    startsAt: string
    endsAt: string
    expiresAt: string
    source: string
    scope: string
    accountFingerprint: string | null
    fields: string[]
    exclusions: string[]
    retention: string
    retentionPolicy: string
    writes: number
  }
  approvalNonce: string
}

type Step = 'research' | 'capabilities' | 'plan' | 'reading' | 'complete'

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `请求失败（${response.status}）`)
  }
  return response.json() as Promise<T>
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

export function RealFocusGate() {
  const [step, setStep] = useState<Step>('research')
  const [review, setReview] = useState<CapabilityReview | null>(null)
  const [readPlan, setReadPlan] = useState<ReadPlanResponse | null>(null)
  const [runResult, setRunResult] = useState<ReadRunResult | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const presenceRegistered = review?.humanPresence?.registered === true
  const presenceSupported = supportsHumanPresence()
  const connectionReady = Boolean(
    review?.lark.authenticated
      && review.lark.identity === 'user'
      && review.lark.messageSearch,
  )
  const authCommand = buildLarkAuthCommand(review?.lark.profileName)
  const canRead = connectionReady && presenceRegistered

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [step])

  async function researchCapabilities() {
    setBusy(true)
    setError('')
    try {
      const result = await postJson<CapabilityReview>('/api/capability-reviews')
      setReview(result)
      setStep('capabilities')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '能力研究失败')
    } finally {
      setBusy(false)
    }
  }

  async function previewRead() {
    setBusy(true)
    setError('')
    try {
      const result = await postJson<ReadPlanResponse>('/api/read-plans', {
        lookbackMinutes: 10,
        source: 'all-visible',
        includeAttachments: false,
        retention: 'delete-raw-on-digest',
      })
      setReadPlan(result)
      setAcknowledged(false)
      setStep('plan')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '读取清单生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function establishHumanPresence() {
    setBusy(true)
    setError('')
    try {
      await registerHumanPresence()
      setReview((current) => current ? {
        ...current,
        humanPresence: { registered: true, method: 'passkey' },
      } : current)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Touch ID 门禁建立失败')
    } finally {
      setBusy(false)
    }
  }

  async function approveRead() {
    if (!readPlan || !acknowledged) return
    setBusy(true)
    setError('')
    setStep('reading')
    try {
      const result = await authenticateReadPlan({
        planId: readPlan.plan.id,
        digest: readPlan.plan.digest,
        approvalNonce: readPlan.approvalNonce,
      })
      setRunResult(result)
      setStep('complete')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '读取未完成')
      setStep('plan')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className={styles.root} data-step={step}>
      <header className={styles.wordmark}>
        <LockKeyhole aria-hidden="true" size={17} strokeWidth={1.7} />
        <span>专注之门</span>
        <b>本机真实模式</b>
      </header>

      {step === 'research' && (
        <section className={styles.stage} aria-labelledby="real-research-title">
          <div className={styles.content}>
            <p className={styles.kicker}>连接之前</p>
            <h1 id="real-research-title">先证明这道门守得住</h1>
            <p className={styles.lead}>
              第一步只研究本机运行时、飞书身份和权限。它不会读取任何消息，也不会修改飞书或 macOS。
            </p>

            <div className={styles.boundaryList} aria-label="能力研究范围">
              <BoundaryRow icon={<Database size={18} />} label="本机运行时" value="等待检查" />
              <BoundaryRow icon={<Search size={18} />} label="飞书连接" value="等待审阅" />
              <BoundaryRow icon={<Eye size={18} />} label="消息内容" value="不会读取" />
            </div>

            <div className={styles.actionBlock}>
              <button type="button" className={styles.primaryButton} onClick={researchCapabilities} disabled={busy}>
                {busy ? '正在研究能力' : '开始能力研究'}
                {!busy && <ChevronRight aria-hidden="true" size={18} />}
              </button>
              <span>只运行版本、身份、权限和事件目录检查。</span>
            </div>
            {error && <p className={styles.error} role="alert">{error}</p>}
          </div>
        </section>
      )}

      {step === 'capabilities' && review && (
        <section className={styles.stage} aria-labelledby="capability-title">
          <div className={styles.content}>
            <p className={styles.kicker}>能力研究完成</p>
            <h1 id="capability-title">连接边界已经清楚</h1>
            <p className={styles.lead}>这一步没有读取任何消息。</p>

            <dl className={styles.capabilityLedger}>
              <div><dt>本机 Companion</dt><dd>{review.runtime.address}</dd></div>
              <div><dt>持久化</dt><dd>{review.runtime.persistence}</dd></div>
              <div><dt>飞书 CLI</dt><dd>v{review.lark.cliVersion}</dd></div>
              <div><dt>固定 Profile</dt><dd>{review.lark.profileName ?? '未固定'}</dd></div>
              <div>
                <dt>用户身份</dt>
                <dd>{review.lark.authenticated ? '当前用户身份可用' : '需要重新授权'}</dd>
              </div>
              <div>
                <dt>飞书账户指纹</dt>
                <dd>{review.lark.accountFingerprint ?? '尚未绑定'}</dd>
              </div>
              <div><dt>消息搜索</dt><dd>{review.lark.messageSearch ? '具备权限' : '尚未具备权限'}</dd></div>
              <div><dt>机器人事件</dt><dd>{review.lark.eventReceiver ? '可作延迟加速器' : '未配置'}</dd></div>
              <div>
                <dt>人类在场证明</dt>
                <dd>{presenceRegistered ? '已绑定 Passkey' : '尚未建立'}</dd>
              </div>
            </dl>

            <div className={styles.truthBlock}>
              <ShieldCheck aria-hidden="true" size={20} />
              <div>
                <strong>当前不会承诺完整收件箱覆盖</strong>
                <p>首次读取会验证用户身份的时间窗搜索；机器人事件只作为加速器。</p>
              </div>
            </div>

            {!connectionReady && (
              <section
                className={styles.authRecovery}
                aria-labelledby="lark-auth-recovery-title"
              >
                <h2 id="lark-auth-recovery-title">只需补充消息搜索权限</h2>
                <p>此命令只补充 search:message 权限，不会读取任何消息。</p>
                {authCommand ? (
                  <code>{authCommand}</code>
                ) : (
                  <p className={styles.authUnavailable}>
                    当前能力报告没有固定 Profile，无法安全生成授权命令。请先固定 lark-cli Profile，再重新检查。
                  </p>
                )}
                <p>
                  完成授权不等于批准读取。授权后返回这里并重新检查；后续仍需审阅读取计划，再用 Touch ID 明确批准。
                </p>
              </section>
            )}

            <div className={styles.actionBlock}>
              {!connectionReady ? (
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={researchCapabilities}
                  disabled={busy}
                >
                  {busy ? '正在重新检查' : '重新检查飞书授权'}
                  {!busy && <ChevronRight aria-hidden="true" size={18} />}
                </button>
              ) : !presenceRegistered ? (
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={establishHumanPresence}
                  disabled={busy || !presenceSupported}
                >
                  <Fingerprint aria-hidden="true" size={18} />
                  {busy ? '等待系统确认' : '建立 Touch ID 门禁'}
                </button>
              ) : (
                <button type="button" className={styles.primaryButton} onClick={previewRead} disabled={busy}>
                  {busy ? '正在生成清单' : '审阅首次读取'}
                  {!busy && <ChevronRight aria-hidden="true" size={18} />}
                </button>
              )}
              <span>
                {!connectionReady
                  ? '授权动作在终端中由你执行；这里只会重新检查状态。'
                  : !presenceRegistered
                  ? presenceSupported
                    ? 'Passkey 只用于证明由你本人跨墙。'
                    : '当前浏览器不支持 WebAuthn，真实读取保持关闭。'
                  : '下一步仍不会读取消息。'}
              </span>
            </div>
            {error && <p className={styles.error} role="alert">{error}</p>}
          </div>
        </section>
      )}

      {(step === 'plan' || step === 'reading') && readPlan && (
        <section className={`${styles.stage} ${styles.reviewStage}`} aria-labelledby="read-plan-title">
          <div className={styles.wallLabel}>读取墙 / 等待你授权</div>
          <div className={styles.reviewContent}>
            <button type="button" className={styles.backButton} onClick={() => setStep('capabilities')} disabled={busy}>
              <ArrowLeft aria-hidden="true" size={17} />
              返回能力报告
            </button>
            <p className={styles.kicker}>审阅不是读取</p>
            <h1 id="read-plan-title">这一次，系统准备读取什么</h1>
            <p className={styles.lead}>只有下面这份清单会穿过墙。清单内容发生变化时，原授权自动失效。</p>

            <div className={styles.readManifest}>
              <ManifestRow
                label="时间窗口"
                value={`${formatTime(readPlan.plan.startsAt)} - ${formatTime(readPlan.plan.endsAt)}`}
                detail="最近 10 分钟，仅一次"
              />
              <ManifestRow label="信息源" value={readPlan.plan.source} detail={readPlan.plan.scope} />
              <ManifestRow
                label="读取身份"
                value={readPlan.plan.accountFingerprint ?? '尚未绑定具体飞书用户'}
                detail="切换飞书账户后，这份计划自动失效"
              />
              <ManifestRow label="读取字段" value={readPlan.plan.fields.join('、')} detail="用于去重、分诊和生成交接单" />
              <ManifestRow label="明确排除" value={readPlan.plan.exclusions.join('、')} detail="附件不会下载" />
              <ManifestRow
                label="原文保留"
                value={readPlan.plan.retention}
                detail="正文只在本次进程内存中参与校验，不进入 SQLite"
              />
              <ManifestRow label="外部写入" value={`${readPlan.plan.writes} 项写入`} detail="状态、日程、回复、任务和文档全部关闭" />
            </div>

            <div className={styles.planDigest}>
              <span>计划指纹</span>
              <code>{readPlan.plan.digest}</code>
            </div>

            <label className={styles.consentRow}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                disabled={busy}
              />
              <span>我确认只授权清单中的一次性读取，授权不会包含任何写入</span>
            </label>

            <div className={styles.executeBoundary}>
              <div>
                <strong>
                  {step === 'reading'
                    ? '正在验证本人并执行一次性读取'
                    : canRead
                      ? 'Touch ID 是最后一把钥匙'
                      : !presenceRegistered
                        ? '需要先建立 Touch ID 门禁'
                        : '需要先完成飞书用户授权'}
                </strong>
                <span>
                  {step === 'reading'
                    ? '完成前不会重复执行。'
                    : canRead
                      ? '系统签名只对这枚计划指纹有效。'
                      : !presenceRegistered
                        ? '没有人类在场证明，服务端拒绝读取。'
                        : '当前用户身份或 search:message 权限尚未就绪。'}
                </span>
              </div>
              <button
                type="button"
                className={styles.boundaryButton}
                onClick={approveRead}
                disabled={!acknowledged || busy || !canRead}
              >
                {step === 'reading' ? '等待系统确认' : 'Touch ID 确认并读取'}
                {step !== 'reading' && <ChevronRight aria-hidden="true" size={18} />}
              </button>
            </div>
            {error && <p className={styles.error} role="alert">{error}</p>}
          </div>
        </section>
      )}

      {step === 'complete' && runResult && (
        <section className={styles.stage} aria-labelledby="read-complete-title">
          <div className={styles.content}>
            <p className={styles.kicker}>一次性授权已经失效</p>
            <h1 id="read-complete-title">首次读取已经完成</h1>
            <p className={styles.lead}>本次结果只证明这个有界时间窗口，不会自动扩大为持续读取授权。</p>

            <dl className={styles.resultLedger}>
              <div><dt>发现消息</dt><dd>{runResult.itemCount} 条</dd></div>
              <div><dt>覆盖状态</dt><dd>{runResult.coverage === 'bounded-search-complete' ? '本次分页完成' : '存在缺口'}</dd></div>
              <div>
                <dt>原始正文</dt>
                <dd>{runResult.rawPersisted === false ? '从未写入本地数据库' : runResult.rawDeleted ? '原始正文已清除' : '状态未知'}</dd>
              </div>
            </dl>

            <div className={styles.truthBlock}>
              <Check aria-hidden="true" size={20} />
              <div>
                <strong>下一步仍由你决定</strong>
                <p>正式专注事件会重新生成独立的读取授权，不会复用这次许可。</p>
              </div>
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

function BoundaryRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className={styles.boundaryRow}>
      <span aria-hidden="true">{icon}</span>
      <strong>{label}</strong>
      <b>{value}</b>
    </div>
  )
}

function ManifestRow({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section className={styles.manifestRow}>
      <span>{label}</span>
      <div><strong>{value}</strong><p>{detail}</p></div>
    </section>
  )
}
