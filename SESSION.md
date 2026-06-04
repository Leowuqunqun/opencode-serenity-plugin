# SESSION: opencode-serenity-plugin

> **项目即会话模式**（home-session 定义）—— 本仓是独立 git 项目；日常演进通过 git commit 记录，本文件追踪**当前焦点 + 关键决策 + 未决问题 + 项目演进历史 + 关联文档**。
>
> **迁移说明**：本 SESSION 模式在 2026-06-04 21:00 从"事项化"切换为"项目即会话"。原事项化 session `AGENT_SESSIONS/2026-06-04--opencode-serenity-plugin-skeleton/` 已收口归档。

---

## 当前焦点

**v0 实现完成** — 22 文件 / 5 commits / typecheck + 24 tests + build 全绿。

| 阶段 | 状态 | commit |
|------|:----:|--------|
| 范围层（RR1-RR7）| ✅ | `70db320` |
| 方案层（10 步协议 + 模块）| ✅ | `b92eed6` |
| 接口层（6 契约 + 错误类）| ✅ | `f2b3845` |
| 实现层（src/ + tests/）| ✅ | 见下 |

> **下一步**：v1 候选（msm_exec 完整签名 + permission schema 真实集成 / opencode.json 主仓集成 / RR7 完整 slash command）。

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
| 1 | **主仓 opencode.json 集成** | v0 完成；主仓改动需单独 SESSION（修 default_agent throw bug + 禁 cheap-worker + 加 plugin 字段 + 修 permission）|
| 2 | **msm_exec 完整签名（v1）** | 当前 v0 = `{msm_name, args}`；v1 可能加 `cwd` / `timeout` / `env` |
| 3 | **permission schema 真实集成（v1）** | 当前 v0 用 tool.execute.before hook 拦截；v1 可改用 permission.ask hook（若宿主触发）+ opencode.json |
| 4 | **RR7 完整 slash command（v1）** | v0 用 system.transform 注入；v1 期望 SDK 暴露 registerCommand 或自实现 |
| 5 | **plugin 仓的"开发期测试"** | 当前 vitest 测纯逻辑；v1 可加集成测试（在真实 serenity 主仓中跑）|

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
| 23:30 | 实现层（src/ 9 文件 + tests/ 6 文件）| `b3a1f9c`（待定）|

### 22 文件清单（最终）

| 路径 | 用途 |
|------|------|
| `README.md` | 决策对账表 D1-D12 + 5 条 R1-R5 引用（旧版入口）|
| `SESSION.md` | 本文件 |
| `.gitignore` | Node + TS + 编辑器 |
| `.npmrc` | pnpm 友好配置 |
| `.nvmrc` | Node 20 |
| `package.json` | scripts + deps（含 `@opencode-ai/plugin@1.15.13` + `zod@4.1.8`）|
| `tsconfig.json` | TS 5.x + ES2022 + strict + Node 20+（rootDir=src）|
| `tsconfig.test.json` | tests include 扩展 |
| `vitest.config.ts` | vitest + node 环境 |
| `src/index.ts` | plugin 入口（10 步启动协议）|
| `src/activation.ts` | tryActivate：RR1+RR2+RR6 验证 |
| `src/state.ts` | 全局激活状态 singleton |
| `src/types/index.ts` | 内部类型（SerenityState 等）|
| `src/errors.ts` | 10 个 SerenityError 子类 |
| `src/util/git.ts` | findGitRoot + isPathInside + git 操作 |
| `src/util/serenity-file.ts` | 读 `/.serenity` 文件 |
| `src/util/path.ts` | buildSkillPath + validateSkillExists + isValidInstanceName |
| `src/msm.ts` | msmListTool + msmExecTool |
| `src/bash-override.ts` | bashOverrideTool（同名 bash 抛 BashDisabledError）|
| `src/permission.ts` | tool.execute.before hook（防 cwdRoot 外访问）|
| `src/commands.ts` | systemTransformHook（注入 RR3/RR7 提示）|
| `tests/*.test.ts` | 6 test files / 24 tests |
| `docs/requirements-v0-scope.md` | RR1-RR7 正式范围层（102 行）|
| `docs/architecture-v0.md` | 方案层（10 步 + 5 模块，219 行）|
| `docs/contract-v0.md` | 接口层（6 契约 + 10 错误，431 行）|
| `docs/requirements-v0-summary.md` | 旧 R1-R5 引用（保留演进历史）|

### 远程仓

- `git@home.gitlab:yh/opencode-serenity-plugin.git` — private, default_branch=main
- Web: `http://home.gitlab/yh/opencode-serenity-plugin`
- commits（5+）：`99e95a3` → `09810ef` → `70db320` → `b92eed6` → `f2b3845` → `b3a1f9c`（实现层，待定）

---

## 最近变更

- 2026-06-04 23:30 — v0 实现层完成：24 tests pass / typecheck green / build green（待 commit `b3a1f9c`）
- 2026-06-04 22:30 — 接口层 6 契约 + 10 错误类（commit `f2b3845`）
- 2026-06-04 22:00 — 方案层 10 步启动协议（commit `b92eed6`）
- 2026-06-04 21:30 — 范围层 RR1-RR7 文档化（commit `70db320`）
- 2026-06-04 21:00 — SESSION 模式迁移（commit `09810ef`）
- 2026-06-04 21:00 — 项目框架 12 文件（commit `99e95a3`）

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
