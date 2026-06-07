# SESSION: opencode-serenity-plugin

> **项目即会话模式**（home-session 定义）—— 本仓是独立 git 项目；日常演进通过 git commit 记录，本文件追踪**当前焦点 + 关键决策 + 未决问题 + 项目演进历史 + 关联文档**。
>
> **迁移说明**：本 SESSION 模式在 2026-06-04 21:00 从"事项化"切换为"项目即会话"。原事项化 session `AGENT_SESSIONS/2026-06-04--opencode-serenity-plugin-skeleton/` 已收口归档。

---

## 当前焦点

**v0.0.4 — msm_exec 协议层集成 (S022 RFC)** 🎉

| 维度 | 状态 |
|------|:----:|
| 范围层 RR1-RR7 | ✅ |
| 方案层 10 步 + 5 模块 | ✅ |
| 接口层 6 契约 + 13 错误类 | ✅ |
| 实现层 32 文件 / 236 tests pass (v0.0.3 → v0.0.4: +9 tests) | ✅ |
| typecheck + build green | ✅ |
| 主仓集成（opencode.json + tui.json）| ✅ |
| 用户实测 toast 显示 | ✅ |
| 远程推送 origin main | ✅ |
| **v1.14 msm_exec 协议层 (6 必含 flag)** | ✅ 2026-06-07 |

**v0.0.x commit 链（最新 5 个）**：

| 阶段 | 状态 | commit |
|------|:----:|--------|
| v1.10.1 | ✅ | `d0ab00a` |
| **v1.11** bin install CLI (idempotent) | ✅ | `93348e3` |
| **v1.14** msm_exec 协议层集成 (S022 RFC) | ✅ | `725a9e7` (v0.0.4) |
| **v1.12** isHookEnabled + safeCreateHook | ✅ | 本次 commit (v0.0.5) |
| **v1.13** zod-first plugin config | ⏳ | 下一个 commit (v0.0.6) |

**v0.0.1 commit 链（17 个）**：

| 阶段 | 状态 | commit |
|------|:----:|--------|
| 范围层（RR1-RR7）| ✅ | `70db320` |
| 方案层（10 步协议 + 模块）| ✅ | `b92eed6` |
| 接口层（6 契约 + 错误类）| ✅ | `f2b3845` |
| v0 实现层（24 tests）| ✅ | `e91f8cc` |
| v0.1 候选文档 | ✅ | `ac9b7ec` |
| v0.1-1 两阶段 init（13 tests）| ✅ | `fc1f6a7` |
| v0.1-2 path-arg 守卫（4 tests）| ✅ | `1c4ce6b` |
| v0.1-3 hook 工厂分层（9 tests）| ✅ | `ca4360f` |
| v1-1 symlink 防御（6 tests）| ✅ | `20bf791` |
| v1-2 hashline edit（13 tests）| ✅ | `e39ed23` |
| v1-3 升 v2 SDK + auto-reply permission | ✅ | `809bf94` |
| v1.4 SKILL.md 全文注入 system prompt | ✅ | `cee8c2e` |
| v1.5 init-check（启动时校验 opencode.json）| ✅ | `00fcd19` |
| v1.6 RR5 hard block | ✅ | `00fcd19` |
| v1.7 auto-patch 主仓 opencode.json | ✅ | `1c420a1` |
| v1.7b/c marker 调整 | ✅ | `d9b774e` / `bafa22c` |
| v1.8 TUI plugin entry（双 plugin 架构）| ✅ | `ebc2491` |
| **v1.9** TUI entry shape + 切 tui.json（R-α/β/γ 修复）| ✅ | `3d34cba` |
| **v1.9.1** 移除 JSX slot 防止 plugin 加载失败 | ✅ | `80f6b28` |
| **v1.10** RR7 init — /serenity-init slash command + DialogPrompt UX | ✅ | `d026b05` |
| **v1.10.1** /serenity-init 修复：self-install 到 global tui.json（非 serenity 目录可见）| ✅ | 本次 commit |

