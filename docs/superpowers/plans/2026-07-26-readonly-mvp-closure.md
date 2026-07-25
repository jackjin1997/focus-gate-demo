# 专注之门只读 MVP 收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复真实 Lark CLI 身份契约、OAuth 恢复指引和视觉 QA，补齐独立仓库 CI/文档，并完成本机与公开样机交付验证。

**Architecture:** 保留 React → 回环 Hono API → Application → LarkCliAdapter → SQLite 的既有边界。外部契约漂移只在 CLI adapter/parser 内规范化；OAuth 恢复命令由纯函数生成；视觉 QA 用独立的受管预览进程封装，始终在 `finally` 中清理。

**Tech Stack:** TypeScript 5、React 19、Hono、Vitest、Playwright、Vite、Node.js 24/25、pnpm 10、lark-cli 1.x、GitHub Actions、Vercel。

---

## 文件结构

本计划创建或修改以下文件：

- `server/infrastructure/lark-cli/commands.ts`：声明唯一允许的只读能力研究 argv。
- `server/infrastructure/lark-cli/parsers.ts`：兼容历史与当前 CLI JSON，并在身份不确定时失败关闭。
- `server/infrastructure/lark-cli/lark-cli-adapter.test.ts`：用真实 1.0.68 形状和历史形状锁定适配器契约。
- `src/lark-auth-command.ts`：纯函数、安全渲染固定 profile 的最小 OAuth 命令。
- `src/lark-auth-command.test.ts`：命令渲染和 shell quoting 测试。
- `src/real-focus-gate.tsx`：OAuth 缺失时显示精确、非自动执行的恢复指引。
- `src/real-focus-gate.test.tsx`：证明读取墙关闭且只显示固定 profile 命令。
- `src/real-focus-gate.module.css`：为恢复指引增加现有视觉语言内的样式。
- `scripts/managed-preview.ts`：启动、探活和关闭临时 Vite preview。
- `scripts/managed-preview.test.ts`：预览生命周期、失败和外部 URL 路径测试。
- `scripts/visual-qa.ts`：从现有 `.mjs` 迁移，接入受管预览并保证清理。
- `package.json`：用 `tsx` 运行 TypeScript 视觉 QA。
- `.github/workflows/ci.yml`：无凭据测试、类型检查和构建。
- `README.md`：独立仓库边界、OAuth、QA 和 CI 说明。
- `docs/jack_todo.html`：同步每个已验证交付项。

## Task 1: 修复 Lark CLI 能力研究契约

**Files:**

- Modify: `server/infrastructure/lark-cli/commands.ts`
- Modify: `server/infrastructure/lark-cli/parsers.ts`
- Modify: `server/infrastructure/lark-cli/lark-cli-adapter.test.ts`

- [ ] **Step 1: 写当前 1.0.68 契约的失败测试**

在 `LarkCliAdapter capability review` 中新增用例，夹具使用当前真实结构：

```typescript
it('normalizes current auth status and scopes without treating a ready bot as user auth', async () => {
  const runner = new RecordingRunner([
    success('lark-cli version 1.0.68'),
    success({
      identity: 'bot',
      verified: true,
      identities: {
        bot: { status: 'ready', openId: 'ou_bot' },
        user: {
          status: 'missing',
          userName: 'remembered user',
          openId: 'ou_remembered',
        },
      },
    }),
    success({
      appId: 'cli_app',
      tokenType: 'tenant',
      userScopes: ['search:message', 'im:message:readonly'],
    }),
    success([{ key: 'im.message.receive_v1' }]),
  ])

  const review = await new LarkCliAdapter({ runner }).reviewCapabilities()

  expect(review).toEqual({
    cliVersion: '1.0.68',
    profileName: null,
    authenticated: false,
    identity: 'bot',
    userOpenId: null,
    scopes: ['im:message:readonly', 'search:message'],
    eventKeys: ['im.message.receive_v1'],
  })
  expect(JSON.stringify(review)).not.toContain('ou_remembered')
})
```

再新增有效用户用例：

