# 专注之门 · 只读 MVP 收口设计

| 项目 | 内容 |
|---|---|
| 日期 | 2026-07-26 |
| 状态 | 已批准，等待实施计划 |
| 产品边界 | 可交付的只读 MVP |
| 运行环境 | 公开 Vercel 样机 + macOS 本机回环真实模式 |

## 1. 目标

本轮把现有纵向切片收口为一个诚实、可重复验证、可独立维护的只读 MVP：

- 公开样机稳定演示完整的 FocusEvent 体验，但不连接个人飞书。
- 本机真实模式能够准确研究当前 `lark-cli` 能力，生成精确的十分钟消息读取计划，并在用户通过 Passkey 明确批准后消费一次只读授权。
- 项目不再依赖 `jack-wiki` 的目录结构、设计文档或隐式上下文。
- 测试、类型检查、生产构建、视觉 QA、本机安全冒烟和公开部署均有可重复的验证入口。

成功不等于实现旧规格中的完整守门 Agent。本轮不实现持续轮询、自动分诊、KNOCK、自动回复、日历或状态写入，也不实现原生 macOS Companion。

## 2. 现状与需要修复的缺口

现有代码已经包含 React 前端、本机 Hono 服务、领域状态机、SQLite 元数据存储、WebAuthn/Passkey 人类在场验证、Lark CLI 适配器和 107 项自动化测试。

基线审计确认以下真实缺口：

1. 当前安装的 `lark-cli 1.0.68` 将用户身份状态放在 `identities.user` 下；现有解析器仍主要读取旧的顶层字段，可能把可用 Bot、记忆中的用户信息和有效用户 OAuth 混淆。
2. 能力研究没有使用当前推荐的 `auth status --json --verify` 契约，无法可靠区分“记住了用户 open_id”和“用户令牌当前有效”。
3. `pnpm qa:visual` 假定 `127.0.0.1:4173` 已经有预览服务，按 README 单独执行会连接失败。
4. 独立仓库没有收口规格、CI 和完整的交付验证说明。
5. 当前机器的飞书用户 OAuth 缺失，因此真实租户读取必须继续停在授权墙外，直到用户主动完成最小权限登录。

## 3. 采用方案

采用“版本兼容解析层”，保留现有架构，仅在外部契约边界和交付工具链上收口。

没有采用的方案：

- 只针对 `lark-cli 1.0.68` 写死解析：改动较少，但无法处理仓库已有的旧版夹具和后续兼容。
- 绕过 CLI 直连飞书 OpenAPI：会把令牌托管、刷新和应用权限管理引入本机服务，扩大安全面，不符合只读 MVP 边界。

## 4. 架构与组件

现有请求路径保持不变：

```text
React UI
  -> localhost 同源 HTTP API
  -> FocusGateApplication / HumanPresenceApplication
  -> LarkCliAdapter
  -> 固定 argv 的 lark-cli 子进程
  -> SQLite 元数据与 WebAuthn 凭据
```

本轮调整以下组件：

### 4.1 Lark CLI 能力研究

能力研究使用固定、只读、无 shell 的命令：

```text
lark-cli --version
lark-cli auth status --json --verify
lark-cli auth scopes --json
lark-cli event list --json
```

启动能力研究时固定 active profile。后续能力检查和消息搜索都必须显式使用同一个 profile，不能跟随全局默认 profile 改变。

### 4.2 版本兼容规范化

解析器把 CLI 输出转换为现有 `CapabilityReview`：

- 当前契约只从 `identities.user` 读取用户令牌状态；只有 `status` 为 `ready` / `needs_refresh`、`available === true`、`verified === true` 且存在具体用户 `openId` 时，`authenticated` 才能为真。
- 根级 `verified` 只描述当前默认身份；即使 Bot 已验证，也不能代替 `identities.user.verified`。
- Bot 可用不能推出用户已授权。
- 记忆中的用户名或 `openId` 不能推出用户令牌有效。
- 当前 `identities.user.scope` 是用户令牌的空白分隔 scope；`auth scopes` 返回应用权限目录。界面可用权限必须取用户令牌 scope 与应用权限目录的交集。
- `auth scopes` 的应用权限目录同时兼容当前顶层 `userScopes` 和历史信封结构；无 `identities` 的历史顶层用户契约保留原有规范化方式。
- 无法确定身份、权限或 JSON 契约时失败关闭，界面不得显示可读取。

### 4.3 读取计划与授权墙

保留现有十分钟只读计划：

1. 页面加载不调用飞书。
2. 用户主动点击后才执行能力研究。
3. 能力研究不搜索消息。
4. 用户主动预览后生成不可变计划，绑定具体 profile、用户指纹、时间窗、来源、字段、排除项、保留策略和零写入声明。
5. 用户勾选声明并通过 Passkey 后，一次性 nonce 才可消费。
6. 批次中任一消息越过批准时间窗，整批失败。
7. 消息正文只在当前进程内存中参与校验；SQLite 只保存必要元数据和有界摘要。

