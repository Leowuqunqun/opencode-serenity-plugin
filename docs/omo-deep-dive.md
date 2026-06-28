# OMO Deep Dive — oh-my-openagent 如何绕过 opencode plugin 机制的限制

> **SESSION**: S035 — Plugin 长期活跃开发
> **调研日期**: 2026-06-28
> **作者**: headless research agent (loop-omo-deep-dive)
> **基线**:
> - 高层概览：[`AI_LAB/opencode-serenity-plugin/docs/delegate-mechanism-survey.md`](./delegate-mechanism-survey.md) §2.1
> - OMO 仓库：`code-yeongyu/oh-my-openagent` @ `dev` 分支（commit `f7ec55526b2a3603665c5c0308b031a4f14900b0`）
> - OC 源码：`sst/opencode` @ `dev` 分支
> - ACC 当前版本：opencode-serenity-plugin v0.5.21

---

## 0. TL;DR — 8 条核心结论

1. **OC plugin 的"硬限制"是结构性的，不是配置缺陷**——OC 提供了 18 个 hook event（包括 7 个 `experimental.*`），但全部用 `(input, output) => Promise<void>` 单向 mutate-in-place 模式；无 priority、无 short-circuit、无 abort；hook 按 plugin load 顺序串行执行（B1 表）。
2. **OMO 完全不动 OC 的 `task` tool**，通过 7 层抽象叠加实现 delegate 增强：(a) 同名 tool 替换 vs 平行注册新 tool (b) `tool.execute.before/after` 改 args (c) 自建 session-tools-store (d) 自建 BackgroundManager (e) `experimental.chat.system.transform` 注入 prompt (f) `client.session.prompt` 直接调用 (g) **直接写 OC JSON storage 目录绕过 `chat.message` hook 链**（`MESSAGE_STORAGE` trick，B2-g）。
3. **54 个 hooks 用"5 tier + safe-create-hook 工厂 + hook enable/disable 配置"组合**——没有任何 hook 优先级机制，靠 (1) `safeCreateHook()` try/catch 包住每个工厂 (2) `isHookEnabled(name)` 配置开关 (3) tier 内执行顺序由代码顺序定义 (4) 跨 tier 用 shared 状态 + 回调注入（B3）。
4. **OMO 在 OC DB 之外维护了至少 14 个独立状态层**——session-tools-store、concurrency buckets、parent-wake queue、root-descendant-counts、pendingByParent、claude-code-session-state、delegated-child-session-bootstrap、task-registry、background-task-marker（写盘）、session-prompt-params-state、session-category-registry、tmux 状态、live-server-route 缓存、attempt-lifecycle。**全部进程内 Map/Set，重启即丢**（B4）。
5. **Category 系统 = 数据驱动的 subagent 类型 + 间接路由层**——`task(category="x")` 实际 spawn **Sisyphus-Junior**（一种无法再 delegate 的"叶子 agent"），category 配置决定 model/variant/temperature/thinking/tools/prompt_append。**Category 是 `subagent_type` 之上的语义层**，不是平替（B5）。
6. **OMO 的 6 大"违反直觉"绕过范式**：(1) `output.output`/`output.parts[].text` 是**可变引用**，可 mutate（`delegate-task-retry`、`empty-task-response-detector`）；(2) `throw new Error(msg)` 可当**拒绝+指令**双重作用（`tasks-todowrite-disabler`、`claude-code-hooks`）；(3) **磁盘写 JSON 文件**直接注入消息到 OC session，跳过整个 hook 链（`MESSAGE_STORAGE`）；(4) `session.promptAsync` vs `session.prompt` 切换 + 自管 FIFO 队列绕过 OC 的单进程模型；(5) `subagentSessions: Set<string>` 强制走 in-process 路径（`live-server-route`）；(6) `isAgentNotFoundError(error)` 字符串匹配硬编码 OC 错误信息做 fallback 重试。
7. **可移植 vs 不可移植的边界**：`safeCreateHook` 模式 / ContextCollector 模式 / `tool.execute.after` output mutation 模式 / Category 数据驱动配置模式 **4 类可直接移植**；BackgroundManager（重 1400 行+）/ MESSAGE_STORAGE 磁盘写 trick / `prompt-async-gate`（重设计 queue）**部分移植**；`output.output` mutation 依赖 OC 内部传引用语义（API 未承诺）/**不可移植**。
8. **D24+ 优先级排序（基于本调研更新 S015/调研报告的 P0-P2）**：
   - 🔴 **D24 P0** — **Category-aware subagent routing**（OMO `task(category="x")` 模型，落地为 D24 `task-tool-category` plugin hook）
   - 🔴 **D25 P0** — **ContextCollector 模式**（OMO `features/context-injector/collector.ts` 的 session-scoped ephemeral staging buffer）
   - 🟡 **D26 P1** — **`safeCreateHook` 工厂** + hook enable/disable 配置系统（提高 ACC 健壮性）
   - 🟡 **D27 P1** — **BackgroundManager 简化版**（只保留 depth limit + concurrency bucket，不做 tmux / team mode）
   - 🟢 **D28 P2** — **`tool.execute.after` output mutation**（用于 delegate 错误注入 / task retry guidance）
   - ⚪ **Dead-end** — 直接写 MESSAGE_STORAGE 磁盘（B6.5）；替换 `task` tool（B6.6）

---

## B1 — OpenCode Plugin 硬限制清单（Baseline）

> 所有 file:line 引用基于 `sst/opencode` @ `dev` 分支的 raw 文件。

### B1.0 整体架构判定

OC plugin 系统是 **mutation-only 表面**：
- 18 个 hook event（包括 7 个 `experimental.*`）
- 每个 hook 单一签名 `(input, output) => Promise<void>`，output 是 mutate-in-place 对象
- Hook 串行按 plugin load 顺序执行，**无 priority / abort / merge**
- 无中央"tool dispatch 拦截点"
- Part / Message / Session 联合类型**闭合**，不能新增变体

来源：
- `packages/plugin/src/index.ts:257-395` Hooks 接口
- `packages/opencode/src/plugin/index.ts:252-264` `Plugin.trigger` 串行 for 循环
- `packages/opencode/src/tool/registry.ts:213-216` `[...builtin, ...custom]` 无 dedup

### B1.1 硬限制清单（20 条）

| # | 限制 | 触发源码 | 官方解释（推断） |
|---|------|---------|-----------------|
| **L1** | **不能修改 OC 核心 type registry** | `packages/sdk/js/src/v2/gen/types.gen.ts:579-589` Part 联合类型 | 闭合 discriminated union；插件无法添加新 Part 变体 |
| **L2** | **不能拦截 task tool 的 parentID 派生** | `packages/opencode/src/tool/task.ts:121-122` `parentID: ctx.sessionID` 硬编码 | 没有 subagent spawn hook；sessions.create 调用无插件拦截点 |
| **L3** | **不能改写 session 持久化层** | `packages/opencode/src/plugin/index.ts:198-205` event 只读 + `session/prompt.ts:705` chat.message 在 persist 之前 | 插件观察事件，无法拦截 sessions.updateMessage / sessions.updatePart 写盘 |
| **L4** | **不能直接获得 "subagent 完成时主 agent 自动唤醒" 的硬保证** | `packages/opencode/src/tool/task.ts:217-241` inject 用 `ops.prompt` 写 synthetic text part | wake-up 依赖父 session 处于 active 状态；父 session paused/aborted 时无 ACK/retry |
| **L5** | **不能阻止 LLM 自由选择调哪个 tool** | `packages/opencode/src/tool/registry.ts:213-216` + `:235-251` | `[...builtin, ...custom]` 无 dedup；只有 WebSearch/Edit/Write/ApplyPatch 4 个 hardcoded per-model filter |
| **L6** | **不能控制 subagent 的递归深度（OC 默认 deny 但有限）** | `packages/opencode/src/tool/task.ts:209` 硬 deny `task` 在 subagent | 没有 max-depth check；只有 `cfg.experimental.primary_tools` 一种层级限制 |
| **L7** | **不能跨进程共享内存（plugin in-process）** | `packages/opencode/src/plugin/index.ts:198-205` `event.location?.directory === ctx.directory` | 跨目录事件被过滤；插件不能看其他项目的 session |
| **L8** | **不能优先级排序 hooks** | `packages/opencode/src/plugin/index.ts:252-264` `for (const hook of s.hooks)` 串行 | 无 priority 字段，无 abort，无 merge |
| **L9** | **不能 short-circuit 一个 tool 调用** | `packages/plugin/src/index.ts:300-308` tool.execute.before 输出 void | 没有方法跳过 `item.execute(args, ctx)`；只能 mutate args |
| **L10** | **不能 override 内置 tool 的 execute** | `packages/opencode/src/tool/registry.ts:253-269` tool.definition hook 只允许 mutate description/parameters | `execute: tool.execute` 透传；插件不能改写 builtin 行为 |
| **L11** | **不能确定性地 shadow 内置 tool** | `packages/opencode/src/tool/registry.ts:213-216` 同 id 工具同时存在 | 数组不去重；行为未定义（AI SDK 先选哪个执行哪个） |
| **L12** | **不能注入自定义 Part 类型** | `packages/sdk/js/src/v2/gen/types.gen.ts:579-589` | Part 闭合联合；只能填充现有变体（text/tool/subtask/...） |
| **L13** | **不能拦截 LLM stream / tool-call 决策** | `packages/opencode/src/session/prompt.ts:825-885` 主循环 | AI SDK `streamText`/`generateText` 直接调用，无插件 wrap；插件只能看到 model 已决定的 args |
| **L14** | **不能在 spawn 时影响 subagent session 元数据** | `packages/opencode/src/tool/task.ts:121-145` sessions.create 字段固定 | sessions.create 仅接受 parentID/title/agent/permission；无 metadata/system/variant/tools override |
| **L15** | **不能 mid-session unsubscribe hook** | `packages/opencode/src/plugin/index.ts:155-185` 启动时 push | hooks 只能通过 dispose finalize 移除 |
| **L16** | **不能观察 tool 的 providerExecuted 标志** | `packages/opencode/src/session/tools.ts:76-100` | tool.execute.before payload 缺 providerExecuted/MCP server 区分 |
| **L17** | **不能跨 session 读取 Session.metadata** | `packages/opencode/src/plugin/index.ts:198-205` | 插件只在 init 时获得 directory/project；无跨 session 查询 API |
| **L18** | **不能在 mid-flight 修改 active session 的 permission ruleset** | `packages/opencode/src/tool/task.ts:135-145` setPermission 仅 prompt() 范围 | 插件无法在 Permission.evaluate 之前插入自定义规则类型 |
| **L19** | **不能扩展传给 plugin tool 的 ToolContext** | `packages/plugin/src/tool.ts:4-19` | 只见 sessionID/messageID/agent/directory/worktree/abort/ask；无 model/messages |
| **L20** | **不能绕过 permission.ask 决策** | `packages/opencode/src/plugin/index.ts` | permission.ask hook 只看最终 Permission 请求；不能插入新规则 |

### B1.2 OC 提供的"间接路径"清单（plugin 可用）

虽然 B1.1 列出 20 条限制，但 OC 仍提供了**6 条间接路径**供插件扩展 delegate：

| 路径 | 源码依据 | 风险等级 |
|------|---------|---------|
| **同名 tool 完全替换** | `packages/plugin/src/tool.ts` `tool()` helper + `registry.ts:213-216` `[...builtin, ...custom]` | 高——失去 OC 内置派生逻辑 |
| **`tool.execute.before` 改 args** | `packages/opencode/src/session/tools.ts:90-94` builtin + `:131-135` MCP + `session/prompt.ts:354-358` task tool | 低——只能加字段、改字段 |
| **`tool.execute.after` 改返回值** | 同上 | 低——可注入元数据、改 title，但无法阻止 subagent 已启动 |
| **配置层 agent.{name}.{...}** | `packages/opencode/src/agent/agent.ts` + `core/v1/config/config.ts` | 中——声明式，不需代码 |
| **`experimental.primary_tools`** | `packages/opencode/src/tool/task.ts:209-211` | 低——数组内 tool 在 subagent 默认禁用 |
| **`client.session.create({ parentID })` SDK 直接调用** | `packages/sdk/js/src/v2/gen/sdk.gen.ts` | 高——脱离 `task` tool，失去派生 permission/background job |

---

## B2 — OMO 绕过范式分类（7 大类）

OMO 用 7 大绕过范式逐项回应 B1 的限制。每条标注"对应 L# + 关键源码 + 工程评价"。

### B2.a 同名 tool 替换 vs 平行注册新 tool

**绕过**：L5（不能阻止 LLM 选 tool）+ L11（不能确定性 shadow）

**OMO 策略**：**不替换 `task`，而平行注册 `call_omo_agent` + 12 个 `team_*` tool**（Team Mode 时）。LLM 通过 description 自然分流——OMO 的 `task` 描述含丰富 category 表 + skill 提示，而 `call_omo_agent` description 明确说"Allowed agents: explore, librarian"。

**关键源码**：
- `packages/omo-opencode/src/tools/call-omo-agent/tools.ts:60-95` — `execute` 流程
- `packages/omo-opencode/src/tools/call-omo-agent/constants.ts` — description 全文
- `packages/omo-opencode/src/features/team-mode/` — 12 个 team_* tool（`team_create`, `team_send_message`, `team_task_create` 等）

**评价**：✅ 这是最稳健的范式。代价是 LLM 必须被"教会"用哪个 tool（OMO 通过 keyword-detector + system-prompt-append + context-injector 三重机制实现）。

### B2.b `tool.execute.before/after` 改 args 注入（policy injection）

**绕过**：L9（不能 short-circuit）+ L18（不能 mid-flight 改 permission）

**OMO 策略**：
- **delegate-task-retry**（`hooks/delegate-task-retry/hook.ts:14-27`）：订阅 `tool.execute.after`，匹配 `tool === "task"`，如果输出匹配 `DELEGATE_TASK_ERROR_PATTERNS`，**append 重试指引到 output.output**。
- **empty-task-response-detector**（`hooks/empty-task-response-detector.ts:11-25`）：订阅 `tool.execute.after`，如果 task 输出为空字符串，**替换** `output.output = EMPTY_RESPONSE_WARNING`。
- **tasks-todowrite-disabler**（`hooks/tasks-todowrite-disabler/hook.ts:9-30`）：订阅 `tool.execute.before`，**throw new Error(REPLACEMENT_MESSAGE)** 阻止 TodoRead 调用——错误消息本身是指令。
- **claude-code-hooks**（`hooks/claude-code-hooks/`）：把 CC 的 `PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop` 全部映射到 OC 的 4 个 hook 上——通过 throw 阻止 + `replaceToolArgs` 改 args + `output.context.push()` 注入 context。

**关键技术发现**：`output.output` 是**可变引用**（不是冻结对象）。`tools.ts:76-100` 直接把 mutate 后的 output 透传。**这是 OC 的实现细节，API 未承诺稳定**——S026 plugin-debt-audit 应记录这个依赖。

**关键源码**：
- `delegate-task-retry/hook.ts:14-27`（27 行）
- `empty-task-response-detector.ts:11-25`（26 行）
- `tasks-todowrite-disabler/hook.ts:9-30`（33 行）
- `claude-code-hooks/claude-code-hooks-hook.ts:13-30`（hook 注册映射表）

**评价**：✅ 最低侵入路径，但**强耦合 OC 内部传引用语义**。ACC 落地 D28 时应**在 SESSION 中记录风险**，并对每个 mutation 用 try/catch 包住（任何 mutation 失败不应破坏主流程）。

### B2-c 自建 session-tools-store

**绕过**：L14（不能在 spawn 时影响 subagent session 元数据）+ L6（不能控制 subagent 工具集）

**OMO 策略**：**绕过 OC 的 per-session tool 配置缺失**，自建 `Map<sessionID, Record<toolName, boolean>>`（`shared/session-tools-store.ts`，23 行）。在 `manager.ts:startTask()` launch 时调用 `setSessionTools(sessionID, launchTools)`；后续 `dispatchInternalPrompt` 时 `resolveInheritedPromptTools(sessionID, fallbackTools)` 读出。

```ts
// packages/omo-opencode/src/shared/session-tools-store.ts:6-19 (full file)
const store = new Map<string, Record<string, boolean>>()

export function setSessionTools(sessionID: string, tools: Record<string, boolean>): void {
  store.set(sessionID, { ...tools })
}
export function getSessionTools(sessionID: string): Record<string, boolean> | undefined {
  const tools = store.get(sessionID)
  return tools ? { ...tools } : undefined
}
```

**launchTools 构造**（`features/background-agent/manager.ts:543-548`）：
```ts
const launchTools = {
  task: false,                // 禁止嵌套
  call_omo_agent: true,       // 允许
  question: false,            // 阻塞用户
  ...userDenied,              // 用户层 deny
  ...getAgentToolRestrictions(input.agent, { includeTeamToolDenylist: ... }),
}
setSessionTools(sessionID, launchTools)
```

**评价**：✅ **ACC 直接可移植的最简单范式之一**。对应 D24 第一步：实现 `serenity-session-tools-store.ts`，落 `Map<sessionID, { serenityTools: { msm_list: true, ... } }>`。

### B2-d 自建 BackgroundManager 状态机 + parent wake

**绕过**：L4（不能保证 subagent 完成时主 agent 唤醒）+ L6（不能控制递归深度）+ L17（不能跨 session 查询）

**OMO 策略**：**完全独立的状态机**，约 1400 行（`features/background-agent/manager.ts`），3 大机制：

#### B2-d-1 depth limit（绕过 L6）
```ts
// features/background-agent/subagent-spawn-limits.ts
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3
// resolveSubagentSpawnContext: 向上 walk parentID，O(depth) 次 client.session.get
// assertCanSpawn: childDepth > maxDepth → throw createSubagentDepthLimitError
```
- **数据来源**：OC DB（`client.session.get` walk `parentID`）
- **状态**：纯函数，无本地缓存
- **默认值**：3（OMO 配置覆盖 5）
- **失败模型**：**fail-closed**——任何 OC API 失败都 throw

#### B2-d-2 concurrency bucket（绕过 L4）
```ts
// features/background-agent/concurrency.ts
private counts: Map<string, number> = new Map()
private queues: Map<string, QueueEntry[]> = new Map()
// getConcurrencyKey: modelID > providerID > model
// acquire: if (count < limit) ++count; else queue.push({resolve, reject})
// release: if (queue.length > 0) queue.shift().resolve()  // hand-off
//         else counts[key]--
```
- **Bucket key**：raw model string（如 `anthropic/claude-sonnet-4-7`）或 provider prefix
- **0 overload**：表示 unlimited（配置 footgun）
- **Hand-off 模式**：count 不变传递——避免瞬间归零让后来者挤入

#### B2-d-3 parent wake notifier（绕过 L4 + L17）
```ts
// features/background-agent/parent-wake-notifier.ts
// queuePendingParentWake(sessionID, notification, promptContext, shouldReply, delayMs)
//   → debounce 100ms → dispatchAfterSessionIdle
// dispatchInternalPrompt({mode: "async", sessionID, body: {noReply: ..., parts: [{type:"text", text: <system-reminder>...</system-reminder>}]}})
//   → 经过 prompt-async-gate 去重 + 队列 + idle settle
// 失败 retry：5s 内若无输出，重新入队（MAX 1 次）
```
- **dispatchInternalPrompt 包装**（`shared/prompt-async-gate.ts` → `packages/utils/src/prompt-async-gate.ts`）：
  1. Live vs in-process 路由（`tryResolveDispatchClientSync`）
  2. Reservation mutex（`getActiveReservation`）
  3. Semantic dedupe（`coalesceRecentSemanticPromptDispatch`）
  4. FIFO queue + idle settle
  5. Fallback retry with `FALLBACK_AGENT = "general"`

**评价**：⚠️ **BackgroundManager 重 1400 行+**，全套移植不现实。但**3 个子组件**可单独提取：
- **subagent-spawn-limits**（74 行）—— D26 直接可移植为 `serenity-subagent-depth-limit.ts`
- **concurrency**（核心约 100 行）—— D27 简化版可移植
- **parent-wake-notifier**（重 500+ 行含 4 个 collaborator）—— D28+ 才考虑

### B2-e `experimental.chat.system.transform` + `experimental.chat.messages.transform` 在 Category 层

**绕过**：L1（不能修改 OC core type registry）+ 间接绕过 OC prompt 模板

**OMO 策略**：

#### B2-e-1 system-prompt-append（通过 `experimental.chat.system.transform`）
```ts
// 简化：dynamic-agent-prompt-builder.ts 的 buildSisyphusAgent 流程
//   → factory(model) → applyOverrides(config, override, categories, directory)
//   → resolveAgentSkills(config, options)
//   → applyEnvironmentContext 注入 OMO_INTERNAL_INITIATOR 标记 + env vars
// 落地到 OC：hooks/claude-code-hooks-hook.ts 注册 chat.system.transform
```
- **数据源**：8 个 builtin categories + 用户配置的 `categories.{name}.prompt_append`
- **触发**：每个 `chat.system.transform` 事件——等价于 OC 每次构造 prompt 时
- **注入内容**：category prompt_append + skill content + env context

#### B2-e-2 messages-transform（注入 synthetic Part）
```ts
// features/context-injector/injector.ts:98-127
const syntheticPart = {
  id: `prt_synthetic_hook_${sessionID}`,
  messageID: lastUserMessage.info.id,
  sessionID: messageSessionID ?? "",
  type: "text" as const,
  text: pending.merged,
  synthetic: true,
}
lastUserMessage.parts.splice(textPartIndex, 0, syntheticPart as Part)
```
- **关键**：构造一个 `synthetic: true` flag 的 Part 对象，**splice 到 LLM 即将接收的 messages 数组中**
- **绕过**：OC 的 session 持久化——这个 part 不进 DB，只在本次 LLM 调用时存在
- **配合**：MESSAGE_STORAGE（JSON backend）vs messages-transform hook（SQLite backend）的二元路径

**评价**：✅ **ContextCollector 模式（`features/context-injector/collector.ts`）是 ACC 最具移植价值的范式**——session-scoped ephemeral staging buffer，priority 排序 + one-shot consume + source-tagged。

### B2-f SDK `client.session.create` 直接调用

**绕过**：L2（不能拦截 parentID）+ L14（不能影响 spawn 元数据）

**OMO 策略**：`BackgroundManager.startTask()`（`features/background-agent/manager.ts:584-595`）直接调：
```ts
const createResult = await this.client.session.create({
  body: {
    parentID: input.parentSessionId,  // 强制 parentID
    title: `${input.description} (@${input.agent} subagent)`,
    ...(input.sessionPermission ? { permission: input.sessionPermission } : {}),
    ...(input.model ? { model: { id, providerID, variant } } : {}),
  },
  query: { directory: parentDirectory },
})
```

**关键差异** vs OC 原生 `task` tool：
- OMO 显式传 `model: { id, providerID, variant }`——原生 task tool 只接受 `subagent_type`（model 从 agent config 派生）
- OMO 显式传 `sessionPermission`——原生 task tool 用 `deriveSubagentSessionPermission` 派生
- OMO 不传 `permission` 时使用 OMO 自计算的 launchTools
- OMO 不调 `ctx.ask`——直接绕过 permission 询问

**评价**：⚠️ **最暴力但最自由的路径**。失去 OC 的 permission/background/billing 派生逻辑。ACC 若采用，必须自己实现 permission 推导（参考 OMO 的 `deriveSubagentSessionPermission`）。

### B2-g **磁盘写 JSON 文件直接注入消息**（`MESSAGE_STORAGE` trick）

**绕过**：L3（不能改写 session 持久化层）+ L12（不能注入自定义 Part）+ L13（不能拦截 LLM 决策）

**OMO 策略**：**绕过整个 hook 链**——直接写 OC 的 JSON 存储目录：

```ts
// features/hook-message-injector/message-injection.ts:80-145
const messageDir = getOrCreateMessageDir(sessionID)  // <OC_STORAGE>/message/<sid>/
const partDir = join(PART_STORAGE, messageID)        // <OC_STORAGE>/part/<mid>/

writeFileSync(partPath, JSON.stringify(textPart, null, 2))     // 写 part JSON
writeFileSync(messagePath, JSON.stringify(messageMeta, null, 2)) // 写 message JSON
```

`textPart` 标记：
```ts
{
  type: "text", synthetic: true,
  text: createInternalAgentTextPart(content).text,  // 末尾带 <!-- OMO_INTERNAL_INITIATOR -->
  time: { start: now, end: now }, messageID, sessionID,
}
```

**MESSAGE_STORAGE 路径**（`shared/opencode-storage-paths.ts`）：
```ts
export const OPENCODE_STORAGE = getOpenCodeStorageDir()
export const MESSAGE_STORAGE = join(OPENCODE_STORAGE, "message")
export const PART_STORAGE = join(OPENCODE_STORAGE, "part")
```

**绕过原理**：
- OC 的 JSON backend 通过目录扫描 hydrate session
- 写文件 → 下次 scan 时 session 自动包含这条消息
- **chat.message hook 不触发**（因为根本没走 `client.session.prompt`）
- **part.updated event 也不触发**（OC 没有 file watcher）

**SQLite 后端 fallback**（`message-injection.ts:97-104`）：
```ts
if (isSqliteBackend()) {
  log("[hook-message-injector] Skipping JSON message injection on SQLite backend. " +
      "In-flight injection is handled via experimental.chat.messages.transform hook. ...")
  return false
}
```

**评价**：⚠️ **极度脆弱**——
1. 依赖 OC 的 on-disk JSON layout 不变（OC 改名/重构 storage 直接破）
2. SQLite backend 已 fallback 到 `messages.transform` hook
3. OC 1.x 计划用 SQLite 替代 JSON backend（已部分落地）
4. 同步文件 IO 在 OC 主事件循环中是阻塞

**ACC 不可移植**——OC 版本兼容性风险过高。改用 `experimental.chat.messages.transform` 注入 synthetic part（已在 B2-e-2 描述）。

---

## B3 — 54+ Hooks 组合模式

### B3.1 Hook 分类总览（与 delegate 相关性）

| Tier | 数量 | 主要 hook（OMO 已实现） | delegate 相关 |
|------|------|----------------------|---------------|
| **Session** | 24 | preemptive-compaction, session-notification, think-mode, model-fallback, anthropic-context-window-limit-recovery, auto-update-checker, codegraph-bootstrap, ast-grep-sg-provision, agent-usage-reminder, non-interactive-env, interactive-bash-session, ralph-loop, edit-error-recovery, delegate-task-retry, task-resume-info, start-work, prometheus-md-only, sisyphus-junior-notepad, no-sisyphus-gpt, no-hephaestus-non-gpt, hephaestus-agents-md-injector, question-label-truncator, runtime-fallback, legacy-plugin-toast | ✅ delegate 全程跟踪 + retry + 模型回退 |
| **Tool Guard** | 18 | comment-checker, tool-output-truncator, directory-agents-injector, directory-readme-injector, empty-task-response-detector, rules-injector, tasks-todowrite-disabler, write-existing-file-guard, bash-file-read-guard, hashline-read-enhancer, json-error-recovery, read-image-resizer, todo-description-override, webfetch-redirect-guard, fsync-skip-warning, team-tool-gating, notepad-write-guard, plan-format-validator | ✅ delegate 工具过滤 + 防 overwrite |
| **Transform** | 7 | claude-code-hooks, keyword-detector, context-injector-messages-transform, team-mode-status-injector, team-mailbox-injector, tool-pair-validator, monitor-status-injector | ✅ delegate 上下文注入 |
| **Continuation** | 7 | stop-continuation-guard, compaction-context-injector, compaction-todo-preserver, todo-continuation-enforcer, unstable-agent-babysitter, background-notification, atlas | ✅ delegate 完成后通知 + 强制续跑 |
| **Skill** | 2 | category-skill-reminder, auto-slash-command | ⚠️ 仅注入 skill 提示 |
| **总计** | **54 base + 7 team mode** = **61** | | |

### B3.2 Hook 协调机制（无 priority 怎么办？）

OMO 在没有 priority 机制的情况下，用 4 层结构协调 54+ hook：

#### B3.2.1 工厂 + safe-create-hook（plugin-loader 级别安全网）
```ts
// shared/safe-create-hook.ts:5-22 (full file)
export function safeCreateHook<T>(
  name: string,
  factory: () => T,
  options?: { enabled?: boolean }
): T | null {
  const enabled = options?.enabled ?? true
  if (!enabled) return factory() ?? null
  try {
    return factory() ?? null
  } catch (error) {
    log(`[safe-create-hook] Hook creation failed: ${name}`, { error })
    return null
  }
}
```
- 每个 `createXxxHook(ctx, ...)` 都被 `safeHook("name", () => ...)` 包住
- 任何单个 hook 工厂抛错 → null，**插件其余部分照常加载**
- 启用 `experimental.safe_hook_creation: true`（默认）才有这层保护

#### B3.2.2 `isHookEnabled(name)` 配置开关（per-hook 启停）
```ts
// plugin/hooks/create-session-hooks.ts:78-83
const disabledHooks = new Set(pluginConfig.disabled_hooks ?? [])
const isHookEnabled = (hookName: HookName): boolean => !disabledHooks.has(hookName)
```
- 用户配置 `disabled_hooks: ["session-notification", "comment-checker"]` → 这两个 hook 直接是 `null`
- 不返回对象 → OC 的 hook 派发系统视为"未注册"
- 静默失败（不抛错）

#### B3.2.3 Tier 内执行顺序由代码顺序定义（无 priority）
```ts
// plugin/hooks/create-session-hooks.ts:72-200
return {
  preemptiveCompaction,       // 第 1 个注册
  sessionNotification,        // 第 2
  thinkMode,                  // 第 3
  modelFallback,              // 第 4
  // ... 共 24 个
  runtimeFallback,            // 第 23
  legacyPluginToast,          // 第 24
}
```
- **OC 按 object key 顺序遍历 hooks**——但这是 V8 行为，不保证
- 实际上 OMO 的多数 hook 订阅**不同的 OC event**，所以互不干扰
- 同 event 多 hook 时（如多个 hook 都订阅 `tool.execute.after`），按 **plugin load 顺序**，不是 OMO hook 顺序——因为 OMO 是单一 plugin
- OMO 内部的"优先级"靠**共享状态 + 显式回调**实现（如 `BackgroundManager` 被传给多个 hook）

#### B3.2.4 跨 tier 共享状态（manager 注入模式）
```ts
// create-plugin-module.ts:148-176
const managers = deps.createManagers({
  ctx: input, pluginConfig, tmuxConfig, modelCacheState,
  backgroundNotificationHookEnabled: isHookEnabled("background-notification"),
})
const toolsResult = await deps.createTools({ ctx, pluginConfig, managers })
const hooks = deps.createHooks({
  ctx, pluginConfig, modelCacheState,
  backgroundManager: managers.backgroundManager,  // ← 跨 tier 共享
  // ...
})
```
- 4 个 manager 在 plugin 启动时创建（`TmuxSessionManager`, `BackgroundManager`, `SkillMcpManager`, `ConfigHandler`）
- 注入到所有相关 hook 的 factory
- 多个 hook 共享同一个 manager 实例 → 协调通过共享状态

### B3.3 Hook 类型分类（按功能）

#### B3.3.1 状态变更 hook（mutate state, side effect）
- `preemptive-compaction`（session）—— 修改 session 模型
- `comment-checker`（tool-guard）—— 修改 tool output 拒绝评论
- `keyword-detector`（transform）—— 修改 user message text 注入 keyword banner
- `delegate-task-retry`（tool-guard）—— mutate `tool.execute.after` 的 output.output
- `empty-task-response-detector`（tool-guard）—— replace output.output with warning

#### B3.3.2 决策 hook（decide path / block / allow）
- `tasks-todowrite-disabler`（tool-guard）—— throw to block TodoRead
- `permission.ask`（如果 OMO 用）—— 决策 ask/deny/allow
- `unstable-agent-babysitter`（continuation）—— 检测不稳定模型行为决定是否切换

#### B3.3.3 观察 hook（observe and log only）
- `auto-update-checker`（session）—— 检查 OMO 版本
- `codegraph-bootstrap`（session）—— 初始化代码图
- `agent-usage-reminder`（session）—— 提醒调用 agent
- `monitor-status-injector`（transform）—— 注入监控状态

#### B3.3.4 生命周期 hook（start/stop, cleanup）
- `dispose`（顶层）—— plugin unload 时清理所有 manager
- `ralph-loop`（continuation）—— 自循环的 start/stop
- `todo-continuation-enforcer`（continuation）—— 强制续跑 start/stop
- `start-work`（session）—— /start-work 命令的入口
- `stop-continuation-guard`（continuation）—— /stop-continuation 的停止入口

### B3.4 Hook 失败 / 异常处理

#### B3.4.1 工厂阶段
- **safe-create-hook 包住**——构造失败 → null
- 失败原因记录到 `[safe-create-hook] Hook creation failed: <name>`
- **不影响其他 hook**

#### B3.4.2 执行阶段
- **OC 端**：`plugin/index.ts:252-264` 中 `Effect.promise(async () => fn(input, output))` 不 try/catch
- 任何 throw 都被 `Effect.logError` 捕获，但**不停止后续 hook 也不影响主流程**
- **OMO 端**：建议每个 hook 实现都 `try { ... } catch { log }`——避免破坏子流程

#### B3.4.3 dispose 阶段
- `dispose` hook 在 plugin unload 时调用
- OMO 的 dispose 调用 `runtimeSkillSource?.stop()` + 各 manager 的 dispose
- `disposeCreatedHooks(hooks)` 清理 session-level 的 hook

### B3.5 "Hook chain" 模式（一个 hook 调另一个 hook 的结果）

OMO 没有显式的 hook chain，但通过 3 个共享结构实现 hook 间通信：

#### B3.5.1 ContextCollector（features/context-injector/collector.ts）
- 任何 hook 可调 `collector.register(sessionID, {source, id, content, priority})`
- `chat.message` hook 触发时调 `injectPendingContext` —— consume + 注入
- 实现"分布式 producer + 单点 consumer"模式

#### B3.5.2 BackgroundManager（features/background-agent/manager.ts）
- 多个 hook 共享同一个 manager 实例
- 例：`background-notification` 订阅 `event`，`delegate-task-retry` 调 manager API
- 通过共享 Map 实现"hook 协作"

#### B3.5.3 session-tools-store + delegated-child-session-bootstrap
- 任何 hook 写入；manager 启动新 session 时读取
- 实现"hook → manager 数据流"

---

## B4 — 状态管理机制

### B4.1 OMO 维护的 14+ 独立状态层（OC DB 之外）

| # | 状态层 | 文件 | 数据结构 | 持久化 |
|---|--------|------|---------|--------|
| **1** | **session-tools-store** | `shared/session-tools-store.ts` (23 行) | `Map<sessionID, Record<toolName, boolean>>` | 进程内 Map |
| **2** | **session-prompt-params-state** | `shared/session-prompt-params-state.ts` | `Map<sessionID, {temperature, topP, maxOutputTokens, options}>` | 进程内 Map |
| **3** | **session-category-registry** | `shared/session-category-registry.ts` (11 行) | `Map<sessionID, category>` | 进程内 Map |
| **4** | **delegated-child-session-bootstrap** | `shared/delegated-child-session-bootstrap.ts` | `Map<sessionID, {retryParts, fallbackChain, category, system, tools}>` | 进程内 Map |
| **5** | **claude-code-session-state** | `features/claude-code-session-state/state.ts` | `Set<subagentSessions>` + `Map<sessionID, agentName>` | 进程内 |
| **6** | **BackgroundManager.tasks** | `features/background-agent/manager.ts` | `Map<taskId, BackgroundTask>` | 进程内 Map |
| **7** | **BackgroundManager.tasksByParentSession** | 同上 | `Map<parentSessionId, Set<taskId>>` | 进程内 Map |
| **8** | **BackgroundManager.rootDescendantCounts** | 同上 | `Map<rootSessionID, number>` | 进程内 Map |
| **9** | **BackgroundManager.queuesByKey** | 同上 | `Map<modelKey, QueueItem[]>` | 进程内 Map |
| **10** | **ConcurrencyManager.counts/queues** | `features/background-agent/concurrency.ts` | `Map<modelKey, number>` + `Map<modelKey, QueueEntry[]>` | 进程内 Map |
| **11** | **ParentWakeNotifier**（6 maps/sets） | `features/background-agent/parent-wake-notifier.ts` | pending/dispatched/timers/inFlight/preparations/recentActivity | 进程内 |
| **12** | **task-registry** | `features/background-agent/task-registry.ts` | `globalThis[REGISTRY_KEY]` + lazy clone closures | 进程内 globalThis |
| **13** | **ContextCollector** | `features/context-injector/collector.ts` | `Map<sessionID, Map<key, ContextEntry>>` | 进程内 Map |
| **14** | **MESSAGE_STORAGE on disk** | `features/hook-message-injector/message-injection.ts` | `<OC_STORAGE>/message/<sid>/<mid>.json` + `<OC_STORAGE>/part/<mid>/<pid>.json` | **磁盘持久化**（OC JSON backend） |
| **15** | **live-server-route cache** | `shared/live-server-route.ts` | `Map<sessionID, {client, route, reason}>` | 进程内 Map |

### B4.2 OC DB vs OMO 状态边界

#### B4.2.1 OC DB（持久化）负责
- `Session` 记录（`~/.local/share/opencode/storage/session/<sessionID>.json`）
- `Message` 记录（`~/.local/share/opencode/storage/message/<sessionID>/`）
- `Part` 记录（`~/.local/share/opencode/storage/part/<messageID>/`）
- SQLite backend（OC 1.x 新）：`session.db`, `message.db`

#### B4.2.2 OMO 状态（不持久化）负责
- 工具配置（哪 session 能调哪些 tool）
- 类别路由（哪 session 属于哪个 category）
- 并发槽（哪 model bucket 已满）
- 父唤醒队列（哪 parent 欠哪些唤醒）
- 深度计数（哪 root 有多少 descendant）
- 上下文暂存（哪 session 缺哪些 context part）

#### B4.2.3 边界相遇的 3 个点
1. **Prompt dispatch** —— OMO 通过 `client.session.prompt` 写 OC DB（带 OMO 的 tools/promptContext）
2. **Lineage resolution** —— OMO 通过 `client.session.get` 读 OC DB 的 parentID（depth counter 的 source of truth）
3. **Wake safety inspection** —— OMO 通过 `client.session.messages` 读 OC DB 的历史消息（验证 assistant 是否消费了 wake）

### B4.3 重启丢失分析

| 触发 | 丢失的状态 |
|------|-----------|
| **Plugin reload（HMR）** | 模块级 Map 在 reload 时清空；manager 实例重建；所有 in-memory 状态归零 |
| **Process restart** | 同上 + `task-registry`（globalThis）丢失；**OMO 完全失忆** |
| **OC session compaction** | 不影响 OMO 状态（OMO 状态独立） |
| **子 session 删除** | `subagentSessions.delete(sid)` + `clearSessionAgent(sid)` + `clearSessionTools(sid)` + `SessionCategoryRegistry.remove(sid)` |

### B4.4 与 OC DB 的关系总结

| 关系 | OMO 状态 | OC DB |
|------|----------|-------|
| **Mirror** | session-tools-store, session-prompt-params-state | （per-session 的 prompt body.tools 字段） |
| **Override** | launchTools, promptContext | （OC 用 body.tools 字段覆盖 agent 默认） |
| **Standalone** | concurrency buckets, rootDescendantCounts, pendingByParent | （无对应） |
| **Shadow** | MESSAGE_STORAGE disk | session/message DB |

**关键洞察**：OMO 的状态设计哲学是 **"OC DB 是 source of truth for history, OMO state is for next-action decision"**——任何需要"下次该做什么"的状态都在 OMO；任何"过去发生了什么"的事实都在 OC DB。

---

## B5 — Category 系统完整工作流

### B5.1 Category 定义位置

#### B5.1.1 8 个 Builtin Categories

| Category | Model | is_unstable_agent | Use Case |
|----------|-------|-------------------|----------|
| `visual-engineering` | `google/gemini-3.1-pro` (high) | auto (gemini) | 前端 / UI / UX / 设计 |
| `ultrabrain` | `openai/gpt-5.5` (xhigh) | false | 深度逻辑 / 架构决策 |
| `deep` | `openai/gpt-5.5` (medium) | false | 目标导向自动研究 |
| `artistry` | `google/gemini-3.1-pro` (high) | auto (gemini) | 创意 / 艺术任务 |
| `quick` | `openai/gpt-5.4-mini` | false | 单文件 / typo 修复 |
| `unspecified-low` | `anthropic/claude-sonnet-4-6` | false | 未分类低复杂度 |
| `unspecified-high` | `anthropic/claude-opus-4-7` (max) | false | 未分类高复杂度 |
| `writing` | `kimi-for-coding/k2p5` | false | 文档 / 技术写作 |

来源：`packages/omo-opencode/src/config/schema/categories.ts` + `docs/reference/features.md`

#### B5.1.2 CategoryConfig Schema（verbatim）

```ts
export const CategoryConfigSchema = z.object({
  description: z.string().optional(),
  model: z.string().optional(),
  fallback_models: FallbackModelsSchema.optional(),
  variant: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  maxTokens: z.number().optional(),
  thinking: z.object({ type: z.enum(["enabled", "disabled"]), budgetTokens: z.number().optional() }).optional(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  textVerbosity: z.enum(["low", "medium", "high"]).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),          // ← per-category tool override
  prompt_append: z.string().optional(),                          // ← per-category prompt 注入
  max_prompt_tokens: z.number().int().positive().optional(),
  is_unstable_agent: z.boolean().optional(),                     // ← 强制 background mode
  disable: z.boolean().optional(),
})
```

### B5.2 Category → Agent 映射 → Model + Tools + Prompt 链路

```
用户调用: task(category="visual-engineering", prompt="Add a responsive chart", load_skills=["frontend"])
   ↓
[Stage 1: AgentSource 选择]
   category="visual-engineering" → Sisyphus-Junior（动态生成 agent 实例）
   ↓
[Stage 2: Model Resolution]
   applyModelResolution → userOverride (空) → category.model ("google/gemini-3.1-pro") → variant "high"
   ↓
[Stage 3: buildAgent]
   createSisyphusJuniorAgentWithOverrides(category="visual-engineering")
   → 基础 prompt + category.prompt_append (空) + skills content (frontend SKILL.md)
   ↓
[Stage 4: applyOverrides]
   用户级 agent override (空)
   → category.model / variant / temperature / thinking 继承
   ↓
[Stage 5: resolveAgentSkills]
   load_skills=["frontend"] → 加载 frontend SKILL.md → prepend 到 prompt
   ↓
[Stage 6: applyEnvironmentContext]
   注入 OMO_INTERNAL_INITIATOR 标记 + env vars
   ↓
[Stage 7: launchTools 构造]
   {
     task: false,                    // 禁止嵌套
     call_omo_agent: true,           // 允许
     question: false,                // 不阻塞用户
     ...getAgentToolRestrictions("sisyphus-junior", {includeTeamToolDenylist: !teamRunId}),
     ...category.tools (若有),        // per-category tool override
   }
   ↓
[Stage 8: BackgroundManager.launch]
   assertCanSpawn(parentSessionID)  // depth check
   setSessionTools(sessionID, launchTools)
   SessionCategoryRegistry.register(sessionID, "visual-engineering")
   client.session.create({parentID, title, model, agent: "sisyphus-junior", permission: launchTools})
   ↓
[Stage 9: prompt dispatch]
   dispatchInternalPrompt({mode: "async", sessionID, body: {agent, model, tools, system, parts}})
   ↓
[Stage 10: child session 完成]
   parent-wake-notifier → inject <system-reminder>...</system-reminder> 到 parent
```

### B5.3 Category 的运行时决策点

#### B5.3.1 task tool 在 OC 原生 vs OMO 的差异

| 阶段 | OC 原生 `task` | OMO `task` (via call_omo_agent or 包装) |
|------|---------------|----------------------------------------|
| 参数 | `subagent_type` (string) | `category` + `load_skills` + 任意用户字段 |
| Agent 选择 | `subagent_type` 直接查 agent config | category → Sisyphus-Junior 动态生成 |
| Model 派生 | agent.model（静态） | category.model（动态，可 fallback chain） |
| System prompt | agent.prompt | agent.prompt + category.prompt_append + skill content |
| Tools | agent.tools | agent.tools + category.tools（覆盖）+ launchTools 默认 deny |
| 深度限制 | hardcoded deny `task` | depth check via subagent-spawn-limits |
| Concurrency | 无 | per-model bucket |
| Wake | task.ts:217 synthetic text | parent-wake-notifier + dedupe + debounce |

#### B5.3.2 哪些 hook 触发 Category 决策

- **`chat.system.transform`** —— applyModelResolution + applyOverrides + applyEnvironmentContext（每次构造 prompt）
- **`chat.message`** —— categorySkillReminder 注入 category 列表到 user message
- **`tool.execute.after` (tool=task)** —— recordTask / categorize
- **`event (session.idle)`** —— 准备 parent wake if child has category

#### B5.3.3 哪些 tool 暴露 Category

- **`task(category="...", ...)`** —— 原生 OC `task` tool，OMO 通过 `tool.execute.before/after` 拦截 category 参数
- **`call_omo_agent(subagent_type="explore"\|"librarian", run_in_background=true\|false)`** —— OMO 专属 tool，但**不接受 category**（仅 explore/librarian）
- **`team_*`（Team Mode）** —— 接受 category 作为 task 类型标签

### B5.4 与 OC 原生 `subagent_type` 的本质区别

#### B5.4.1 6 大本质差异

1. **间接层** — OMO category 是 `subagent_type` 之上的语义层。`task(category="x")` 实际 spawn Sisyphus-Junior（无法再 delegate 的叶子 agent）。
2. **数据驱动配置** — category 是 `Record<string, CategoryConfig>`，用户可任意增删；OC 原生 type 必须注册新 agent。
3. **Skill + Category 组合** — `task(category="visual-engineering", load_skills=["frontend"])` 产出 Gemini-pro frontend specialist——单 agent 无法表达。
4. **不稳定检测** — `is_unstable_agent` 自动触发 background mode（gemini/minimax）。OC 原生无。
5. **thinking / reasoningEffort / textVerbosity** — Category 内嵌 8 个 reasoning 控制字段。OC 原生 agent 无对应（仅 model/variant）。
6. **prompt_append 继承** — category 可注入 system prompt 而不重复 agent 定义。OC 原生需新 agent。

#### B5.4.2 Category 系统的"双层抽象"价值

```
                  ┌─────────────────────────────────────┐
                  │  用户语义 ("我想做什么")              │
                  │  visual-engineering / deep / quick   │
                  └─────────────────────────────────────┘
                                  ↓
                  ┌─────────────────────────────────────┐
                  │  Category Config (数据驱动)           │
                  │  model + tools + prompt_append      │
                  └─────────────────────────────────────┘
                                  ↓
                  ┌─────────────────────────────────────┐
                  │  Agent Runtime (Sisyphus-Junior)     │
                  │  无法再 delegate 的叶子               │
                  └─────────────────────────────────────┘
```

OC 原生只有 2 层（用户语义 → agent runtime），缺少中间的 category 配置层——导致 model/temperature 路由必须 agent 颗粒度。

---

## B6 — 可复用工程范式清单（关键交付）

> 标注：D24+ 移植优先级 + 落地路径

### B6.1 ✅ Category-aware subagent routing（**D24 P0**）

**OMO 范式**：category 配置驱动 model + tools + prompt + spawn agent

**ACC 移植路径**：
- 落 `serenity-categories.ts`：`{ msm-research, msm-exec, skill-injection, file-edit, code-review, architecture, ... }`
- 每个 category 配置 `model`, `tools: { msm_list: true, ... }`, `prompt_append`
- 通过 `tool.execute.before` 拦截 task tool args，提取 `category` 字段
- 注入到 `experimental.chat.system.transform`（Category prompt_append 注入 system）

**代码骨架**：
```ts
// serenity-plugin/src/features/categories/category-config.ts
export type SerenityCategoryConfig = {
  description?: string
  model?: string
  variant?: string
  temperature?: number
  tools?: Record<string, boolean>
  prompt_append?: string
  maxDepth?: number  // per-category depth override
}

// serenity-plugin/src/features/categories/category-registry.ts
const categoryRegistry = new Map<string, SerenityCategoryConfig>()
export function registerCategory(name: string, config: SerenityCategoryConfig) {
  categoryRegistry.set(name, config)
}
export function getCategoryConfig(name: string): SerenityCategoryConfig | undefined {
  return categoryRegistry.get(name)
}

// serenity-plugin/src/features/categories/category-routing.ts
export function applyCategoryRouting(taskArgs: any, category: string): any {
  const cfg = categoryRegistry.get(category)
  if (!cfg) return taskArgs
  return {
    ...taskArgs,
    model: cfg.model ?? taskArgs.model,
    tools: { ...cfg.tools, ...taskArgs.tools },  // category override
    // OMO 风格：append 而非 replace
    system_prompt_append: cfg.prompt_append,
  }
}
```

### B6.2 ✅ ContextCollector 模式（**D25 P0**）

**OMO 范式**：session-scoped ephemeral staging buffer（`features/context-injector/collector.ts`）

**ACC 移植路径**：
- 落 `serenity-context-collector.ts`：priority 排序 + one-shot consume + source-tagged
- 多个 hook 可写入（profile-injector, category-injector, skill-reminder, ...）
- `chat.message` 触发时 consume 注入到 user message

**代码骨架**：
```ts
// serenity-plugin/src/features/context-collector.ts
type ContextEntry = {
  id: string
  source: "profile" | "category" | "skill" | "todo-reminder" | ...
  content: string
  priority: "critical" | "high" | "normal" | "low"
  registrationOrder: number
  metadata?: Record<string, unknown>
}

const sessions = new Map<string, Map<string, ContextEntry>>()

export const serenityContextCollector = {
  register(sessionID: string, options: Omit<ContextEntry, "registrationOrder">): void {
    if (!sessions.has(sessionID)) sessions.set(sessionID, new Map())
    const map = sessions.get(sessionID)!
    map.set(`${options.source}:${options.id}`, {
      ...options,
      registrationOrder: ++globalCounter,
    })
  },
  
  consume(sessionID: string): { merged: string; count: number } | null {
    const map = sessions.get(sessionID)
    if (!map || map.size === 0) return null
    
    const sorted = [...map.values()].sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 }
      if (priorityOrder[a.priority] !== priorityOrder[b.priority])
        return priorityOrder[a.priority] - priorityOrder[b.priority]
      return a.registrationOrder - b.registrationOrder
    })
    
    const merged = sorted.map(e => e.content).join("\n\n---\n\n")
    sessions.delete(sessionID)  // one-shot
    return { merged, count: sorted.length }
  },
}
```

### B6.3 ✅ `safeCreateHook` 工厂 + hook enable/disable 配置（**D26 P1**）

**OMO 范式**：`shared/safe-create-hook.ts` + 每个 createXxxHook factory 包 try/catch

**ACC 移植路径**：
- 把当前所有 hook factory 包 `safeCreateHook("name", factory)`
- 配置 `disabled_hooks: string[]` 支持 plugin.json
- 任何 hook 工厂抛错不影响其他 hook

**代码骨架**：
```ts
// serenity-plugin/src/shared/safe-create-hook.ts (16 行)
export function safeCreateHook<T>(
  name: string,
  factory: () => T,
  options: { enabled?: boolean } = {}
): T | null {
  const enabled = options.enabled ?? true
  if (!enabled) return factory() ?? null
  try {
    return factory() ?? null
  } catch (error) {
    log(`[safe-create-hook] Hook creation failed: ${name}`, { error })
    return null
  }
}

// serenity-plugin/src/plugin.ts 中使用
const session = safeCreateHook("session-routing", () => createSessionRoutingHook(ctx))
const toolGuard = safeCreateHook("tool-guard", () => createToolGuardHooks(...))
```

### B6.4 ⚠️ BackgroundManager 简化版（**D27 P1**）—— 部分移植

**OMO 范式**：`features/background-agent/manager.ts`（1400 行+，3 个核心机制）

**ACC 移植路径**（**只移植 depth limit + concurrency bucket，不做 parent wake / tmux**）：
- `serenity-subagent-depth-limit.ts`：直接抄 OMO `subagent-spawn-limits.ts`（74 行）
- `serenity-task-concurrency.ts`：抄 OMO `concurrency.ts` 核心（~100 行）
- 暂不做 parent wake —— 等 D28 评估

**代码骨架**：
```ts
// serenity-plugin/src/features/subagent-depth-limit.ts
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3

export async function resolveSubagentSpawnContext(
  client, parentSessionID: string, directory?: string
): Promise<{ rootSessionID: string; childDepth: number }> {
  const visited = new Set<string>()
  let current = parentSessionID
  let parentDepth = 0
  
  while (true) {
    if (visited.has(current)) throw new Error(`Cycle detected: ${parentSessionID}`)
    visited.add(current)
    const session = await client.session.get({ path: { id: current }, query: { directory } })
    const parentID = session.data?.parentID
    if (!parentID) return { rootSessionID: current, childDepth: parentDepth + 1 }
    current = parentID
    parentDepth += 1
  }
}

export async function assertCanSpawn(client, parentSessionID: string, configMaxDepth: number) {
  const ctx = await resolveSubagentSpawnContext(client, parentSessionID)
  if (ctx.childDepth > configMaxDepth) {
    throw new Error(`Subagent depth ${ctx.childDepth} exceeds max ${configMaxDepth}`)
  }
  return ctx
}
```

### B6.5 ⚠️ `tool.execute.after` output mutation（**D28 P2**）—— 部分移植

**OMO 范式**：delegate-task-retry + empty-task-response-detector（直接 mutate `output.output`）

**ACC 移植路径**：
- `serenity-msm-output-enricher.ts`：当 tool = `msm_exec` 且输出包含特定错误模式，append 修复建议
- `serenity-empty-result-detector.ts`：当 tool 输出为空字符串，replace 为 retry guidance

**风险**：
- ⚠️ `output.output` 是**可变引用**——OC API 未承诺稳定
- 必须在 try/catch 内 mutate，失败不破坏主流程
- 在 SESSION.md 记录依赖 OC 实现细节

**代码骨架**：
```ts
// serenity-plugin/src/features/msm-output-enricher.ts
const MSM_RETRY_GUIDANCE: Record<string, string> = {
  "msm not found": "Hint: run `npx tsx .opencode/skills/<skill>/scripts/<msm>.ts` first to register",
  "permission denied": "Hint: ensure MSM is registered in plugin.json allowed_msms",
}

export function createMsmOutputEnricherHook() {
  return {
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { title: string; output: string; metadata: unknown }
    ) => {
      if (input.tool !== "msm_exec" && input.tool !== "msm_list") return
      if (typeof output.output !== "string") return
      
      try {
        for (const [pattern, guidance] of Object.entries(MSM_RETRY_GUIDANCE)) {
          if (output.output.toLowerCase().includes(pattern.toLowerCase())) {
            output.output += `\n\n---\n${guidance}`
            break
          }
        }
      } catch (e) {
        log("[msm-output-enricher] Failed to enrich output", { error: e })
        // 不 throw——不破坏主流程
      }
    },
  }
}
```

### B6.6 ⚪ **不可移植**的范式（ACC 弃用）

#### B6.6.1 直接写 MESSAGE_STORAGE 磁盘文件
**原因**：依赖 OC JSON backend layout 不变；SQLite backend 已切换；OC 1.x 完全切换到 SQLite；维护成本远高于 `experimental.chat.messages.transform` hook。

**替代方案**：用 `experimental.chat.messages.transform` 注入 synthetic Part（已在 B2-e-2 描述）。

#### B6.6.2 替换 `task` tool
**原因**：OC `registry.ts:213-216` 的 `[...builtin, ...custom]` 无 dedup；同名 task 会产生 2 个 entry；行为未定义。强行替换失去 `deriveSubagentSessionPermission` 等内置逻辑。

**替代方案**：用 `tool.execute.before/after` 拦截 task args + 平行注册 `serenity_delegate` 工具（OMO `call_omo_agent` 模式）。

#### B6.6.3 `isAgentNotFoundError` 字符串匹配
**原因**：依赖 OC 错误信息"Agent not found"字面不变。OC 重构错误信息即破坏。

**替代方案**：用 `try { ... } catch (error) { if (error.code === "agent_not_found") ... }`——如果 OC 暴露 error.code，否则降级到字符串匹配但记录警告。

#### B6.6.4 Claude Code hook 系统映射
**原因**：OMO 的 `claude-code-hooks` 是为了**让 OC 模仿 CC 的 settings.json hook 机制**——ACC 不需要这个功能（ACC 本身就是 OC plugin）。

**替代方案**：直接利用 OC 的 `tool.execute.before/after` + `permission.ask`。

### B6.7 移植优先级总表（D24+ 路线）

| 优先级 | 范式 | 来源范式 | 落地难度 | 价值 | D 路线 |
|--------|------|---------|---------|------|--------|
| 🔴 P0 | **Category-aware routing** | B2-b/e + B5 | 中 | 高 | D24 |
| 🔴 P0 | **ContextCollector pattern** | B2-e-2 | 低 | 高 | D25 |
| 🟡 P1 | **safeCreateHook + hook enable/disable** | B3.2 | 低 | 中 | D26 |
| 🟡 P1 | **BackgroundManager depth + concurrency 简化版** | B2-d | 中 | 中 | D27 |
| 🟢 P2 | **tool.execute.after output mutation** | B2-b | 低 | 中 | D28 |
| ⚪ Dead-end | **MESSAGE_STORAGE 磁盘写** | B2-g | - | - | 不做 |
| ⚪ Dead-end | **替换 task tool** | - | - | - | 不做 |
| ⚪ Dead-end | **isAgentNotFoundError 字符串匹配** | - | - | - | 不做 |
| ⚪ Dead-end | **Claude Code hook shim** | - | - | - | ACC 不需要 |

### B6.8 与 S015 调研报告的关系（增量更新）

| S015 §2.1 结论 | 本次调研细化 | 增量 |
|--------------|------------|------|
| **Category 系统比 subagent_type 强大 → D24 P0** | ✅ 确认，补充 CategoryConfigSchema 15 字段 + 8 builtin categories + 3 个核心机制（间接路由 / 数据驱动 / Skill+Category 组合） | 落地路径代码骨架（B6.1） |
| **BackgroundManager 简化版 → P1** | ✅ 确认，拆为 3 子组件（depth / concurrency / parent-wake），**只前 2 个可移植** | 风险：parent wake 是 500+ 行 4 collaborator 复杂系统，D28+ 再评估 |
| **tool.execute.before 改写 args 最低侵入** | ✅ 确认，扩展到 `tool.execute.after` output mutation + throw to block 两种 sibling 模式 | 新发现：`output.output` 是可变引用（OC API 未承诺）—— 必须在 SESSION 记录风险 |
| **不要试图替换 task tool → Dead-end** | ✅ 确认 + 解释 `[...builtin, ...custom]` 无 dedup 行为未定义 | 无新增 |
| **未提及 — ContextCollector 模式** | 🆕 新发现：session-scoped ephemeral staging buffer | B6.2 落地路径 |
| **未提及 — safeCreateHook + hook enable/disable** | 🆕 新发现：plugin-loader 级别 try/catch + per-hook 配置 | B6.3 落地路径 |
| **未提及 — MESSAGE_STORAGE 磁盘写 trick** | 🆕 新发现：绕过整个 hook 链直接写 OC JSON 存储 | B6.6.1 列为 Dead-end |
| **未提及 — is_unstable_agent 自动 background** | 🆕 新发现：category 配置可标记不稳定模型，unstable-agent-babysitter 自动转 background | D24 范畴 |

---

## 附录 A — 引用清单（OMO 源码 + 行号 + URL）

> commit `f7ec55526b2a3603665c5c0308b031a4f14900b0` (dev HEAD, 2026-06-28)

### 插件入口 + Hook 工厂链
- `packages/omo-opencode/src/index.ts:1-13` 入口
- `packages/omo-opencode/src/testing/create-plugin-module.ts:115-217` plugin init flow
- `packages/omo-opencode/src/create-hooks.ts:32-74` createHooks 顶层工厂
- `packages/omo-opencode/src/plugin/hooks/create-core-hooks.ts:28-58` core hooks 工厂
- `packages/omo-opencode/src/plugin/hooks/create-session-hooks.ts:50-235` 24 session hooks
- `packages/omo-opencode/src/plugin/hooks/create-tool-guard-hooks.ts:30-200` 18 tool-guard hooks
- `packages/omo-opencode/src/plugin/hooks/create-transform-hooks.ts:30-100` 7 transform hooks
- `packages/omo-opencode/src/plugin/hooks/create-continuation-hooks.ts:30-100` 7 continuation hooks
- `packages/omo-opencode/src/plugin/hooks/create-skill-hooks.ts:20-55` 2 skill hooks

### BackgroundAgent 系统
- `packages/omo-opencode/src/features/background-agent/manager.ts:1-100` 类初始化
- `packages/omo-opencode/src/features/background-agent/manager.ts:415-460` launch 流程
- `packages/omo-opencode/src/features/background-agent/manager.ts:540-680` startTask 流程
- `packages/omo-opencode/src/features/background-agent/subagent-spawn-limits.ts` depth limit
- `packages/omo-opencode/src/features/background-agent/concurrency.ts` concurrency bucket
- `packages/omo-opencode/src/features/background-agent/parent-wake-notifier.ts` parent wake
- `packages/omo-opencode/src/features/background-agent/spawner.ts` spawner + fallback
- `packages/omo-opencode/src/features/background-agent/spawner/fallback-agent.ts` FALLBACK_AGENT = "general"

### Category / Agent / Skill
- `packages/omo-opencode/src/config/schema/categories.ts` CategoryConfigSchema
- `packages/omo-opencode/src/agents/dynamic-agent-prompt-builder.ts` agent 装配链
- `packages/omo-opencode/src/agents/builtin-agents.ts` 11 builtin agents
- `packages/omo-opencode/src/tools/call-omo-agent/tools.ts` call_omo_agent
- `packages/omo-opencode/src/tools/call-omo-agent/constants.ts` description 全文

### Hook 实现（policy injection）
- `packages/omo-opencode/src/hooks/delegate-task-retry/hook.ts:14-27` output mutation
- `packages/omo-opencode/src/hooks/empty-task-response-detector.ts:11-25` empty output replace
- `packages/omo-opencode/src/hooks/tasks-todowrite-disabler/hook.ts:9-30` throw to block
- `packages/omo-opencode/src/hooks/claude-code-hooks/claude-code-hooks-hook.ts:13-30` CC shim
- `packages/omo-opencode/src/features/context-injector/collector.ts:35-46` ContextCollector.register
- `packages/omo-opencode/src/features/context-injector/injector.ts:22-42` chat.message injection
- `packages/omo-opencode/src/features/context-injector/injector.ts:98-127` messages.transform injection
- `packages/omo-opencode/src/hooks/keyword-detector/hook.ts:225-235` keyword prepend
- `packages/omo-opencode/src/shared/safe-create-hook.ts:5-22` safe-create-hook
- `packages/omo-opencode/src/hooks/shared/prompt-async-gate.ts` prompt-async-gate re-export
- `packages/utils/src/prompt-async-gate.ts:80-155` dispatchInternalPrompt

### 状态存储
- `packages/omo-opencode/src/shared/session-tools-store.ts:6-19` session-tools-store 全文件
- `packages/omo-opencode/src/shared/session-category-registry.ts` 全文件 11 行
- `packages/omo-opencode/src/shared/delegated-child-session-bootstrap.ts:14-94` registry + register
- `packages/omo-opencode/src/features/claude-code-session-state/state.ts:1-95` session agent state
- `packages/omo-opencode/src/features/background-agent/task-registry.ts:1-18` globalThis registry
- `packages/omo-opencode/src/features/hook-message-injector/message-injection.ts:80-145` JSON write
- `packages/omo-opencode/src/shared/opencode-storage-paths.ts` MESSAGE_STORAGE path

### OC 源码（B1 baseline）
- `packages/plugin/src/index.ts:257-395` Hooks 接口
- `packages/opencode/src/plugin/index.ts:252-264` Plugin.trigger 串行 for
- `packages/opencode/src/tool/task.ts:104-322` TaskTool.execute
- `packages/opencode/src/tool/registry.ts:213-269` 自定义 tool 合并
- `packages/opencode/src/session/tools.ts:76-100` builtin tool wrapper

---

## 附录 B — D24+ 路线决策清单

### D24 — Category-aware subagent routing（**立即**）

**目标**：让 ACC 子 agent 可通过 `category` 参数路由到不同 model + tools + prompt

**落地步骤**：
1. 在 `.opencode/skills/home-serenity/` 下新增 `serenity-categories.ts` config
2. 定义 5-8 个 serenity categories：`msm-research`, `msm-exec`, `skill-injection`, `file-edit`, `code-review`, `architecture`, `media-subtitle`, `ssh-remote`
3. 实现 `serenity-plugin/src/features/categories/` 模块（category-registry, category-routing, category-system-transform hook）
4. 在 `tool.execute.before` 拦截 `task` args，提取 `category`，apply category 配置
5. SESSION.md 记录决策 + 风险（output mutation 依赖 OC 内部传引用）

**预计代码量**：~300 行（category-config + registry + routing + transform hook）

### D25 — ContextCollector 模式（**立即**）

**目标**：让 ACC 各 hook 可注入上下文到主 agent，priority 排序 + one-shot

**落地步骤**：
1. 落 `serenity-plugin/src/features/context-collector.ts`（约 80 行）
2. 在 `chat.message` hook 内调 `consume` 注入
3. 各 inject 类 hook（profile-injector / category-injector / skill-reminder）改用 `register`
4. 单元测试覆盖 priority 排序 + 并发 consume

**预计代码量**：~120 行（collector + tests）

### D26 — safeCreateHook + hook enable/disable（**1 个月内**）

**目标**：单个 hook 工厂失败不影响整个 plugin 加载

**落地步骤**：
1. 落 `serenity-plugin/src/shared/safe-create-hook.ts`
2. 把现有所有 hook factory 包 safeCreateHook
3. 加 `disabled_hooks: string[]` 到 serenity-plugin.json schema
4. SESSION.md 记录决策

**预计代码量**：~30 行（safe-create-hook + 现有 hook 调用包装）

### D27 — BackgroundManager 简化版（**3 个月内**）

**目标**：让 ACC 子 agent 有 depth limit + concurrency 控制

**落地步骤**：
1. 落 `serenity-subagent-depth-limit.ts`（~80 行）—— 直接抄 OMO subagent-spawn-limits.ts
2. 落 `serenity-task-concurrency.ts`（~120 行）—— 简化 OMO concurrency.ts
3. `tool.execute.before` 拦截 task args → `assertCanSpawn` + `concurrency.acquire`
4. SESSION.md 记录决策 + 简化 vs OMO 差异

**预计代码量**：~250 行

### D28+ — `tool.execute.after` output mutation + parent wake（**6 个月内**）

**目标**：MSM 输出错误时自动注入修复建议；subagent 完成时通知主 agent

**落地步骤**：
1. 落 `serenity-msm-output-enricher.ts`（~50 行）—— D28 P2
2. 评估 parent wake 是否需要（D29？参考 OMO parent-wake-notifier 500+ 行）
3. SESSION.md 持续更新

**预计代码量**：~50 行（D28）+ ~500 行（D29 if approved）

### Dead-end（**不做**）

- MESSAGE_STORAGE 磁盘写（B6.6.1）
- 替换 task tool（B6.6.2）
- isAgentNotFoundError 字符串匹配（B6.6.3）
- Claude Code hook shim（B6.6.4）—— ACC 不需要

---

## 附录 C — 与本次调研相关的已有 SESSION.md 位置

本次调研属于 **S035--plugin-long-term-dev**：

- 文件：`AGENT_SESSIONS/2026-06-19--S035--plugin-long-term-dev/SESSION.md`
- 追加位置：底部新增 "## 2026-06-28 OMO Deep Dive 调研" 段
- 链接到本文档 `AI_LAB/opencode-serenity-plugin/docs/omo-deep-dive.md`