```typescript
it('uses a verified ready user even when the profile default is bot', async () => {
  const runner = new RecordingRunner([
    success('lark-cli version 1.0.68'),
    success({
      identity: 'bot',
      verified: true,
      identities: {
        bot: { status: 'ready' },
        user: { status: 'ready', openId: 'ou_active' },
      },
    }),
    success({ userScopes: ['search:message'] }),
    success([]),
  ])

  await expect(new LarkCliAdapter({ runner }).reviewCapabilities()).resolves.toMatchObject({
    authenticated: true,
    identity: 'user',
    userOpenId: 'ou_active',
  })
})
```

再增加失败关闭表驱动用例：

```typescript
it.each([
  [{ status: 'unknown', openId: 'ou_user' }, true],
  [{ status: 'ready', openId: 'ou_user' }, false],
  [{ status: 'ready' }, true],
])('fails closed for an unusable nested user identity', async (user, verified) => {
  const runner = new RecordingRunner([
    success('lark-cli version 1.0.68'),
    success({
      identity: 'bot',
      verified,
      identities: { bot: { status: 'ready' }, user },
    }),
    success({ data: { userScopes: ['search:message'] } }),
    success([]),
  ])

  await expect(new LarkCliAdapter({ runner }).reviewCapabilities()).resolves.toMatchObject({
    authenticated: false,
    userOpenId: null,
  })
})
```

这个夹具同时覆盖历史 `data.userScopes` 信封；前两个用例覆盖当前顶层 `userScopes`。

更新已有 argv 断言，要求：

```typescript
['auth', 'status', '--json', '--verify']
['auth', 'scopes', '--json']
```

- [ ] **Step 2: 运行定向测试，确认红灯**

Run:

```bash
pnpm vitest run server/infrastructure/lark-cli/lark-cli-adapter.test.ts
```

Expected: FAIL；当前命令缺少 `--json --verify`，嵌套用户结构不能被正确规范化。

- [ ] **Step 3: 更新只读命令 argv**

在 `CAPABILITY_INVOCATIONS` 中使用：

```typescript
export const CAPABILITY_INVOCATIONS = Object.freeze([
  ['capabilities.version', invocation(['--version'])],
  [
    'capabilities.auth-status',
    invocation(['auth', 'status', '--json', '--verify']),
  ],
  ['capabilities.scopes', invocation(['auth', 'scopes', '--json'])],
  ['capabilities.events', invocation(['event', 'list', '--json'])],
] satisfies ReadonlyArray<readonly [LarkCliOperation, CommandInvocation]>)
```

- [ ] **Step 4: 实现版本兼容身份规范化**

在 `parsers.ts` 中增加内部辅助类型和函数：

```typescript
const nestedIdentity = (
  authStatus: JsonRecord,
  kind: 'user' | 'bot',
): JsonRecord => {
  const identities = isRecord(authStatus.identities)
    ? authStatus.identities
    : {}
  return isRecord(identities[kind]) ? identities[kind] : {}
}

const isReady = (identity: JsonRecord): boolean =>
  identity.status === 'ready'

const normalizeCapabilityIdentity = (
  authStatus: JsonRecord,
): Pick<CapabilityReview, 'authenticated' | 'identity' | 'userOpenId'> => {
  const currentIdentity = normalizeIdentity(authStatus.identity)
  const user = nestedIdentity(authStatus, 'user')
  const hasNestedContract = isRecord(authStatus.identities)
  const userReady = isReady(user)
  const verified = authStatus.verified !== false

  if (hasNestedContract) {
    const userOpenId = userReady && verified
      ? firstString(user.openId, user.open_id)
      : undefined
    const authenticated = userReady
      && verified
      && userOpenId !== undefined
    return {
      authenticated,
      identity: authenticated ? 'user' : currentIdentity,
      userOpenId: authenticated ? userOpenId : null,
    }
  }

  const legacyUserOpenId = currentIdentity === 'user'
    ? firstString(authStatus.userOpenId, authStatus.user_open_id)
    : undefined
  return {
    authenticated: legacyUserOpenId !== undefined,
    identity: currentIdentity,
    userOpenId: legacyUserOpenId ?? null,
  }
}
```

让 `parseCapabilityReview` 使用该结果，scope 继续兼容顶层和信封：