> **下一步**：v1.11 — slot 状态指示器（`createElement` / `spread` 直调，不依赖 JSX runtime）

---

## 关键决策

### 范围层（RR1-RR7，已写入 docs/requirements-v0-scope.md）

| # | 规则 | 关键约束 |
|---|------|---------|
| RR1 | cwd 内必须有 `/.serenity`，内容 = 实例名 | 文件是单一真相源 |
| RR2 | 激活后首次加载 `.opencode/skills/<实例名>/SKILL.md` | 每次新 session 启动时 |
| RR3 | 禁 bash；命令通过 MSM（已有/新写） | 同名 bash tool 抛错 + permission.bash:deny |
| RR4 | cwd 内全部权限 | 默认 allow |
| RR5 | cwd 外全部无权限 | deny/throw |
| RR6 | cwd 必须在 git repo 内 | 否则 plugin 不工作 |
| RR7 | plugin 应能"初始化 cwd 为 serenity" | 5 子点（slash `/serenity-init` / 默认目录名 / 不自动 init / 自动 add+commit / 仅创建 /.serenity）|

### 工程层决策

| # | 决策 | 理由 |
|---|------|------|
| 11 | **zod 锁 4.1.8**（与 `@opencode-ai/plugin@1.15.13` 严格匹配）| 4.4.3 minor 不兼容；3.x 缺 `$ZodType` |
| 12 | **plugin 入口签名** `(input) => Promise<Hooks>`，非 `(api) => PluginReturn` | 真实 SDK 1.15.13 形式 |
| 13 | **tool 用 `tool()` 工厂 + `Hooks.tool[name]`** 注册 | SDK 1.15.13 形式 |
| 14 | **同名 bash tool 覆盖**（L3 验证）| `[...builtin, ...custom]` 顺序 = 后注册覆盖前注册 |
| 15 | **msm_exec 30s 超时** | v0 固定；v1 可配置 |
| 16 | **msm_exec 路径解析** 用 `path.resolve` + `isPathInside` 校验 | 防路径逃逸 |
| 17 | **mcp 客户端不引入** | v0 简化：plugin 自包含读 `mech-registry.json`（实例内）|
| 18 | **RR7 触发走 `experimental.chat.system.transform` hook** | SDK 不暴露 `registerCommand`；v0 用 system prompt 注入提示 LLM 改用 msm_exec |
| 19 | **Q5（msm_exec 完整签名）+ Q6（permission schema）推迟 v1** | m0100 后自主推进；v0 已最小可行；扩展留 v1 |
| 20 | **Q7（主仓定位）取消** — cwd 就是主仓 | m0085：plugin 不维护 instance→main_repo 映射；不需要 HOME_SERENITY_ROOT env |
| 21 | **Q8（plugin 仓身份）删除** | plugin 仓就是 plugin 仓，绝不可能是 serenity 实例 |
| 22 | **plugin 仓工程实践**（git/test/文档）独立于 RR6 | m0088 区分"plugin 自身的工程需求" vs "serenity 实例的 git 要求" |

### 撤回记录

- **R1-R5 旧版**（基于 R1-R5 隐含 B 软专属假设）→ 已被 RR1-RR7 取代（用户 m0070 + m0073 重定义为"plugin 是 opencode 行为的强约束层"）
- **Q5 / Q6 撤回**（不在范围层问，跳级）→ 移到 v1 接口/契约层
- **Q8 撤回**（plugin 仓身份 = 废问题）

---

## 未决问题

