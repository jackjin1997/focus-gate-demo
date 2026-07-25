# 专注之门

专注之门把读取、审阅和执行隔成用户主动跨越的几道门。仓库同时包含公开交互样机和只绑定本机回环地址的真实模式。

- 独立仓库：https://github.com/jackjin1997/focus-gate-demo
- 公开样机：https://focus-gate-demo.vercel.app
- 本机真实模式：`http://localhost:4317`

本仓库是独立项目，可以克隆到任意 `focus-gate-demo` 目录；构建、测试、运行和部署都不依赖 `jack-wiki` 的目录、文件或配置。

## 两种模式

公开样机只使用本地示例数据，用于体验完整 FocusEvent：唯一念头、守门契约、门内专注、有限敲门和专注交接。部署到 Vercel 时始终保持样机模式，不连接个人飞书。

本机真实模式是第一条可运行的纵向切片：

1. 用户主动发起能力研究，服务只检查 `lark-cli` 版本、当前身份、权限和事件目录。
2. 用户首次建立本机 Passkey。注册和每次认证都要求 macOS Touch ID 或系统认可的用户验证。
3. 用户主动打开读取审阅，系统生成一份精确到飞书账户指纹、时间窗、来源、字段、排除项、保留策略和零写入的不可变读取方案。
4. 用户勾选声明并通过 Touch ID 后，一次性授权才可被消费；计划指纹、账号、权限、过期时间或 WebAuthn challenge 任何一项变化都会拒绝读取。
5. 消息正文只在本次进程内存中参与校验，从不写入 SQLite；本地只保留必要元数据、运行状态和有界摘要。

能力研究和方案预览都不会读取消息。飞书消息检索不会在服务启动、页面加载或刷新时自动执行。

## 当前边界

已接入：

- 飞书 CLI 用户身份与 `search:message` 权限检查。
- 最近 10 分钟、当前用户可见消息的受限读取方案。
- Touch ID / Passkey 人类在场证明，challenge 与读取计划指纹绑定。
- 具体飞书 `userOpenId` 指纹绑定，切换账户后旧计划失效。
- 一次性 nonce、完整清单摘要、过期与重放防护。
- 消息 ID 去重、SQLite 运行记录和正文永不落盘。
- 覆盖状态显式标记为受限或未知，不把一次搜索冒充持续完整守门。

尚未接入：

- 飞书实时消息流、结束时完整对账和角色优先级分类。
- 飞书状态、日历、任务、文档和消息回复等写操作。
- macOS 专注模式、应用静音和状态恢复。
- DING、连续加急和电话等紧急信号。

上述写操作不会在公开样机里伪装成可用能力；样机停在本地交接单，真实模式也不会静默执行。

## 本地运行

需要 Node.js 24 或 25、pnpm 10.29.1 和 `lark-cli`。当前真实验证版本是 `lark-cli 1.0.68`；测试夹具也覆盖仓库曾使用的历史 1.x 响应形状，但这不等于承诺兼容所有 1.x 版本。

真实模式默认固定执行 Apple Silicon Homebrew 路径 `/opt/homebrew/bin/lark-cli`，不会从 `PATH` 搜索。Intel Mac、非 Homebrew 安装或自定义位置必须用绝对路径覆盖：

```bash
LARK_CLI_PATH=/absolute/path/to/lark-cli pnpm local
```

默认路径可直接启动：

```bash
pnpm install
pnpm local
```

打开 `http://localhost:4317`。WebAuthn 的 RP ID 固定为 `localhost`；访问 `127.0.0.1` 会重定向到该地址。服务只绑定回环地址，浏览器不会接触飞书令牌。

首次使用时，先在真实模式里点击“开始能力研究”，再复制界面根据当次固定 Profile 生成的最小权限命令：

```bash
lark-cli --profile '<能力报告中的固定 Profile>' auth login --scope 'search:message'
```

用户点击“开始能力研究”时，Companion 会把当时的 active profile 固定到本机进程，后续命令不再跟随默认 profile 切换。运行器会为自己的只读子进程清理代理变量；用户在自己的 shell 中执行上述交互式登录命令，无需添加 `LARK_CLI_NO_PROXY=1`。若 `lark-cli` 不在用户 shell 的 `PATH` 中，执行登录时也要把命令开头替换为同一个绝对路径。

