# Plugin Architecture v0 — 方案/设计层

> **会话**：opencode-serenity-plugin（项目即会话模式）
> **状态**：v0.0.2 已发布（2026-06-07）。本文件随代码演进持续修订。
> **范围**：v0 plugin 整体架构 + 启动协议 + 模块划分 + 数据流 + 失败模式。
> **不进**：接口/契约层（`docs/contract-v0.md`）、实现/代码层（`src/`）、需求层（`docs/requirements-v0-scope.md`）。

---

## 1. 顶层架构图

opencode 1.16+ 强制 `PluginModule` 二选一（`server | tui`），所以 plugin 走**两条独立 entry 并行加载**：

```
┌─────────────────────────────────────────────────────────────────┐
│                  opencode 宿主运行时（任何 cwd）                  │
│                                                                  │
│  ┌────────────────┐    启动时（一次）                            │
│  │  plugin 加载    │ ─────────────────────────┐                  │
│  │  (loader)      │                          ▼                  │
│  └────────────────┘   ┌──────────────────────────────────────┐ │
│                        │  opencode-serenity-plugin (server)    │ │
│                        │  src/index.ts (entry)                 │ │
│                        │                                       │ │
│                        │  ┌───────────────────────────────┐   │ │
│                        │  │  activation.ts (两阶段 init)    │   │ │
│                        │  │  Phase 1 sync: RR6 git check    │   │ │
│                        │  │  Phase 2 async: RR1 + RR2       │   │ │
│                        │  │  + v1.5 init-check              │   │ │
│                        │  │  + v1.7 config-patch             │   │ │
│                        │  └───────────────────────────────┘   │ │
│                        │           │                             │ │
│                        │           ▼                             │ │
│                        │  ┌───────────────────────────────┐   │ │
│                        │  │  plugin state (singleton):     │   │ │
│                        │  │  { activated, cwdRoot,         │   │ │
│                        │  │    instanceName, skillPath,    │   │ │
│                        │  │    skillContent }              │   │ │
│                        │  └───────────────────────────────┘   │ │
│                        │           │                             │ │
│                        │           ▼                             │ │
│                        │  注册 hooks + tools：                   │ │
│                        │  • tool.execute.before — RR5 hard block │ │
│                        │  • experimental.chat.system.transform   │ │
│                        │    (注入 SKILL.md)                       │ │
│                        │  • experimental.session.compacting      │ │
│                        │  • shell.env — 注入 HOME_SERENITY_ROOT  │ │
│                        │  • event permission.asked — auto-reply  │ │
│                        │  • tool: bash(override)/msm_list/       │ │
│                        │          msm_exec/msm_admin             │ │
│                        └──────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  opencode-serenity-plugin (TUI, 平行 entry)              │   │
│  │  src/tui.ts (entry)                                       │   │
│  │                                                           │   │
│  │  • 加载 toast: "v${VERSION} loaded"                       │   │
│  │  • 激活 toast: "plugin activated — read/edit = allow"     │   │
│  │  • 自检自装到 global tui.json（v1.10.1 修复）              │   │
│  │  • /serenity-init slash command (RR7 init)                │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

两条 entry 独立加载但共享 `src/state.ts` 模块级 singleton——server entry 写、tui entry 读（不依赖 RR1 即可展示 toast）。

## 2. 启动协议 — 两阶段 init (v0.1)

**触发**：opencode 启动时，plugin loader 加载 `src/index.ts` 的 default export 一次。

**前提**：`@opencode-ai/plugin@1.16.2` 的 `Plugin` 类型签名 `(input: PluginInput) => Promise<Hooks>`，input 提供 `directory / worktree / client / serverUrl`。

### Phase 1：同步（plugin 入口立即返回）

| 步 | 动作 | 失败处理 | 来源 |
|---|------|---------|------|
| 1 | `cwd = input.directory` | 异常 → return `{}`（plugin 静默不工作）| RR6 隐含 |
| 2 | `findGitRoot(cwd)` (git rev-parse --show-toplevel) | 失败 / 不在 → **mark disabled** + return `{}` | RR6 |
| 3 | 启动 Phase 2 fire-and-forget（不 await）| — | 内部 |
| 4 | 注册 hooks + tools（Phase 2 未完成时 hook 内 `ensureReady()` 阻塞）| — | 内部 |
| 5 | return `hooks` | — | 内部 |

### Phase 2：异步（fire-and-forget 后台 IO）

| 步 | 动作 | 失败处理 | 来源 |
|---|------|---------|------|
| 1 | RR1 读 `<gitRoot>/.serenity` | 失败 → state.error（machine 推 error） | RR1 |
| 2 | RR2 验证 `<gitRoot>/.opencode/skills/<N>/SKILL.md` | 失败 → state.error | RR2 |
| 3 | 读 SKILL.md 全文（system.transform 注入用）| 失败 → 降级为 null（plugin 仍工作） | 内部 |
| 4 | setState + markReady | — | 内部 |
| 5 | v1.5 init-check：warn 不 patch | 失败 → log.warn | 内部 |
| 6 | v1.7 config-patch：自动 grant read/edit=allow + TUI toast 通知 | 失败 → log.warn（不阻断） | 内部 |

**重要约束**：
- **前 2 步**任意失败 → `return {}`（plugin 啥也不做，**就像没装一样**——Q6 用户原话）
- **不 throw**（抛错会中断 opencode 启动，且违反"不工作"语义）
- **不 console.error**（用 `log.warn`/`log.debug`——不污染用户）
- **Exception**：`tool.execute.before` (permission-guards) 故意让 throw 透传（RR5 hard block 想要的行为；其他 hook 走 `safeHook` 静默）

## 3. 模块划分（v0.0.2 实际）

```
opencode-serenity-plugin/
├── README.md                            # 用户入口 + 安装说明
├── SESSION.md                           # 项目即会话追踪
├── package.json                         # version 0.0.2, deps: @opencode-ai/plugin@1.16.2 + zod@4.1.8
├── tsconfig.json / tsconfig.test.json   # TS 5.x strict + Node 20+
├── vitest.config.ts                     # testTimeout 20s（msm-call 冷启动）
├── bin/
│   └── opencode-serenity-plugin.js       # CLI: install/uninstall (v1.11)
├── src/                                 # ── 12 顶层 .ts ──
│   ├── index.ts                         # server entry (4 tool + 4 hook)
│   ├── tui.ts                           # TUI entry (toast + /serenity-init + self-install)
│   ├── activation.ts                    # 两阶段 init + config-patch wiring
│   ├── state.ts                         # 全局激活状态 singleton + ReadyStateMachine
│   ├── msm.ts                           # msmListTool + msmExecTool + msmAdminTool (4 tool)
│   ├── msm-schema.ts                    # flag normalize (v0/v1) + tokenizeArgs + path-arg 校验 (v0.1-2 + v1-1)
│   ├── config-schema.ts                 # zod-first 4 schemas (v1.13)
│   ├── install.ts                       # bin install lib (project + global, XDG + APPDATA)
│   ├── bash-override.ts                 # 同名 bash tool 覆盖 (RR3 第三层)
│   ├── errors.ts                        # 13 个 SerenityError 子类 + 1 基类
│   ├── types/
│   │   └── index.ts                     # SerenityState + INACTIVE_STATE + SerenityPluginInput
│   ├── hooks/                           # ── 5 hook 工厂 ──
│   │   ├── util.ts                      # isHookEnabled + safeHook + safeCreateHook (oMo 模式 v1.12)
│   │   ├── permission-guards.ts         # tool.execute.before — RR5 hard block + bash 防御
│   │   ├── compacting.ts                # system.transform + session.compacting
│   │   ├── shell-env.ts                 # shell.env 注入 HOME_SERENITY_ROOT + SERENITY_PLUGIN_VERSION
│   │   └── permission-auto-reply.ts     # event hook — permission.asked → "always" (v1.3-v4)
│   └── util/                            # ── 10 helper ──
│       ├── git.ts                       # findGitRoot + tryFindGitRoot + isPathInside + git ops
│       ├── path.ts                      # buildSkillPath + validateSkillExists
│       ├── serenity-file.ts             # readSerenityFile (RR1)
│       ├── ready-state.ts               # ReadyStateMachine (idle/loading/ready/error/disabled)
│       ├── init.ts                      # initSerenity (RR7)
│       ├── init-check.ts                # checkSerenityConfig (v1.5, warn-only)
│       ├── config-patch.ts              # patchMainRepoOpencodeJson (v1.7, auto-grant)
│       ├── msm-call.ts                  # callMsmExec + callMsmExecMeta + parseProtocolFlags (S022 RFC)
│       ├── tui-install.ts               # global tui.json 自安装 (v1.10.1, 薄包装 install.ts)
│       └── log.ts                       # 统一 log wrapper (no-op, 65 sites)
├── tests/                               # ── 23 测 / 320 cases ──
│   ├── activation.test.ts / ready-state.test.ts   # Phase 1+2 + machine
│   ├── msm-{call,schema,registry,admin}.test.ts   # 协议层 + admin
│   ├── config-{schema,patch}.test.ts              # zod + patch
│   ├── errors.test.ts                              # 13 错误类
│   ├── hooks-{util,guard}.test.ts                  # 工厂 + guard
│   ├── permission-{auto-reply,guards-v16}.test.ts  # event + RR5
│   ├── compacting-skill-inject.test.ts             # SKILL.md 注入
│   ├── init-check.test.ts / install.test.ts        # init + bin
│   ├── tui{-install,}.test.ts                      # tui 入口
│   ├── plugin.test.ts                              # full entry
│   └── util-{git,init,path,serenity-file}.test.ts   # helpers
└── docs/                                # ── 7 文档 ──
    ├── requirements-v0-scope.md         # RR1-RR7 范围层 (v0 终版)
    ├── architecture-v0.md               # 本文件
    ├── contract-v0.md                   # 6 契约 + 13 错误类
    ├── requirements-v0-summary.md       # ⚠️ 已过时（旧 R1-R5 保留演进史）
    ├── v0.1-candidates.md               # ✅ ALL DONE (3 候选全部已实施)
    ├── rr7-init-design.md               # v1.10 + v1.10.1 实施记录
    └── refactor-direction-v1.11.md      # ✅ Done 2026-06-07 (v1.11-v1.17)