| # | 问题 | 状态 |
|---|------|------|
| 1 | **主仓 opencode.json 集成** | ✅ v0.0.1 完成（主仓 `240dffe` + `0460bf1`）|
| 2 | **msm_exec 完整签名（v1）** | 当前 v0 = `{msm_name, args}`；v1 可加 `cwd` / `timeout` / `env` |
| 3 | **permission schema 真实集成（v1）** | 当前 v0 用 tool.execute.before hook 拦截；v1 可改用 permission.ask hook（若宿主触发）+ opencode.json |
| 4 | **RR7 完整 slash command（v1）** | v0 用 system.transform 注入；v1 期望 SDK 暴露 registerCommand 或自实现 |
| 5 | **plugin 仓的"开发期测试"** | 当前 vitest 测纯逻辑；v1 可加集成测试（在真实 serenity 主仓中跑）|
| 6 | **v0.1 候选 — 两阶段 init** | ✅ v0.1-1 完成（commit `fc1f6a7`，13 tests）|
| 7 | **v0.1 候选 — Pre-indexed resources** | ✅ v0.1-2 完成（commit `1c4ce6b`，4 tests）|
| 8 | **v0.1 候选 — Hook 工厂分层** | ✅ v0.1-3 完成（commit `ca4360f`，9 tests）|
| 9 | **v1 候选 — symlink 防御** | ✅ v1-1 完成（commit `20bf791`，6 tests）|
| 10 | **v1 候选 — Hashline Edit** | ✅ v1-2 完成（commit `e39ed23`，13 tests；自实现 FNV-1a）|
| 11 | **主仓实地验证** | ✅ v0.0.1 完成（用户 m1180 确认 toast 显示）|
| 12 | **TUI toast 实测** | ✅ v0.0.1 完成（v1.9.1 修复 JSX runtime 根因，commit `80f6b28`）|
| 13 | **v1.3-v5b 撤销** | 🟡 代码仍 active，1.16+ UI 不响应 v2 API reply（暂不影响功能）|
| 14 | **PluginModule.tui?: never 限制** | ✅ v1.8 用 2 个独立 entry 绕过 |
| 15 | **永久 slot 状态指示器** | ⏸ v0.0.2 plan；选项 A bun-plugin-solid / 选项 B createElement+spread 直调 |

---

## 项目演进历史

### 关键里程碑

| 时间 | 事件 | commit |
|------|------|--------|
| 20:45 | 创建 SESSION + plugin 仓骨架 6 文件 | — |
| 20:55 | GitLab API 创建远程仓（id=32, private, yh）| — |
| 21:00 | 项目框架 12 文件 + D1-D12 元信息 | `99e95a3` |
| 21:00 | SESSION 模式迁移（事项化→项目即会话）| `09810ef` |
| 21:30 | 范围层 RR1-RR7 文档化 | `70db320` |
| 22:00 | 方案层 10 步协议 + 5 模块 | `b92eed6` |
| 22:30 | 接口层 6 契约 + 10 错误类 | `f2b3845` |
| 23:30 | 实现层（src/ 9 文件 + tests/ 6 文件）| `e91f8cc` |
| 06-05 00:00 | oMo + skillful 代码级对照（v0.1 候选）| `ac9b7ec` |
| 06-05 00:00 | v0.1-1 两阶段 init | `fc1f6a7` |
| 06-05 00:05 | v0.1-2 path-arg 守卫 | `1c4ce6b` |
| 06-05 00:10 | v0.1-3 hook 工厂分层 | `ca4360f` |
| 06-05 00:15 | v1-1 symlink 防御 | `20bf791` |
| 06-05 00:30 | v1-2 hashline edit | `e39ed23` |

### 28 文件清单（v1 完成后）

