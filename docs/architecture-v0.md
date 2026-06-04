# Plugin Architecture v0 — 方案/设计层

> **会话**：2026-06-04--opencode-serenity-plugin
> **状态**：范围/边界层已关闭（`docs/requirements-v0-scope.md`），本文件进入方案/设计层。
> **范围**：v0 plugin 整体架构 + 启动协议 + 模块划分 + 数据流 + 失败模式。
> **不进**：接口/契约层（`docs/contract-v0.md`）和实现/代码层（`src/`）。

---

## 1. 顶层架构图

```
┌─────────────────────────────────────────────────────────────┐
│                  opencode 宿主运行时（任何 cwd）                │
│                                                              │
│  ┌────────────────┐    启动时（一次）                          │
│  │  plugin 加载    │ ─────────────────────────┐               │
│  │  (loader.ts)   │                          ▼               │
│  └────────────────┘     ┌───────────────────────────────┐    │
│                        │  opencode-serenity-plugin      │    │
│                        │  src/index.ts (entry)          │    │
│                        │                                │    │
│                        │  ┌─────────────────────────┐  │    │
│                        │  │  activation.ts（10 步）    │  │    │
│                        │  │  1-3 RR6 + RR1 检查       │  │    │
│                        │  │  4-7 读实例名 + 找 skill   │  │    │
│                        │  │  8-10 注入 + 注册 hooks    │  │    │
│                        │  └─────────────────────────┘  │    │
│                        │           │                     │    │
│                        │           ▼                     │    │
│                        │  ┌─────────────────────────┐  │    │
│                        │  │  plugin 状态:            │  │    │
│                        │  │  {active, instance,      │  │    │
│                        │  │   skill_path, cwd_root}  │  │    │
│                        │  └─────────────────────────┘  │    │
│                        └───────────────────────────────┘    │
│                                  │                            │
│                                  ▼                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │  opencode runtime（如果 plugin 不激活 = 原始）       │    │
│  │  如果 plugin 激活 = 注入 SKILL.md + 注册 hooks       │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│   运行时 hooks（如果激活）：                                    │
│   • tool.execute.before — 拦截 bash 抛错（RR3）              │
│   • permission.asked — 弹窗自动 allow/deny（部分场景）       │
│   • tool 注册 — 同名 bash tool（RR3）+ msm_list + msm_exec  │
│   • command 注册 — /serenity-init（RR7）                    │
└─────────────────────────────────────────────────────────────┘
```

## 2. 启动协议 — 10 步

**触发**：opencode 启动时，plugin loader 加载 plugin 模块（`src/index.ts` 的 default export 异步函数被调用一次）。

**前提**：`api: PluginAPI` 参数提供 context、log、register、inject 等能力（来自 `@opencode-ai/plugin@1.15.13`）。

| 步 | 动作 | 失败处理 | 来源 |
|---|------|---------|------|
| 1 | plugin 加载 | — | opencode 框架 |
| 2 | `cwd = process.cwd()` | 异常 → 立即 throw（plugin 完全失败）| RR1 隐含 |
| 3 | `git rev-parse --show-toplevel` 检查 cwd 根是否在 git repo | 失败 / 不在 → **不激活**（log debug 级，return 原始 api）| RR6 |
| 4 | 读 `<git_root>/.serenity` 文件 | 文件不存在 / 读失败 → **不激活** | RR1 |
| 5 | 解析 `/.serenity` 文件内容为实例名 N（trim 首尾空白）| 空内容 / 多行 → **不激活** + log warn | RR1 |
| 6 | 检查 `<git_root>/.opencode/skills/<N>/SKILL.md` | 不存在 → **不激活** + log warn（实例名找不到对应 skill）| RR2 |
| 7 | 缓存激活状态 `{active: true, instance: N, skill_path, cwd_root}` | — | 内部 |
| 8 | 注册 `/serenity-init` slash command（RR7）| — | RR7 |
| 9 | 注册同名 bash tool（抛错版，覆盖 opencode 内置）| — | RR3 |
| 10 | 注册 `msm_list` + `msm_exec` tool | — | R2 |

**返回**：`{ tool, command }`（plugin 接口契约）

**重要约束**：
- **前 6 步**任意失败 → `return {}`（即 plugin 啥也不做，**就像没装一样**——Q6 用户原话）
- **不 throw**（抛错会中断 opencode 启动，且违反"不工作"语义）
- **不 log error**（用 log.debug 或 log.warn——不污染用户）

## 3. 模块划分

```
src/
├── index.ts              ← plugin 入口（默认 export async (api) => {...}）
├── activation.ts         ← 10 步启动协议（核心状态机）
├── state.ts              ← 激活状态管理（缓存 + getter）
├── msm.ts                ← msm_list + msm_exec 工具实现
├── permission.ts         ← permission 策略（cwd 内 allow / cwd 外 deny）
├── commands.ts           ← /serenity-init slash command 实现
├── types/
│   ├── index.ts          ← 公共类型导出
│   ├── msm.ts            ← MSM 工具入参/出参类型
│   ├── state.ts          ← ActivationState 类型
│   └── sdk.d.ts          ← 补 @opencode-ai/plugin 缺失的 type
├── util/
│   ├── git.ts            ← git root 探测（RR6）
│   ├── serenity.ts       ← /.serenity 读 + 实例名解析
│   └── log.ts            ← 统一 log wrapper（带激活状态）
└── errors.ts             ← 自定义错误（PluginNotActive / InstanceMismatch / etc.）

tests/
├── activation.test.ts    ← 10 步启动各分支
├── msm.test.ts           ← msm_list / msm_exec
├── permission.test.ts    ← cwd 内/外判定
├── commands.test.ts      ← /serenity-init 5 子点
├── state.test.ts         ← 激活状态缓存
└── util/
    ├── git.test.ts
    ├── serenity.test.ts
    └── log.test.ts
```