```

## 4. 数据流

### 4.1 启动阶段（一次性）

```
opencode 启动
  ↓
plugin loader 加载 src/index.ts (server) + src/tui.ts (TUI) 并行
  ↓
server: activation.tryActivateSync
  ↓
[Phase 1 sync — RR6 git check]
  ↓ (ok)
注册 hooks + tools + 启动 Phase 2 fire-and-forget + 立即返回 hooks
  ↓
Phase 2 async (后台): RR1 + RR2 + skillContent + init-check + config-patch
  ↓
setState(activated) + machine.markAsReady()
  ↓
ensureReady() 在所有 tools/hooks 内不再阻塞
```

### 4.2 工具调用阶段（每次）

```
LLM 决定调工具
  ↓
opencode 查 tool 注册表
  ├─ msm_list  ─→  src/msm.ts#msmListTool  →  loadMechRegistry  →  字符串输出
  ├─ msm_exec  ─→  src/msm.ts#msmExecTool  →  1. tokenizeArgs + parseProtocolFlags
  │                                            2. findMsm + path-arg 校验
  │                                            3. msm-exec.ts (协议层) — 含 6 必含 flag
  │                                            4. 错误类: MsmExecutionError (持 stdout)
  ├─ msm_admin ─→  src/msm.ts#msmAdminTool →  register/deregister + auto-commit
  └─ bash       ─→  src/bash-override.ts   →  throw BashDisabledError (RR3)
  ↓