```typescript
const capabilityIdentity = normalizeCapabilityIdentity(authStatus)
const scopeData = isRecord(scopeEnvelope.data)
  ? scopeEnvelope.data
  : scopeEnvelope
const scopes = Array.isArray(scopeData.userScopes)
  ? scopeData.userScopes
  : scopeData.scopes

return {
  cliVersion: extractVersion(outputs.version),
  ...capabilityIdentity,
  scopes: Object.freeze(uniqueStrings(scopes).sort()),
  eventKeys: Object.freeze(extractEventKeys(eventEnvelope).sort()),
}
```

- [ ] **Step 5: 运行适配器与全量测试**

Run:

```bash
pnpm vitest run server/infrastructure/lark-cli/lark-cli-adapter.test.ts
pnpm test
```

Expected: 适配器测试和全部测试 PASS；历史顶层身份夹具仍通过。

- [ ] **Step 6: 提交 CLI 修复**

```bash
git add server/infrastructure/lark-cli/commands.ts \
  server/infrastructure/lark-cli/parsers.ts \
  server/infrastructure/lark-cli/lark-cli-adapter.test.ts
git commit -m "fix: support current lark cli auth contract"
```

## Task 2: 增加安全、精确的 OAuth 恢复指引

**Files:**

- Create: `src/lark-auth-command.ts`
- Create: `src/lark-auth-command.test.ts`
- Modify: `src/real-focus-gate.tsx`
- Modify: `src/real-focus-gate.test.tsx`
- Modify: `src/real-focus-gate.module.css`

- [ ] **Step 1: 写命令渲染失败测试**

```typescript
import { describe, expect, it } from 'vitest'
import { buildLarkAuthCommand } from './lark-auth-command'

describe('buildLarkAuthCommand', () => {
  it('pins the reviewed profile and grants only message search', () => {
    expect(buildLarkAuthCommand('focus-profile')).toBe(
      "lark-cli --profile 'focus-profile' auth login --scope 'search:message'",
    )
  })

  it('quotes profile names without creating a shell injection suffix', () => {
    expect(buildLarkAuthCommand("team'; touch /tmp/nope; '")).toBe(
      "lark-cli --profile 'team'\\''; touch /tmp/nope; '\\''' auth login --scope 'search:message'",
    )
  })

  it('returns null when no profile was pinned', () => {
    expect(buildLarkAuthCommand(null)).toBeNull()
  })
})
```

- [ ] **Step 2: 写 OAuth 缺失 UI 的失败测试**

扩展 `keeps the read wall closed...` 用例：

```typescript
expect(screen.getByText('只需补充消息搜索权限')).toBeInTheDocument()
expect(screen.getByText(
  "lark-cli --profile 'focus-profile' auth login --scope 'search:message'",
)).toBeInTheDocument()
expect(screen.getByText('完成登录不等于批准读取')).toBeInTheDocument()
expect(fetchMock).toHaveBeenCalledTimes(1)
expect(authenticateReadPlan).not.toHaveBeenCalled()
```

- [ ] **Step 3: 运行定向测试，确认红灯**

Run:

```bash
pnpm vitest run src/lark-auth-command.test.ts src/real-focus-gate.test.tsx
```

Expected: FAIL；纯函数和恢复指引尚不存在。

- [ ] **Step 4: 实现安全 shell quoting 纯函数**

```typescript
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`

export function buildLarkAuthCommand(
  profileName: string | null | undefined,
): string | null {
  if (!profileName) return null
  return [
    'lark-cli',
    '--profile',
    shellQuote(profileName),
    'auth',
    'login',
    '--scope',
    shellQuote('search:message'),
  ].join(' ')
}
```

- [ ] **Step 5: 在能力结果页显示恢复边界**

在 `RealFocusGate` 中计算：

```typescript
const authCommand = buildLarkAuthCommand(review?.lark.profileName)
```

当 `connectionReady` 为假时，在“重新检查飞书授权”按钮上方显示：

```tsx
<section className={styles.authRecovery} aria-labelledby="auth-recovery-title">
  <div>
    <strong id="auth-recovery-title">只需补充消息搜索权限</strong>
    <p>命令固定到本次能力研究锁定的 Profile；它不会读取消息。</p>
  </div>
  {authCommand && <code>{authCommand}</code>}
  <small>完成登录不等于批准读取。请回到这里重新检查，读取仍需审阅清单和 Touch ID。</small>