这条命令只补充 `search:message` 权限，不会读取任何消息。完成授权不等于批准读取：回到界面点击“重新检查飞书授权”，后续仍需审阅精确读取计划，并通过 Touch ID 明确批准一次性读取。

SQLite 数据位于：

```text
~/Library/Application Support/Focus Gate/focus-gate.sqlite
```

只开发公开样机时使用：

```bash
pnpm dev
```

然后打开 `http://localhost:5173`。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm qa:visual
```

`pnpm qa:visual` 会先执行类型检查和生产构建，再自动启动、探活并停止临时 `vite preview`。它检查公开样机的桌面、移动端和 reduced-motion 流程，默认把截图写入 `/tmp/focus-gate-qa`。`127.0.0.1:4173` 已被占用或探活超时时，命令会失败并清理其启动的子进程。

验证已经运行的外部目标时传入地址和可选输出目录：

```bash
BASE_URL=https://focus-gate-demo.vercel.app \
  OUTPUT_DIR=/tmp/focus-gate-production-qa \
  pnpm qa:visual
```

提供 `BASE_URL` 后，QA 只访问目标，不启动、停止或以其他方式管理外部服务。真实模式的视觉检查必须停在读取确认墙之前，不能由自动化脚本跨过授权。

GitHub Actions 使用 Node.js 24 和 pnpm 10.29.1，在无 Lark、Vercel、WebAuthn 凭据的环境中只执行 frozen-lockfile 安装、测试、类型检查和生产构建。视觉 QA 与本机真实模式安全冒烟属于发布门，不在 CI 中触碰个人凭据或真实消息。

## 安全约束

- `lark-cli` 使用固定可执行文件和参数数组启动，不经过 shell。
- 子进程清除代理环境变量，限制超时和输出体积；终止宽限期后强制结束。
- 日志不记录访问令牌、消息正文、标准错误或分页令牌。
- 所有本机 POST 请求校验同源；未知 API 不回退到前端页面。
- WebAuthn 验证 challenge、`localhost` origin、RP ID、用户验证和 credential counter。
- 飞书 CLI profile 在用户主动开始能力研究时固定，能力检查与消息检索使用同一条 `--profile` 执行路径。
- Companion 先独占绑定 `127.0.0.1:4317`，成功后才打开 SQLite 和执行中断恢复；第二实例不会触碰业务数据库。
- 正常关停会先拒绝新业务请求并等待在途请求结束，关闭数据库后才释放监听端口。
- 读取授权绑定完整清单摘要、具体飞书账户和当前权限，并且只能消费一次。
- CLI 返回结果会再次校验严格位于授权时间窗内，越界则整批失败且不落数据。
- 公网部署不会因查询参数切换到真实模式。

## 威胁边界

Touch ID 证明有人在专注之门里主动批准了这份计划，能够阻止页面误触、网页 CSRF 和未持有 Passkey 的本机调用直接穿过 `/approve`。

当前个人纵切仍复用全局 `lark-cli` 用户凭据。固定 profile 能避免正常切换默认 profile 时发生账号竞态，但拥有同一 macOS 用户完整 shell 与文件权限的进程仍可以修改该 profile 的凭据，或绕开专注之门直接调用 CLI。因此这还不是针对恶意同机进程的操作系统级隔离。要形成那一层墙，需要把凭据迁入签名的 macOS Companion 和带用户在场 ACL 的 Keychain 项，并让 Agent 运行在无权访问该凭据的沙箱中。

Profile 固定只在当前 Companion 进程内有效；重启后会重新固定当时的 active profile。SQLite 会保留计划和运行记录，但不会自动重放读取：进行中或已经批准却没有完成的读取会明确标记为失败或结果未知。页面刷新不会恢复一次性 nonce，应重新生成读取计划并再次通过 Touch ID。

## 本轮交付边界

本轮只交付公开样机和本机只读 MVP：能力研究、最小 OAuth 恢复、十分钟有界读取计划、Touch ID 一次性批准，以及正文不落盘的结果校验。持续消息守门、完整退出对账、模型分诊、飞书写入、自动回复、macOS 系统专注模式、签名原生 Companion 和 Keychain 隔离均明确延期，不会由现有界面或 CI 暗中启用。

## License

MIT