OAuth 缺失时，界面展示与固定 profile 对应的最小权限登录命令。应用不自动发起 OAuth，不把登录完成视为读取批准。

### 4.4 视觉 QA 运行器

`pnpm qa:visual` 成为单命令验证入口：

- 若未提供 `BASE_URL`，启动临时 `vite preview`。
- 等待 HTTP 就绪后再启动 Playwright。
- 验证桌面、移动端和 reduced-motion 流程。
- 检查横向溢出、裁切、控制台错误和意外外部请求。
- 成功或失败都关闭浏览器和预览子进程。
- 若提供 `BASE_URL`，只验证指定地址，不管理外部服务。

真实模式的自动化仍停在读取确认墙之前。

### 4.5 独立项目文档与 CI

仓库内保留：

- 本设计规格。
- `docs/jack_todo.html` 执行 source-of-truth。
- 更新后的 README：模式边界、依赖、OAuth 最小权限、运行方式、安全约束和完整验证命令。
- GitHub Actions：使用受支持的 Node/pnpm 版本执行测试、类型检查和生产构建；CI 不接触个人飞书凭据。

## 5. 数据与安全不变量

- 所有 CLI 调用使用固定可执行文件和参数数组，`shell: false`。
- 子进程使用固定 profile，清理代理环境变量，限制运行时间和输出体积。
- 日志不记录令牌、消息正文、stderr 原文、分页令牌或 WebAuthn challenge。
- 公开部署不能通过查询参数进入真实模式。
- 本机服务只绑定回环地址，写请求必须同源。
- 未知 API 路由不能回退到前端 HTML。
- 计划摘要、账号、权限、时间窗、过期时间或 Passkey challenge 任一变化都使授权失效。
- 一次性计划只能消费一次；重放返回稳定冲突。
- 用户 OAuth 缺失或无法验证时，界面明确显示“不可读取”，不提供虚假安心提示。

## 6. 错误处理

| 情况 | 行为 |
|---|---|
| `lark-cli` 不存在或无法启动 | 返回稳定的 `CLI_UNAVAILABLE`，不暴露底层异常 |
| CLI JSON 契约无法识别 | 返回 `INVALID_RESPONSE`，能力研究失败关闭 |
| 只有 Bot 可用 | 显示用户 OAuth 缺失，不生成可批准的读取计划 |
| 用户权限缺少 `search:message` | 显示最小权限登录指引，读取墙保持关闭 |
| profile 或账户在审阅后改变 | 拒绝批准，不消费原计划 |
| 查询返回越界消息或不完整分页 | 整批失败，正文和事件均不落盘 |
| 视觉预览服务未就绪 | QA 给出明确启动错误并清理子进程 |
| CI 环境没有 Lark 凭据 | 只运行夹具和纯本地测试，不尝试真实飞书调用 |

## 7. 测试策略

核心边界继续采用 TDD：

1. 为当前 `lark-cli 1.0.68` 身份与 scope 结构先增加失败测试。
2. 保留旧版夹具，证明兼容层不会回归已有契约。
3. 增加 Bot-ready/user-missing、记忆 openId、未验证 token、profile 改变和未知 JSON 的失败关闭用例。
4. 为视觉 QA 的服务启动、就绪、外部 `BASE_URL` 和清理路径增加可测试边界。
5. 保留现有领域、HTTP、SQLite、WebAuthn 和 UI 测试。

交付验证命令：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm qa:visual
```

本机安全冒烟额外验证：

- 健康检查不会访问飞书。
- 能力研究准确报告当前用户 OAuth 状态。
- 未授权时无法跨过读取确认墙。
- 自动化不执行真实消息读取。

## 8. 完成定义

只读 MVP 在以下条件全部满足时完成：

1. 仓库位于独立目录，Git 历史和 GitHub remote 完整。
2. 当前与历史 Lark CLI 契约测试均通过；真实能力研究不会把 Bot 误当成用户授权。
3. 用户 OAuth 缺失时，产品给出诚实、可执行的最小权限指引。
4. 测试、类型检查、生产构建和单命令视觉 QA 全部通过。
5. README、规格、执行清单和 CI 自包含，不依赖 `jack-wiki`。
6. 本机安全冒烟停在授权墙外并通过。
7. 公开 Vercel 样机仍只能运行样机模式，部署验证通过。
8. 所有本轮变更以 conventional commit 提交，不添加 `Co-Authored-By`。

## 9. 明确延后

以下能力不属于本轮完成定义：

- 持续消息轮询、入口水位、退出补偿与覆盖完整性证明。
- 自动分诊、KNOCK、交接摘要和模型调用。
- 飞书状态、日历、任务和消息回复写操作。
- Bot 事件加速器、收到加急或电话检测。
- macOS 系统专注模式桥接、签名 Companion、Keychain 凭据隔离和正式安装包。

这些能力只能在只读纵切完成真实租户验证、覆盖率复盘和新的精确授权设计后进入下一阶段。