</section>
```

样式只使用现有暖色背景、边线、墨色文字和语义绿色，不新增品牌色。

- [ ] **Step 6: 运行 UI 测试和类型检查**

Run:

```bash
pnpm vitest run src/lark-auth-command.test.ts src/real-focus-gate.test.tsx
pnpm typecheck
```

Expected: PASS；OAuth 缺失时没有读取计划按钮或自动认证调用。

- [ ] **Step 7: 提交 OAuth 指引**

```bash
git add src/lark-auth-command.ts src/lark-auth-command.test.ts \
  src/real-focus-gate.tsx src/real-focus-gate.test.tsx \
  src/real-focus-gate.module.css
git commit -m "feat: guide minimal lark user authorization"
```

## Task 3: 让视觉 QA 自主管理预览服务

**Files:**

- Create: `scripts/managed-preview.ts`
- Create: `scripts/managed-preview.test.ts`
- Delete: `scripts/visual-qa.mjs`
- Create: `scripts/visual-qa.ts`
- Modify: `package.json`
- Modify: `tsconfig.server.json`

- [ ] **Step 1: 写受管预览生命周期失败测试**

`scripts/managed-preview.test.ts` 使用 Node 环境和可注入依赖：

```typescript
// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { resolveQaTarget } from './managed-preview'

it('uses an external BASE_URL without spawning a process', async () => {
  const spawn = vi.fn()
  const target = await resolveQaTarget({
    baseUrl: 'https://example.test',
    spawn,
    fetch: vi.fn(),
  })

  expect(target.baseUrl).toBe('https://example.test')
  expect(spawn).not.toHaveBeenCalled()
  await target.stop()
})

it('starts vite preview, waits for readiness, and stops it', async () => {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn((signal: string) => {
      queueMicrotask(() => child.emit('close', 0, signal))
      return true
    }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  })
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('not ready'))
    .mockResolvedValue(new Response('ok'))
  const target = await resolveQaTarget({
    spawn: vi.fn(() => child),
    fetch,
    retryDelayMs: 0,
  })

  expect(target.baseUrl).toBe('http://127.0.0.1:4173')
  expect(fetch).toHaveBeenCalledTimes(2)
  await target.stop()
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')
})
```

再增加“进程提前退出”和“探活超时都会杀进程并拒绝”的用例。

- [ ] **Step 2: 运行定向测试，确认红灯**

Run:

```bash
pnpm vitest run scripts/managed-preview.test.ts
```

Expected: FAIL；`resolveQaTarget` 尚不存在。

- [ ] **Step 3: 实现预览进程管理**

`resolveQaTarget` 的公共契约：

```typescript
export interface QaTarget {
  readonly baseUrl: string
  stop(): Promise<void>
}

export async function resolveQaTarget(
  options: ResolveQaTargetOptions = {},
): Promise<QaTarget>
```

默认实现必须：

```typescript
const baseUrl = options.baseUrl ?? 'http://127.0.0.1:4173'
if (options.baseUrl) {
  return { baseUrl, stop: async () => undefined }
}

const child = spawnProcess(
  process.execPath,
  [
    resolve(process.cwd(), 'node_modules/vite/bin/vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '4173',
    '--strictPort',
  ],
  {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  },
)
```

探活只接受 `response.ok`；超时、子进程提前退出或 spawn error 时先终止子进程，再返回固定错误。`stop()` 幂等，先发 `SIGTERM`，在短宽限期后仍未退出则发 `SIGKILL`。

- [ ] **Step 4: 迁移视觉流程并用 `finally` 清理**

把 `scripts/visual-qa.mjs` 迁移到 `scripts/visual-qa.ts`，保持现有截图和断言。入口结构调整为：

```typescript
const target = await resolveQaTarget({ baseUrl: process.env.BASE_URL })
let browser: Browser | undefined

try {
  browser = await chromium.launch(/* existing options */)
  await runFlow(target.baseUrl, { width: 1440, height: 900 }, 'desktop', 'no-preference')
  await runFlow(target.baseUrl, { width: 390, height: 844 }, 'mobile', 'reduce')
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`Visual QA passed. Screenshots: ${outputDir}`)
} finally {
  await browser?.close()
  await target.stop()
}
```

`allowedHosts` 和 `page.goto` 都从 `target.baseUrl` 派生，不能继续引用模块级旧常量。

- [ ] **Step 5: 更新脚本并运行测试**

`package.json`：

```json
"qa:visual": "pnpm build && tsx scripts/visual-qa.ts"
```

把脚本纳入严格类型检查：

```json
"include": ["server", "scripts"]
```

Run:

```bash
pnpm vitest run scripts/managed-preview.test.ts
pnpm test
pnpm build
pnpm qa:visual
```

Expected:

- 单元和全量测试 PASS。
- 构建 PASS。
- 无需手动启动 server，视觉 QA 输出 `Visual QA passed`。
- `/tmp/focus-gate-qa` 中存在桌面和移动端全部截图。

- [ ] **Step 6: 提交视觉 QA 修复**

```bash
git add package.json tsconfig.server.json scripts/managed-preview.ts \
  scripts/managed-preview.test.ts scripts/visual-qa.ts