permission.asked event hook (parallel) — 无条件 reply "always"
  ↓
permission-guards tool.execute.before — RR5 hard block (read/edit/write 路径守卫)
  ↓
执行结果回 LLM
```

### 4.3 关键判定

| 判定 | 函数 | 来源 |
|------|------|------|
| cwd 在 git repo 内 | `findGitRoot(cwd)` (git rev-parse) | RR6 |
| `/.serenity` 存在 + 非空 | `readSerenityFile(gitRoot)` | RR1 |
| 实例名 N 解析 | `parseInstanceName(content)` | RR1 |
| skill 路径存在 | `validateSkillPath(gitRoot, N)` | RR2 |
| 路径在 cwdRoot 内 | `isPathInside(cwdRoot, abs)` | RR5 |
| path-arg 解析在 cwdRoot 内 | `validatePathArgsFromTokens(rest, flags, cwdRoot)` (v0.1-2) | msm_exec 路径守卫 |
| symlink 防御 | `realpathSync` 比较 | v1-1 |
| msm_name 在注册表 | `findMsm(name, registry)` | 内部 |
| hook 启用 | `isHookEnabled(name, config?)` + env var + session disable | v1.12 |

## 5. 与主仓关系

| 维度 | plugin 仓 | 主仓（home-serenity） | 其他工作项目 |
|------|----------|-------------------|------------|
| `/.serenity` | ❌ | ✅（内容 = `home-serenity`） | ❌ |
| 是 git repo | ✅ | ✅ | 视情况 |
| 加载 plugin 时激活？ | ❌（plugin 仓不满足 RR1） | ✅ | ❌ |
| 行为 | plugin **开发** | plugin **生效** | opencode 默认行为 |

**plugin 仓** = plugin **工程实践**（git 维护、tsconfig 严格、vitest 单测、commit 历史）
**主仓** = plugin **运行时宿主**（plugin 激活后所有行为以 cwd = 主仓根为基础）
**plugin 不需要知道"主仓"在哪**——只看 cwd

**工程层独立（决策 #22）**：plugin 仓的 git/test/文档约束**独立于 RR6**——plugin 仓本身是 git repo 是为了工程需求（如 commit 历史、单测覆盖率追踪），**不是**为满足 RR6（plugin 加载时 cwd 仍是主仓根，不在 plugin 仓内）。

## 6. 失败模式

| 失败 | 行为 | 用户可见性 |
|------|------|----------|
| cwd 不在 git repo | plugin 完全不激活 | opencode 默认行为（无变化） |
| `/.serenity` 不存在 | plugin 不激活 | 同上 |
| `/.serenity` 内容为空 | plugin 不激活 | log warn |
| `/.serenity` 找不到对应 SKILL.md | plugin 不激活 | log warn |
| msm_name 不在注册表 | `msm_exec` 抛 `MsmNotRegisteredError` | LLM 看到错误消息 |
| msm 子进程超时 (>30s) | `msm_exec` 抛 `MsmTimeoutError` | LLM 看到错误消息 |
| msm 子进程 exit ≠ 0 | `msm_exec` 抛 `MsmExecutionError`（持 stdout） | LLM 看到错误消息 + stdout |
| path-arg 越界 | `msm_exec` 抛 `MsmPathEscapeError` (v0.1-2) | LLM 看到错误消息 |
| path-arg 是 symlink 链 | `msm_exec` 抛 `MsmSymlinkError` (v1-1) | LLM 看到错误消息 |
| bash 被 LLM 调用 | 抛 `BashDisabledError` | LLM 看到错误消息（RR3 行为） |
| cwd 外 read/edit/write | tool.execute.before 抛 `[serenity] ... is outside the serenity workspace root (RR5)` | LLM 看到错误消息（v1.6 RR5 hard block） |
| hook factory 抛错 | `safeCreateHook` 自动 disable + 返回 no-op | 不影响 LLM（retry-storm 防护） |
| init-check opencode.json 缺字段 | 只 warn 不 patch | log.warn |
| config-patch 写失败 | log.warn + plugin 继续工作 | 用户需手动配置 |
| 外部 slash command（如 `/clear`） | 不拦截 | opencode 默认行为 |

## 7. 演进路径（v0 → v1+）— ✅ 全部已实施

| 候选 | 描述 | 实施 |
|------|------|------|
| 候选 1 | `permission.asked` event hook 自动 reply "always"（v1.3-v4 决策：trust opencode own always list，无条件 reply） | ✅ v1.3 (commit `809bf94`) |
| 候选 2 | `experimental.session.compacting` hook（压缩后重注入 SKILL.md + 关键状态） | ✅ v1.4 (commit `cee8c2e`) |
| 候选 3 | `shell.env` hook 注入 `$HOME_SERENITY_ROOT` 等环境变量 | ✅ v1.5 (commit `00fcd19`) |
| 候选 4 | 多实例 registry（如果用户超过 3 个实例时） | ⏸ v0.0.2 不实施（实操未遇 ≥3 实例场景） |

候选 1-3 实施于 v1.3-v1.5；候选 4 推迟到 v0.0.3+ 按需。完整记录见 `SESSION.md` 项目演进历史。

## 8. 与 SDK 对接点

| 抽象层概念 | SDK 实现 (opencode 1.16.2) | 文档 |
|----------|--------------------------|------|
| 工具注册 | `import { tool } from '@opencode-ai/plugin'; tool({ description, args: z.object({...}), execute })` | `@opencode-ai/plugin/tool` |
| Hooks 集合 | `const hooks: Hooks = { tool: {...}, 'experimental.chat.system.transform': ... }` | `@opencode-ai/plugin/Hooks` |
| permission.asked event | `event: { 'permission.asked': async (input, output) => { output.reply = 'always' } }` | `@opencode-ai/plugin/Hooks.event` |
| tool.execute.before | `'tool.execute.before': async (input, output) => { ... throw ... }` | 同上 |
| system.transform | `'experimental.chat.system.transform': async (input, output) => { output.system.push(...) }` | 同上 |
| session.compacting | `'experimental.session.compacting': async (input, output) => { output.context.push(...) }` | 同上 |
| shell.env | `'shell.env': async (input, output) => { output.env.X = ... }` | 同上 |
| TUI plugin entry | `import type { TuiPlugin } from '@opencode-ai/plugin/tui'; export default { id, tui: Tui }` | `@opencode-ai/plugin/tui` |
| PluginModule 二选一 | `export default { id, server }` 或 `export default { id, tui }` | `@opencode-ai/plugin/Plugin` |
| toast 通知 | `api.ui.toast({ title, message, variant, duration })` (TuiPlugin) | 同上 |
| slash command | `api.command?.register(() => [{ title, value, slash, onSelect }])` | 同上 |

**SDK 升级注意**：opencode 1.16+ 强制 PluginModule 二选一，v1.8 引入 TUI 独立 entry 绕过此限制。**严禁**在同一 module 同时 export `server` 和 `tui`。

## 9. 文档演进规则

- **范围层**（RR1-RR7）→ `docs/requirements-v0-scope.md`
- **方案层**（本文）→ `docs/architecture-v0.md`（本文）
- **接口层**（6 契约 + 13 错误类）→ `docs/contract-v0.md`
- **设计草案 / 演进候选** → `docs/v0.1-candidates.md` + `docs/refactor-direction-*.md` + `docs/rr7-init-design.md`
- **实现层** → `src/`
- **测试层** → `tests/`
- **SESSION 跟踪** → `SESSION.md`（项目即会话）

> **本文件最后修订**：2026-06-07（v0.0.2 文档债务清理 Phase 3 D7+D8：架构图、模块结构、SDK API 全部按 v0.0.2 实际重写；演进路径 4 候选全部标 ✅）