## 4. 数据流

### 4.1 启动阶段（一次性）

```
opencode 启动
  ↓
plugin loader 调用 src/index.ts
  ↓
activation.activate(api, cwd)
  ↓
[10 步流程]
  ↓
返回 { tool, command, hook } 注册到 opencode
```

### 4.2 工具调用阶段（每次）

```
LLM 决定调工具
  ↓
opencode 查 tool 注册表
  ├─ msm_list  ─→  src/msm.ts#msmList   →  读 cwd/.opencode/skills/<instance>/references/mech-registry.json
  ├─ msm_exec  ─→  src/msm.ts#msmExec   →  1. 校验 msm_name 在注册表
  │                                          2. msm_exec({msm_name, args})
  │                                          3. npx tsx / 子进程调用对应 MSM
  │                                          4. 返回 stdout/stderr/exitCode
  └─ bash       ─→  src/msm.ts#bashOverride（或内置）→ 抛 PluginNotActive（已在 RR3 阶段直接 throw）
  ↓
permission 钩子拦截（如果 permission.asked 触发）
  ├─ cwd 内（isInsideCwd）→ allow
  └─ cwd 外 → deny
  ↓
执行结果回 LLM
```

### 4.3 关键判定

| 判定 | 函数 | 来源 |
|------|------|------|
| cwd 在 git repo 内 | `isInsideGitRepo(cwd)` | RR6 |
| cwd 根是 git root | `getGitRoot(cwd)` | RR6 |
| cwd 根有 `/.serenity` | `hasSerenityMarker(gitRoot)` | RR1 |
| 实例名 N 解析 | `parseInstanceName(content)` | RR1 |
| skill 路径存在 | `resolveSkillPath(gitRoot, N)` | RR2 |
| 路径在 cwd 内（perms）| `isInsideCwd(path, cwdRoot)` | RR4/RR5 |

## 5. 与主仓关系

| 维度 | plugin 仓 | 主仓（home-serenity）| 其他工作项目 |
|------|----------|-------------------|------------|
| `/.serenity` | ❌ | ✅（内容 = `home-serenity`）| ❌ |
| 是 git repo | ✅ | ✅ | 视情况 |
| 加载 plugin 时激活？ | ❌（plugin 仓不满足 RR1）| ✅ | ❌ |
| 行为 | plugin **开发** | plugin **生效** | opencode 默认行为 |

**plugin 仓** = plugin **工程实践**（git 维护、tsconfig 严格、vitest 单测、commit 历史）
**主仓** = plugin **运行时宿主**（plugin 激活后所有行为以 cwd = 主仓根为基础）
**plugin 不需要知道"主仓"在哪**——只看 cwd

## 6. 失败模式

| 失败 | 行为 | 用户可见性 |
|------|------|----------|
| cwd 不在 git repo | plugin 完全不激活 | opencode 默认行为（无变化）|
| `/.serenity` 不存在 | plugin 不激活 | 同上 |
| `/.serenity` 内容为空 | plugin 不激活 | log warn（仅 debug 级可见）|
| `/.serenity` 找不到对应 SKILL.md | plugin 不激活 | log warn |
| msm_name 不在注册表 | `msm_exec` 抛 `MsmNotRegisteredError` | LLM 看到错误消息 |
| bash 被 LLM 调用 | 抛 `BashDisabledError` | LLM 看到错误消息（RR3 行为）|
| cwd 外工具调用（read/edit/write）| `permission.asked` → 自动 deny | LLM 看到拒绝消息 |
| 外部 slash command（如 `/clear`）| 不拦截 | opencode 默认行为 |

## 7. 演进路径（v0 → v1+）

v0 实现后，下一步**不在 v0 范围**：

- **v1+ 候选 1**：实现 `permission.asked` hook 自动 reply（解决"100% 无弹窗"——L5 不可行项）
- **v1+ 候选 2**：实现 `experimental.session.compacting` hook（确保压缩后重注入 SKILL.md）
- **v1+ 候选 3**：`shell.env` hook 注入 `$HOME_SERENITY_ROOT` 等环境变量
- **v1+ 候选 4**：多实例 registry（如果用户超过 3 个实例时）

## 8. 与 SDK 对接点（仅作参考，实现层定义）

| 抽象层概念 | SDK 实现 | 文档 |
|----------|--------|------|
| 工具注册 | `api.registerTool({ name, description, parameters, execute })` | @opencode-ai/plugin 1.15.13 |
| slash command | `api.registerCommand({ name, description, execute })` | 同上 |
| permission 钩子 | `api.on('permission.asked', handler)` | 同上 |
| 注入 prompt | `api.inject({ prompt: '...' })` | 同上 |

> ⚠️ 上述 API 是基于 L2 调研推断；实现层需要在 `pnpm install` 后**读 `node_modules/@opencode-ai/plugin/dist/*.d.ts`** 验证。

---

## 9. 文档演进规则

- **范围层**（RR1-RR7）→ `docs/requirements-v0-scope.md`（已落盘）
- **方案层**（本文）→ `docs/architecture-v0.md`（本文）
- **接口层**（msm_exec 签名等）→ `docs/contract-v0.md`（待写）
- **实现层** → `src/`
- **测试层** → `tests/`
- **SESSION 跟踪** → `SESSION.md`（项目即会话）

---

> **本文件完成时间**：2026-06-04
> **下一文档**：`docs/contract-v0.md`（接口/契约层）
> **再下一**：`src/` 实现层