git add -u scripts/visual-qa.mjs
git commit -m "test: manage visual qa preview lifecycle"
```

## Task 4: 补齐独立仓库 CI 与文档

**Files:**

- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/jack_todo.html`

- [ ] **Step 1: 新增无凭据 CI**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.29.1
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm typecheck
      - run: pnpm build
```

CI 不配置 Lark、Vercel 或 WebAuthn 密钥，不调用真实消息搜索。

- [ ] **Step 2: 更新 README**

README 必须明确写出：

- 独立仓库路径与公开样机。
- 当前 `lark-cli 1.0.68` 已验证，同时保留历史 1.x 解析兼容。
- OAuth 缺失时先在 UI 复制固定 profile 的最小权限命令。
- 登录完成仍需重新能力研究、审阅读取清单和 Touch ID。
- `pnpm qa:visual` 会自动构建，并启动/关闭本地 preview；`BASE_URL=... pnpm qa:visual` 用于外部地址。
- CI 只跑无凭据验证。
- 本轮完成边界和明确延后能力。

- [ ] **Step 3: 解析 workflow 并验证文档命令**

Run:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci.yml"); puts "workflow yaml ok"'
pnpm test
pnpm typecheck
pnpm build
```

Expected: `workflow yaml ok`，随后所有命令 PASS。

- [ ] **Step 4: 更新执行清单**

把 `docs/jack_todo.html` 中已完成的 CLI、OAuth、视觉 QA、文档和质量项移入“已完成”，保留本机安全冒烟与发布项为活跃。

- [ ] **Step 5: 提交 CI 与文档**

```bash
git add .github/workflows/ci.yml README.md docs/jack_todo.html
git commit -m "ci: verify the standalone read-only MVP"
```

## Task 5: 本机真实模式安全冒烟

**Files:**

- Modify: `docs/jack_todo.html`

- [ ] **Step 1: 启动本机真实模式**

Run:

```bash
pnpm local
```

Expected: 构建成功，并输出 `专注之门本机模式已启动：http://localhost:4317`。

- [ ] **Step 2: 验证健康检查不触碰飞书**

Run:

```bash
curl --fail --silent http://localhost:4317/api/health | jq
```

Expected: 返回健康 JSON；服务日志没有 Lark CLI capability 或 message search 调用。

- [ ] **Step 3: 主动执行一次能力研究**

Run:

```bash
curl --fail --silent \
  -X POST \
  -H 'Origin: http://localhost:4317' \
  http://localhost:4317/api/capability-reviews | jq '.lark'
```

Expected: 当前环境明确报告用户 OAuth 缺失或权限未就绪；即使 Bot 可用，`authenticated` 仍为 `false`、`messageSearch` 为 `false`、`accountFingerprint` 为 `null`。

- [ ] **Step 4: 验证读取墙保持关闭**

Run:

```bash
curl --silent \
  -o /tmp/focus-gate-read-plan-response.json \
  -w '%{http_code}\n' \
  -X POST \
  -H 'Origin: http://localhost:4317' \
  -H 'Content-Type: application/json' \
  --data '{"lookbackMinutes":10,"source":"all-visible","includeAttachments":false,"retention":"delete-raw-on-digest"}' \
  http://localhost:4317/api/read-plans
```

Expected: 返回只读计划，但 `plan.accountFingerprint` 为 `null`、`plan.writes` 为 `0`；这是不可批准的审阅产物。没有 `im +messages-search` 子进程调用，没有消息正文落盘。