| 路径 | 用途 |
|------|------|
| **顶层** | |
| `README.md` | 决策对账表 D1-D12 + 5 条 R1-R5 引用（旧版入口）|
| `SESSION.md` | 本文件 |
| `.gitignore` / `.npmrc` / `.nvmrc` | Node/TS/pnpm 友好配置 |
| `package.json` | scripts + deps（`@opencode-ai/plugin@1.15.13` + `zod@4.1.8`）|
| `tsconfig.json` / `tsconfig.test.json` | TS 5.x strict + Node 20+ |
| `vitest.config.ts` | vitest + node 环境 |
| **src/ 核心** | |
| `src/index.ts` | plugin 入口（10 步启动 + 注册所有 hooks/tools）|
| `src/activation.ts` | tryActivateSync（RR6 同步）+ activateAsync（RR1+RR2 fire-and-forget）|
| `src/state.ts` | 全局激活状态 singleton + ReadyStateMachine 接入 |
| `src/types/index.ts` | 内部类型（SerenityState 等）|
| `src/errors.ts` | 13 个 SerenityError 子类（v0.1-2 + v1-1 各加 1）|
| `src/util/git.ts` | findGitRoot + isPathInside + git 操作 |
| `src/util/serenity-file.ts` | 读 `/.serenity` 文件 |
| `src/util/path.ts` | buildSkillPath + validateSkillExists + isValidInstanceName |
| `src/util/ready-state.ts` | **v0.1-1** ReadyStateMachine（idle/loading/ready/error/disabled）|
| `src/msm.ts` | msmListTool + msmExecTool（含 symlink 守卫）|
| `src/msm-schema.ts` | getPathArgNames + validatePathArgs（**v0.1-2** + **v1-1** 增强）|
| `src/bash-override.ts` | bashOverrideTool（同名 bash 抛 BashDisabledError）|
| `src/hashline/util.ts` | **v1-2** hashLine / annotateLines / parsePos / verifyPos |
| `src/hashline/edit-tool.ts` | **v1-2** hashlineEdit tool + read annotator + edit interceptor |
| **src/hooks/ 工厂（v0.1-3）** | |
| `src/hooks/util.ts` | isHookEnabled + safeHook（try/catch 包装）|
| `src/hooks/permission-guards.ts` | createPermissionGuards（path guard + bash 防御 + **v1-2** edit 拦截）|
| `src/hooks/compacting.ts` | createCompactingHooks（system.transform + session.compacting）|
| `src/hooks/shell-env.ts` | createShellEnv（shell.env 注入 HOME_SERENITY_ROOT + SERENITY_INSTANCE）|
| **tests/ 10 文件 / 69 tests** | |
| `tests/activation.test.ts` | 5 tests（v0.1-1 改用 tryActivateSync API）|
| `tests/ready-state.test.ts` | **v0.1-1** 13 tests |
| `tests/hooks-util.test.ts` | **v0.1-3** 9 tests |
| `tests/msm-schema.test.ts` | v0.1-2 4 tests + **v1-1** 6 tests |
| `tests/hashline-util.test.ts` | **v1-2** 13 tests |
| `tests/util-*.test.ts` | 11 tests（git/path/serenity-file）|
| `tests/errors.test.ts` | 1 test |
| `tests/plugin.test.ts` | 3 tests（full plugin entry）|
| **docs/** | |
| `docs/requirements-v0-scope.md` | RR1-RR7 正式范围层（102 行）|
| `docs/architecture-v0.md` | 方案层（10 步 + 5 模块，219 行）|
| `docs/contract-v0.md` | 接口层（6 契约 + 13 错误，~440 行）|
| `docs/requirements-v0-summary.md` | 旧 R1-R5 引用（保留演进历史）|
| `docs/v0.1-candidates.md` | v0.1 候选（oMo + skillful 对照分析，**3 候选全部已实施**）|
| `docs/architecture-v0.md` | 方案层（10 步 + 5 模块，219 行）|
| `docs/contract-v0.md` | 接口层（6 契约 + 10 错误，431 行）|
| `docs/requirements-v0-summary.md` | 旧 R1-R5 引用（保留演进历史）|
| `docs/v0.1-candidates.md` | v0.1 候选（oMo + skillful 对照分析，待用户拍板）|

### 远程仓

- `git@home.gitlab:yh/opencode-serenity-plugin.git` — private, default_branch=main
- Web: `http://home.gitlab/yh/opencode-serenity-plugin`
- commits（11）：`99e95a3` → `09810ef` → `70db320` → `b92eed6` → `f2b3845` → `e91f8cc` → `ac9b7ec` → `fc1f6a7` → `1c4ce6b` → `ca4360f` → `20bf791` → `e39ed23`

---

## 最近变更

- 2026-06-06 — **v1.10.1** 修复 `/serenity-init` 在非 serenity 目录不可见：TUI plugin 自安装到 `~/.config/opencode/tui.json`，让 plugin 在**任何**目录被 opencode 加载；184/184 tests pass（commit 待生成；详见 `AGENT_SESSIONS/2026-06-06--S020--fix-serenity-init-visibility`）
- 2026-06-06 — **v1.10** RR7 init — `/serenity-init` slash command + DialogPrompt UX（commit `d026b05`，156 tests pass）
- 2026-06-06 — **v0.0.1 release**：bump version 0.0.0 → 0.0.1；README 重写为 release 状态；SESSION 收尾
- 2026-06-06 — **v1.9.1** 修复 TUI toast 加载失败：移除 JSX slot（@opentui/solid JSX runtime 只支持 build-time transform），保留 toast；125/125 tests pass（commit `80f6b28`）
- 2026-06-06 — **v1.9** 修复 TUI 加载机制（R-α/β/γ）：tui.json 拆分、default 形状改 `{ id, tui/server }`、显式 export id；用户实测 toast 显示（commit `3d34cba` + 主仓 `240dffe`）
- 2026-06-06 — **S019** 调研完成：3 subagent 并行定位 tui-toast 根因；报告 `AGENT_SESSIONS/2026-06-06--S019--tui-toast-investigation/docs/tui-toast-root-cause.md`
- 2026-06-05 — **v1.8** TUI plugin entry：双 plugin 架构 + toast 通知（commit `ebc2491`）
- 2026-06-05 — **v1.7** auto-patch 主仓 opencode.json：含 marker key 演进（`bafa22c`）
- 2026-06-05 — **v1.6/v1.5** RR5 hard block + init-check（commit `00fcd19`）
- 2026-06-05 — **v1.4** SKILL.md 全文注入 system prompt（commit `cee8c2e`）
- 2026-06-05 — **v1.3-v2** 升 v2 SDK + auto-reply permission（commit `809bf94`）
- 2026-06-05 — **v1.2 / v1.1** hashline edit + symlink 防御（commit `e39ed23` / `20bf791`）
- 2026-06-05 — **v0.1-3 / v0.1-2 / v0.1-1** hook 工厂分层 / path-arg 守卫 / 两阶段 init（commit `ca4360f` / `1c4ce6b` / `fc1f6a7`）
- 2026-06-04 — **v0 实现层** 24 tests pass / typecheck / build green（commit `e91f8cc`）
- 2026-06-04 — **接口层 / 方案层 / 范围层** 文档化（commit `f2b3845` / `b92eed6` / `70db320`）
- 2026-06-04 — **项目框架 12 文件 + SESSION 模式迁移**（commit `99e95a3` / `09810ef`）

---

## 关联文档

### 主仓（home-serenity）
- 调研 SESSION：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/`
- 需求源（旧 R1-R5）：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/requirements-locked-v0.md`
- 架构 L4：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/docs/plugin-v0-architecture.md`
- 可行性 L5：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/docs/plugin-viability-analysis.md`
- 路线 L6：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/docs/plugin-implementation-roadmap.md`
- 范围层（v0 终版）：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/requirements-locked-v0.md`（旧 R1-R5）+ plugin 仓 `docs/requirements-v0-scope.md`（新 RR1-RR7）
- 主仓事项化 SESSION（已收口）：`AGENT_SESSIONS/2026-06-04--opencode-serenity-plugin-skeleton/SESSION.md`
- 主仓 project link：`AGENT_SESSIONS/_project-links.md`

### plugin 仓（opencode-serenity-plugin）
- 范围层：`docs/requirements-v0-scope.md`
- 方案层：`docs/architecture-v0.md`
- 接口层：`docs/contract-v0.md`
- 旧需求：`docs/requirements-v0-summary.md`（R1-R5 旧版）