随后从响应中读取 `plan.id`，请求 Passkey 选项：

```bash
FOCUS_GATE_PLAN_ID=$(jq -r '.plan.id' /tmp/focus-gate-read-plan-response.json)
curl --silent \
  -o /tmp/focus-gate-presence-response.json \
  -w '%{http_code}\n' \
  -X POST \
  -H 'Origin: http://localhost:4317' \
  -H 'Content-Type: application/json' \
  --data '{}' \
  "http://localhost:4317/api/read-plans/${FOCUS_GATE_PLAN_ID}/presence/options"
```

Expected: 没有已注册的人类在场凭据时返回稳定错误；即使本机已有 Passkey，后续批准仍会因计划没有用户身份绑定而失败关闭。不要执行 `/approve`，也不要触发真实消息读取。

- [ ] **Step 5: 验证回环和同源边界**

Run:

```bash
curl --silent \
  -o /tmp/focus-gate-cross-origin-response.json \
  -w '%{http_code}\n' \
  -X POST \
  -H 'Origin: https://attacker.invalid' \
  http://localhost:4317/api/capability-reviews
```

Expected: `403`；应用层能力研究未执行。

- [ ] **Step 6: 停止服务并确认端口释放**

向前台进程发送 `Ctrl-C`，然后：

```bash
curl --silent --max-time 1 http://localhost:4317/api/health
```

Expected: 连接失败；正常关停日志不包含令牌、stderr 或消息正文。

- [ ] **Step 7: 更新执行清单并提交冒烟记录**

在 `docs/jack_todo.html` 中锁定“真实模式安全冒烟”为已完成。

```bash
git add docs/jack_todo.html
git commit -m "docs: record local MVP security verification"
```

## Task 6: 最终验证、推送与公开部署

**Files:**

- Modify: `docs/jack_todo.html`

- [ ] **Step 1: 从干净工作区运行最终验证**

Run:

```bash
git status --short
pnpm test
pnpm typecheck
pnpm build
pnpm qa:visual
```

Expected:

- 开始验证前工作区干净。
- 全量测试 PASS，数量不少于 107。
- 类型检查 PASS。
- Vite 生产构建 PASS。
- 桌面与移动视觉 QA PASS，无外部请求、控制台错误、溢出或裁切。

- [ ] **Step 2: 检查提交历史与安全差异**

Run:

```bash
git log --oneline origin/main..HEAD
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
rg -n 'access_token|refresh_token|appSecret|authorization:' \
  --glob '!pnpm-lock.yaml' \
  --glob '!docs/superpowers/**' \
  .
```

Expected: 只有 conventional commits；无 `Co-Authored-By`；没有新增凭据或敏感日志。

- [ ] **Step 3: 推送独立仓库**

```bash
git push origin main
```

Expected: `main` 推送成功，GitHub Actions `CI` 启动。

- [ ] **Step 4: 等待并验证 CI**

```bash
gh run list --repo jackjin1997/focus-gate-demo --limit 1
gh run watch --repo jackjin1997/focus-gate-demo --exit-status
```

Expected: 最新 `CI` workflow conclusion 为 `success`。

- [ ] **Step 5: 部署 Vercel 生产样机**

```bash
vercel deploy --prod --yes
```

Expected: 部署到已链接的 `focus-gate-demo` 项目；生产 URL 仍为样机模式。

- [ ] **Step 6: 对生产地址运行视觉 QA**

Run:

```bash
BASE_URL=https://focus-gate-demo.vercel.app \
  OUTPUT_DIR=/tmp/focus-gate-production-qa \
  pnpm qa:visual
```

Expected: 生产桌面/移动完整演示 PASS；页面不调用 `/api/capability-reviews`，也不能通过 `?mode=real` 切入真实模式。

- [ ] **Step 7: 归档 sprint**

把 `docs/jack_todo.html` 的本轮活跃项全部移入锁定的“已完成”，记录最终测试数、CI run 和生产 URL。

```bash
git add docs/jack_todo.html
git commit -m "docs: close the read-only MVP sprint"
git push origin main
```

Expected: 工作区干净，`main` 与 `origin/main` 同步，公开样机可访问。
