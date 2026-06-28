# OpenCode Plugin Delegate 机制调研报告

> **SESSION**: S035 — Plugin 长期活跃开发
> **调研日期**: 2026-06-28
> **作者**: headless research agent (loop-delegate-research)
> **插件版本基线**: opencode-serenity-plugin v0.5.21（Loop Tool 已落地）
> **opencode 源码基线**: `f62ba5e`（dev HEAD, 2026-06-03）— 来自 S015 L3 调研
> **继承基线**: S015 L0-L6（[2026-06-04--S015--opencode-plugin-investigation](../2026-06-04--S015--opencode-plugin-investigation/docs/)）

---

## 0. TL;DR — 5 条核心结论

1. **opencode 的 delegate 是单层 task tool + BackgroundJob 扩展**：原生 `task` tool 在 `packages/opencode/src/tool/task.ts:104-322` 实现，通过 `sessions.create({ parentID, permission })` 创建子 session（共享 DB、独立 context）。**插件层只能通过 4 个间接路径扩展**——注册同名 `task` tool 整体替换；用 `tool.execute.before` 改 args；用 `event` hook 观察 `session.created/idle/deleted/message.*`；通过 `client.session.create({ parentID })` SDK 自管 subagent。
2. **没有"delegate 钩子"语义**：opencode plugin API 不暴露"subagent spawn/lifecycle"专用钩子。`task` 是普通 tool，只是行为像 delegate。所有"subagent 增强"必须包装在 tool 层或 event 订阅层。**这是与 Claude Code Subagent/Agent Teams 设计哲学的根本差异**——CC 把 subagent 做成 first-class concept，OC 把它做成 generic tool。
3. **3 个著名 plugin 的 delegate 增强范式**：(a) oh-my-openagent 用 **Category 系统**（语义路由）+ **`call_omo_agent` 自定义 tool 包装** + **`BackgroundManager` 状态机**实现大规模并行子 agent（最大深度限制、并发控制、parent wake）；(b) Claude Code 用 **`.claude/agents/*.md` 声明式配置** + **Subagent 内置 Explore/Plan/General-purpose** + **实验性 Agent Teams**（lead + N teammate + 共享 mailbox/task list/worktree）；(c) claude-task-master 用 **Task 状态机（pending/done/in-progress）+ MCP server** 把任务编排做成独立可跨客户端的服务。三者本质都是 **wrap 而不是 patch**——不动 core delegate，而是叠加新层。
4. **Loop Tool 是"4 类 delegate 模式"中的独立分支**：当前 plugin 的 Loop Tool（v0.5.5→v0.5.21）实现的不是 OC 的 task delegate，而是**外部进程级 headless 循环**——spawn `loop-runner.ts` → 启动独立 `opencode serve` → 通过 HTTP `POST /session/:id/message` 逐轮驱动 → LLM 输出 `---STOP <token>---` 结束。这与原生的"session 内 task tool 调用"完全不同——Loop Tool 不在主 session 的 message tree 里，是**进程外、session 外、DB 外**的"独立 agent harness"。
5. **D24+ 优先级排序**：🔴 P0 是 **Category-aware subagent routing**（OMO 模式，用 hook + config 把 `task` tool 的 category 参数映射到不同 agent）；🟡 P1 是 **`BackgroundManager` 风格的并发/深度限制**（CC Agent Teams 的对等物）；🟡 P1 是 **`experimental.primary_tools` 动态感知**（基于 subagent 类型自动 filter 可见 tool 列表）；🟢 P2 是 **`call_omo_agent` 包装层的轻量版**；⚪ Dead-end 是**改写 `task` tool 完全替换**（与 OC API 演化绑死、维护成本极高）。

---

## 1. Q1 — OpenCode delegate 机制全貌

### 1.1 默认 task tool 调用流（事实基线）

**核心源码**：`packages/opencode/src/tool/task.ts:104-322` + `packages/opencode/src/agent/subagent-permissions.ts:18-35`

**调用栈（`TaskTool.execute`，行 115-313）**：

```
LLM 决策
  └─ tool.execute.before hooks (plugin)         ← 插件可拦截
       └─ TaskTool.run(params, ctx)
            ├─ ctx.ask({ permission: "task", patterns: [subagent_type] })   ← 权限 ask
            ├─ agent.get(subagent_type)         ← 取 agent 配置
            ├─ sessions.create({                 ← ★ 创建子 session（DB 持久）
            │     parentID: ctx.sessionID,
            │     title: params.description + ` (@${next.name} subagent)`,
            │     permission: deriveSubagentSessionPermission({
            │       parentSessionPermission, parentAgent, subagent
            │     })
            │   })
            ├─ model = next.model ?? parentModel  ← 继承或覆盖模型
            ├─ tools = {
            │     todowrite: false (除非子 agent 显式 allow),
            │     task: false      (除非子 agent 显式 allow, 默认禁止 re-delegate),
            │     ...experimental.primary_tools → false
            │   }
            └─ ops.prompt({ sessionID: nextSession.id, agent: next.name, ... })
                 ↓
              SessionPrompt.prompt 跑子 agent
                 ↓
              返回 text 给主 session（包成 <task_result>）
```

**关键事实**（源码验证）：

| 维度 | 事实 | 源码位置 |
|---|---|---|
| **子 session 是否共享 context** | ❌ **完全独立**——新建 DB row，新消息树，新 system prompt | `sessions.create({ parentID })` 行 153-168 |
| **子 agent 默认能否再调 task** | ❌ **默认禁止**（避免无限嵌套）——除非子 agent 自己的 `permission` 包含 `task` | `task.ts:209` |
| **子 agent 默认能否 todowrite** | ❌ **默认禁止**——除非显式 allow | `task.ts:208` + `subagent-permissions.ts:32-33` |
| **权限继承规则** | (1) 父 agent 的 `edit` deny rule + (2) 父 session 的 `external_directory` + `deny` rule 转发 | `subagent-permissions.ts:25-31` |
| **Background 模式** | ⚠️ **需 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`**——否则报错 | `task.ts:121-125` |
| **Background 完成通知** | 自动 inject `<task id state="completed">` synthetic message 到父 session | `task.ts:217-241` + `background.wait` |

### 1.2 哪些 extension hook 位于 delegate 链路上

| Hook | 文件:行号 | 何时触发 | delegate 相关能力 |
|---|---|---|---|
| `tool.execute.before` | `packages/opencode/src/session/tools.ts:90-94`（builtin）+ `:131-135`（MCP）+ `session/prompt.ts:354-358`（**task tool 也覆盖**） | 任意 tool 调用前 | ✅ **拦截/改写 `task` tool 的 args**——可加 `category`/`run_in_background` 等自定义字段 |
| `tool.execute.after` | 同上 `:105-109/:149-153/:433-436` | 任意 tool 调用后 | ✅ **改写 `task` 的返回**——如伪装 subagent 失败为成功 |
| `event` (session.created / idle / deleted / updated / error / compacted) | `packages/opencode/src/plugin/index.ts:286-299` | 全部 session 生命周期 | ✅ **观察 delegate 是否触发**——可审计、计数 |
| `event` (message.part.updated / removed / message.updated / removed) | 同上 | 每条消息变化 | ✅ **观察子 agent 输出流**——可流式展示 |
| `event` (todo.updated) | 同上 | todo list 变化 | ✅ **观察 subagent 的 todowrite** |
| `experimental.session.compacting` | `session/compaction.ts:398-403` | 压缩 prompt 构造前 | ⚠️ 触发的是**主 session**——subagent 各自压缩不触发 |
| `shell.env` | `shell.ts:425-435` / `pty-preparation.ts:16` / `session/prompt.ts:614` | 每次 shell | ✅ **可向 subagent 的 bash 注入 env**（主 + 子都触发） |
| `tui.prompt.append` | （未在源码中验证） | TUI prompt 时 | ❌ 不影响 subagent（subagent 不在 TUI） |

### 1.3 哪些可被 plugin override

| Override 方式 | 源码依据 | 风险 |
|---|---|---|
| **注册同名 `task` tool** | `packages/plugin/src/tool.ts` `tool()` helper + `registry.ts:269-272, 312-357` 同名覆盖机制 | 高 — 完全替换 OC 内置的 task 实现，需自己实现 `sessions.create({ parentID })`、`background.start`、`ctx.ask` 等所有逻辑 |
| **`tool.execute.before` 改 args** | `tools.ts:90-94` + `prompt.ts:354-358` | 低 — 只能加字段、改字段，不能阻止；要在 OC 解析 args 之前完成 |
| **`tool.execute.after` 改返回值** | 同上 | 低 — 可注入元数据、改 title，但**不能阻止 subagent 已启动的 prompt** |
| **配置层：`agent.{name}.{permission, model, prompt, ...}`** | `agent/agent.ts` + `core/v1/config/config.ts` | 中 — 声明式，不需代码；但只能控制 agent 字典已有字段，不能改 spawn 流程 |
| **`experimental.primary_tools`** | `task.ts:162-166, 210` | 低 — 控制哪些 primary-only tool 在 subagent 中**默认禁用**；数组里的 tool 都不会传给 subagent |
| **SDK：`client.session.create({ parentID })`** | `packages/sdk/js/src/v2/gen/sdk.gen.ts` | 高 — 完全脱离 `task` tool，可独立 spawn subagent（**OMO 模式**）；但失去了 OC 的派生 permission、background job 等内置能力 |
| **plugin 自己生成 `task` tool 的"替代品"**（如 OMO 的 `call_omo_agent`） | `packages/opencode/src/tool/registry.ts:271-272`（`[...builtin, ...custom]`） | 中 — 同名 task 不覆盖（task 是固定 builtin），但**可以并行注册 `call_omo_agent` 作为新 tool**，让 LLM 选择用它而不是 task |

### 1.4 delegate 链路上没有的 hook

| 想做的事 | opencode 是否提供 | 替代方案 |
|---|---|---|
| 在 subagent spawn **之前**注入额外权限检查 | ❌ 没有"subagent spawn hook" | `tool.execute.before` 改 args + `permission` rules 预设 |
| 阻止**特定 subagent_type**被调用 | ❌ | `permission.task` 配 ruleset：`{ "explore": "deny" }` |
| 给 subagent **动态 prompt_append** | ❌ | 只能通过 agent 配置的 `prompt` 字段（静态） |
| 给 subagent 动态切换 **模型** | ⚠️ 部分——`agent.{name}.model` 可设但静态 | plugin 监听 `tool.execute.before`，改写 task args（OC 不直接支持但 LLM 通常会传 model 提示） |
| subagent **完成时回调**到 plugin | ⚠️ 通过 `event` hook（`message.updated`） | 不直接，需要 plugin 自己 reconcile |
| 跨 subagent **共享中间状态** | ❌ 没有 `context.shared` | 只能落盘（文件系统 / DB） |
| subagent **暂停/恢复** | ⚠️ `task_id` 机制（`task.ts:144-146`） | LLM 需主动传 `task_id`；plugin 无法强制 |
| subagent **深度限制** | ❌ | 必须在 plugin 层自实现（如 OMO 的 `getMaxSubagentDepth`） |

---

## 2. Q2 — 著名 Plugin Delegate 深度调研

### 2.1 oh-my-openagent / oh-my-opencode（OME）— ★★★★★ 最详尽

> **GitHub**: `code-yeongyu/oh-my-openagent`（63.8k stars，9,735 commits）— 2026 年改名（原 oh-my-opencode）
> **关联 readme**: <https://github.com/code-yeongyu/oh-my-openagent/blob/dev/README.md>
> **Features reference**: <https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md>
> **架构源码**: <https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-opencode/src>

#### 2.1.1 整体 delegate 扩展哲学

OMO **完全不动 OC 的 `task` tool**，而是**叠加一层抽象**——通过配置驱动的 11 个 agent + 8 个 category + 1 个 `call_omo_agent` 包装 tool + 1 个 `BackgroundManager` 状态机实现"delegate 增强"。

> **设计原则**（OMO README）：
> > "Other harnesses promise multi-model orchestration. We ship it."
> > "Sisyphus (主 agent) orchestrates Hephaestus, Oracle, Librarian, Explore. A full AI dev team in parallel."

#### 2.1.2 三层 delegate 增强（按叠加顺序）

**Layer 1 — Agent 配置层（声明式）**

OMO 在 opencode.json 中注入 11 个 agent：
- Core: Sisyphus (claude-opus-4-7), Hephaestus (gpt-5.5), Prometheus (claude-opus-4-7), Atlas (claude-sonnet-4-6)
- 工具类: Oracle (gpt-5.5 只读), Librarian (gpt-5.4-mini-fast 只读), Explore (gpt-5.4-mini-fast 只读), Multimodal-Looker (gpt-5.5)
- 规划: Prometheus, Metis, Momus
- 编排: Sisyphus-Junior（category 触发，自动 spawn）

**权限矩阵**（来源 features.md "Tool Restrictions"）：

| Agent | 禁止 |
|---|---|
| oracle | write, edit, task, call_omo_agent |
| librarian | write, edit, task, call_omo_agent |
| explore | write, edit, task, call_omo_agent |
| multimodal-looker | 仅 read |
| atlas | task, call_omo_agent |
| momus | write, edit, task |

**关键洞察**：OMO **主动限制 subagent 的再 delegate 能力**——除主 agent 外，几乎所有 subagent 都不能 `task` 或 `call_omo_agent`。这解决了**无限嵌套循环**这个 OC 原生不解决的问题（OC 用 `task.ts:209` 默认 deny `task` 实现同效果，但 OMO 更彻底）。

**Layer 2 — Category 路由层（语义 dispatch）**

OMO 发明了 **Category 概念**——比 `subagent_type` 更语义化的路由层。

```ts
// OMO category system（features.md "Category Configuration Schema"）
const launchTools = {
  task: false,
  call_omo_agent: true,   // ← 允许调包装 tool
  question: false,
  ...getAgentToolRestrictions(input.agent, { includeTeamToolDenylist: ... })
}
```

**Category 配置示例**（来源 features.md）：
```jsonc
{
  "categories": {
    "deep": {
      "model": "openai/gpt-5.5 (medium)",
      "is_unstable_agent": true,   // 强制 background mode
      "tools": { "websearch_web_search_exa": false }
    },
    "visual-engineering": {
      "model": "google/gemini-3.1-pro (high)",
      "tools": { "bash": true }
    }
  }
}
```

**调用方式**：
```ts
task({ category: "visual-engineering", prompt: "Add a responsive chart component" });
// OMO 自动：category → model + tools + temperature + system-prompt-append
```

**关键洞察**：OMO 的 category 是**数据驱动的 subagent 类型**——比 OC 原生 `subagent_type` 多一层抽象，因为 OC 原生 type 是"哪个 agent"，OMO category 是"什么类型的工作"。

**Layer 3 — `BackgroundManager` 状态机（并行/并发/深度控制）**

> 源码：`packages/omo-opencode/src/features/background-agent/manager.ts`（约 1400 行）
> 关键类：`BackgroundManager`

```ts
// OMO launch（manager.ts 410-460）
async launch(input: LaunchInput): Promise<BackgroundTask> {
  const spawnReservation = await this.reserveSubagentSpawn(input.parentSessionId)
  // ↑ 这就是 depth limit 实现：assertCanSpawn() 检查 childDepth > maxDepth

  const task: BackgroundTask = {
    id: `bg_${crypto.randomUUID().slice(0, 8)}`,
    status: "pending",
    rootSessionId: spawnReservation.rootSessionID,
    spawnDepth: spawnReservation.childDepth,  // ★ 深度记录
    // ...
  }

  // ConcurrencyManager 控制同模型并发
  const concurrencyKey = this.concurrencyManager.getConcurrencyKey(rawConcurrencyKey)
  const queue = this.queuesByKey.get(concurrencyKey) ?? []
  queue.push({ task, input, attemptID })
  void this.processKey(concurrencyKey)
}
```

**BackgroundManager 的 5 个核心机制**：

1. **`SubagentSpawnContext` + 深度限制**（`subagent-spawn-limits.ts`）
   - 每次 launch 调 `client.session.tree()` 递归找 root
   - `childDepth > getMaxSubagentDepth(config)` 时 throw
   - 默认 max_depth = 5

2. **ConcurrencyManager + 队列**（`concurrency.ts`）
   - 按 `providerID/modelID` 分桶
   - 同一模型的 subagent 排队，超过限制就 queue
   - 防 API rate limit + 防成本爆炸

3. **ParentWakeNotifier**（`parent-wake-notifier.ts`）
   - subagent 完成时**主动唤醒主 agent**——注入 `<system-reminder>...</system-reminder>` synthetic message 到父 session
   - 与 OC 原生 `background inject`（task.ts:217-241）行为一致，但 OMO 多了**批量合并**（`pendingByParent` Map）+ **重试去重**（`pending-parent-wake-dedupe.ts`）

4. **TmuxSessionManager**（`features/tmux-subagent`）
   - 每个 background subagent 可视化在独立 tmux pane
   - `interactive_bash` tool 支持 tmux send-keys
   - 主 agent 可实时"看"子 agent 进展

5. **`SessionCategoryRegistry` + `claude-code-session-state.ts`**
   - 每个 child session 记录 `(agent, category, parentAgent, parentTools)`
   - 子 agent 出错 fallback 到 `FALLBACK_AGENT`（"build"）
   - `setSessionTools(sessionID, launchTools)` 写到 OMO 自己的 `session-tools-store`

#### 2.1.3 关键 hook 列表（OMO 的 54+ hooks）

OMO 注册了 54 个 base hooks（61 with Team Mode），分布在 5 个 tier：

| Tier | 数量 | 典型 hooks | delegate 相关 |
|---|---|---|---|
| **Session** | 24 | `session.compaction-context-injector`, `session.preemptive-compaction`, `session.runtime-fallback`, `session.background-notification`, `session.todo-continuation-enforcer` | ✅ **delegate 全程跟踪**——compaction 时注入 context；background subagent 完成时通知 |
| **Tool Guard** | 16 | `delegate-task-retry`, `empty-task-response-detector`, `tasks-todowrite-disabler`, `write-existing-file-guard` | ✅ **delegate 工具过滤**——task tool 的 retry、empty response 检测、disable todowrite |
| **Transform** | 5 | `chat.system.transform`（CC skill rules 注入）, `thinking-block-validator`, `keyword-detector` (IntentGate) | ✅ **delegate 上下文注入** |
| **Continuation** | 7 | `ralph-loop`（Event + Message 双 hook）, `todo-continuation-enforcer`, `unstable-agent-babysitter` | ⚠️ 不直接管 delegate，但**主 agent 完成后强制续跑** |
| **Skill** | 2 | `skill-set-router`, `intent-gate` | ❌ 不涉及 delegate |

#### 2.1.4 Team Mode（OMO 独家）

OMO 实现了一个**完全独立的"Team Mode"**——`team_mode.enabled: true` 时，启用 12 个 `team_*` tool：

| Tool | 功能 |
|---|---|
| `team_create` | 创建 lead + up to 8 member 的团队 |
| `team_send_message` | 队员间通信（mailbox） |
| `team_task_create` | 共享 task list（带 file lock + blockedBy） |
| `team_status` | 团队状态查询 |
| `team_*` (其他 8 个) | 队员管理、任务认领、工作树分配 |

**与原生的区别**：
- 原生 task tool = **一个主 agent 调度多个独立 subagent**
- Team Mode = **lead agent 调度多个 subagent，且 subagent 之间能通信（mailbox）+ 共享任务（带依赖图）+ 可视化协作（tmux pane）**
- Team Mode 是 OMO 对 Claude Code 2.1.32 "Agent Teams" 实验功能的重新实现（在 OC 平台上）

#### 2.1.5 解决的核心痛点

| 痛点 | OMO 解法 | 评价 |
|---|---|---|
| OC 原生 `subagent_type` 太僵硬 | Category 系统 | ✅ 灵活 |
| OC 没有 subagent 并发控制 | ConcurrencyManager | ✅ 必备 |
| OC 没有深度限制 | `assertCanSpawn` + depth counter | ✅ 必备 |
| OC subagent 完成不通知主 agent（仅 background） | ParentWakeNotifier | ✅ 但其实 OC task.ts:217 已有，OMO 增强批量 |
| OC subagent 之间不能通信 | Team Mode mailbox | ⚠️ 复杂，但解决"协作"场景 |
| OC 31 tool 一次塞给 subagent 视野 | Category-level `tools` 配置 | ✅ 借鉴 `experimental.primary_tools` |

#### 2.1.6 给我们的启示

- **Category 系统**比 `subagent_type` 更强大，可以作为 D24+ 的 P0
- **BackgroundManager 模式**（不依赖 OC 原生 BackgroundJob，自己管队列）值得借鉴，但**简化版**即可
- **tool.execute.before 改写 args** 是侵入性最低的 delegate 增强方式
- **不要试图"替换 task tool"**——OMO 自己造了 `call_omo_agent`，没碰 task

---

### 2.2 Claude Code（官方）— ★★★★ 范式对照

> **官方文档**: <https://docs.claude.com/en/docs/claude-code/sub-agents> + Agent Teams 实验性
> **代理 skill 文件**: `.claude/agents/*.md`（markdown YAML frontmatter）

#### 2.2.1 CC 的 subagent 设计哲学

CC 把 subagent 当作**first-class concept**，与 OC 把 task 当 generic tool 形成对比：

**内置 subagent**（无需配置）：
- `Explore`（Haiku，只读工具，文件发现/代码搜索）
- `Plan`（继承主对话，read-only）
- `General-purpose`（继承主对话，所有工具）
- `statusline-setup`, `claude-code-guide`

**自定义 subagent**（`.claude/agents/*.md`）：
```yaml
---
name: test-engineer
description: 编写和运行测试
tools: Read, Write, Bash, Grep  # 白名单
model: sonnet
---
You are a meticulous test engineer...
```

#### 2.2.2 Hook 体系（CC）

CC hook 是**事件驱动的脚本**（不是函数）：

| Hook | 触发时机 | 能力 |
|---|---|---|
| `PreToolUse` | 工具调用前 | Block / modify input |
| `PostToolUse` | 工具调用后 | Add warnings / modify output |
| `UserPromptSubmit` | 用户发消息 | Inject context |
| `SessionStart` / `SessionEnd` | session 生命周期 | Initialize / cleanup |
| `Notification` | 后台 idle 通知 | Custom routing |
| `SubagentStart` / `SubagentStop` | **subagent spawn/destroy** | ⚠️ **专门 hook**——OC 没有这个 |

**SubagentStart/SubagentStop** 是 CC 独有的 delegate hook——plugin 可以在 subagent 启动/销毁时插入逻辑。这与 OC 形成对比，OC 把这个能力藏在 `tool.execute.before/after` 后面。

#### 2.2.3 后台 subagent

CC 通过 `run_in_background=true` 实现：
```
Task(subagent_type="explore", prompt="...", run_in_background=true)
```
然后：
- 后台跑 subagent
- 主 agent 继续工作
- subagent 完成时**通过 Notification hook 通知**（类似 OMO ParentWakeNotifier）

#### 2.2.4 Agent Teams（实验性，`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）

CC 2.1.32 引入的实验性功能：

| 组件 | 角色 |
|---|---|
| Team Lead | 主 Claude Code session，负责拆任务、创建队友、协调 |
| Teammates | 独立 Claude Code 实例，独立 context，并行 |
| Shared Task List | 共享任务列表，支持 `blockedBy` 依赖管理 |
| Mailbox System | 队友间定向/广播消息 |
| Git Worktree（可选） | 每个 teammate 独立 worktree，避免文件冲突 |

**Team Mode 关键操作**：
- `set -g mouse` tmux 配置（多屏显示）
- teammate 数量控制（默认 5，可调）
- 任务分配模式：Lead assigns（默认）vs Self-claim

#### 2.2.5 与 OC 的对比

| 维度 | Claude Code | OpenCode |
|---|---|---|
| Subagent 是 first-class | ✅ | ❌（只是 tool） |
| 专用 SubagentStart/Stop hook | ✅ | ❌（用 `tool.execute.before/after`） |
| 声明式 agent 配置 | ✅ `.claude/agents/*.md` | ✅ `.opencode/agents/*.md` + JSON |
| 内置 explore/plan subagent | ✅ | ✅ (`explore`, `plan`, `general`) |
| 后台 subagent | ✅ `run_in_background` | ✅ `background=true`（需 experimental flag） |
| Agent Teams | ✅ 实验性 | ❌（OMO 实现） |
| Worktree isolation | ✅ | ❌ |
| Mailbox between subagents | ✅ | ❌ |

#### 2.2.6 给我们的启示

- **SubagentStart/Stop hook** 是 OC 缺的；D24+ 可以用 `tool.execute.before/after` + session event 模拟
- **Worktree isolation** 是 CC 的杀手特性——OC 完全没这个，可作为 long-term 目标
- **Mailbox** 对深度多 agent 协作是必要的；CC 已有，可作为 OMO Team Mode 的参考
- **声明式 agent 配置** OC 已经支持，无需重复

---

### 2.3 claude-task-master — ★★★ 任务编排范式

> **GitHub**: `eyaltoledano/claude-task-master` (~6.4k stars, 多个 fork)
> **架构**: MCP server + Task 状态机
> **关联**: `https://www.cnblogs.com/treasury-manager/p/19174486` 评测

#### 2.3.1 整体设计

Task Master **不是 delegate 增强**，而是**任务编排**——把"复杂任务"切成 N 个有依赖关系的 todo，由 LLM 逐步完成。它提供：

- **Task 状态机**：`pending` → `in-progress` → `completed`（或 `deleted`）
- **依赖图**：`blockedBy: ["T-001", "T-002"]` 字段
- **持久化**：`.taskmaster/tasks/` 目录（JSON 文件）
- **并行优化**：自动识别无依赖任务并行执行

**Task Schema**（参考 OMO 的实现——OMO 复制了 CC Task 的 schema）：
```ts
interface Task {
  id: string;              // T-{uuid}
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  threadID: string;
}
```

#### 2.3.2 与 delegate 的关系

Task Master **依赖 subagent** 来执行 task，但本身不实现 delegate——它通过 MCP 提供工具：

| Tool | 对应 CC/OC 原生 |
|---|---|
| `TaskCreate` | 创建 task 节点 |
| `TaskUpdate` | 更新状态 |
| `TaskList` | 列出所有 task |
| `TaskGet` | 取单个 task |
| （隐含）`delegate_to_subagent` | 由 LLM 用 OC 原生 `task` tool 完成 |

**关键洞察**：Task Master 是**任务层抽象**，不是 delegate 层。它解决"如何管理 N 个有序任务"，但不解决"如何高效 spawn subagent"。

#### 2.3.3 给我们的启示

- **Task 状态机 + 依赖图** 比"裸 subagent 调用"更适合长任务管理
- **持久化 task 状态**（JSON 文件 + 跨 session）解决 session 重启后丢失问题
- 与 OMO `claude-tasks` feature 类似——OMO 直接复用了 Task Master 的 schema 设计
- 对我们的 home-session 来说，`AGENT_SESSIONS/` 已经是类似持久化机制，**不需要新做 Task Master**

---

### 2.4 其他相关 plugin（轻量提及）

| Plugin | 简介 | delegate 相关能力 |
|---|---|---|
| **Continue.dev** | VS Code 扩展 + JetBrains，~13k stars | ❌ 不支持多 agent delegate（已不再活跃维护） |
| **Cline / Roo Code** | VS Code 扩展，~10k stars | ⚠️ 有"Boomerang Mode"——一个 task → N 个 sub-task → 结果聚合，类似 CC subagent 但不持久 |
| **aider** | Python CLI，~33k stars | ❌ 没有 subagent delegate，纯 chat |
| **openhands** | 多 agent 平台，~32k stars | ✅ 有完整 multi-agent runtime，但与 OC 插件体系不同 |
| **claude-code-multi-agent** | CC 多 agent 编排，~1k stars | ✅ 类似 CC Agent Teams 但更简单 |
| **compounding-engineering-plugin** | CC 复合工程插件 | ⚠️ 不是 delegate，是 review-driven task 编排 |

**结论**：在 OC 生态中，**omo/openagent 是唯一真正深度扩展 delegate 的 plugin**（63.8k stars + 9.7k commits，活跃度远超其他）。CC 是另一个平台的范式参考。Task Master 是任务编排而非 delegate。

---

## 3. Q3 — 当前 plugin 在 delegate 维度的状态

### 3.1 当前 plugin 的 delegate 相关能力清单

| S015 L3 扩展点 | 当前 plugin 状态 | 证据 |
|---|---|---|
| **E1 Plugin 加载器** | ✅ 完全使用 | `src/index.ts:42-82` 主入口 + `mech-registry.json` 31 tool 注册 |
| **E2 tool.execute.before/after** | ✅ **使用**——bash 覆盖 + 路径守卫 | `src/hooks/permission-guards.ts:8280 行` + `src/bash-toggle.ts` |
| **E3 权限拦截** | ✅ **使用**——permission.asked 事件 + SDK reply | `src/hooks/permission-auto-reply.ts:8623 行` |
| **E4 上下文压缩** | ✅ **使用**——`experimental.session.compacting` + `system.transform` | `src/hooks/compacting.ts:10694 行` |
| **E5 throw / 错误处理** | ✅ **使用**——try/catch 在 hook 内部 | 散见 `src/hooks/*.ts` |

### 3.2 当前 plugin 的 delegate 能力对照

| 能力 | OMO | Claude Code | **当前 plugin** | 评估 |
|---|---|---|---|---|
| 自定义 subagent agent | ✅ 11 个 + category | ✅ markdown agent | ✅ 5 个 JSON agent（plan/build 禁，general/explore/cheap-worker/orchestrator）| 中等 |
| Subagent 权限矩阵 | ✅ 细粒度 per-agent | ✅ tool 白名单/黑名单 | ⚠️ 只配了 `task: { "*": "allow" }` | **欠——按 subagent 类型细粒度策略表未做** |
| Background subagent | ✅ + 并发控制 | ✅ `run_in_background` | ❌ 无 | **欠——Loop Tool 是替代品但非 delegate** |
| 任务持久化（跨 session） | ✅ JSON 文件 | ✅ Tasks system | ✅ `AGENT_SESSIONS/` 目录 | OK |
| Subagent 深度限制 | ✅ `getMaxSubagentDepth` | ❌ 无 | ❌ 无 | **欠——可被无限嵌套** |
| Subagent 并发限制 | ✅ ConcurrencyManager | ❌ 无 | ❌ 无 | **欠** |
| Subagent 完成通知 | ✅ ParentWakeNotifier | ✅ Notification hook | ⚠️ session.created/idle 通过 event hook 可观察，但未主动通知主 agent | **欠** |
| Worktree isolation | ❌ | ✅ | ❌ | **远期** |
| Mailbox / 协作 | ✅ Team Mode | ✅ Agent Teams | ❌ | **远期** |
| 同名 tool 覆盖（bash 禁用） | — | — | ✅ **使用**——bash 抛错 + permission deny 双层 | OK |
| Shell 环境变量注入 | — | — | ✅ **使用**——`shell.env` | OK |
| Compaction context 注入 | — | — | ✅ **使用**——SKILL.md + session state | OK |
| **Loop Tool（独立 headless 循环）** | ❌ | ❌ | ✅ **使用**——D27 v0.5.5→v0.5.21 | **独有——与 OMO/CC 都不同** |

### 3.3 Loop Tool 的"subagent headless 循环"是什么 delegate 模式

**关键判断**：Loop Tool **不是 delegate 模式**，而是**外部独立 agent harness**。

**对比表**：

| 维度 | 原生 `task` delegate | Loop Tool (v0.5.21) |
|---|---|---|
| **执行环境** | 主 session 内（同 opencode 进程，DB 共享） | 独立进程（loop-runner.ts spawn）+ 独立 `opencode serve` 实例 |
| **Session 归属** | 主 session 的 child session（DB row 有 parentID） | **完全独立 session**——不是 child，无 parentID，不在主 session 的消息树 |
| **Context** | 继承主 agent 的 prompt + subagent 配置 | **完整 agent context 重建**——通过 HTTP API `/session` 创建新 session |
| **生命周期** | 由 BackgroundJob 管理，主 session 完成时 kill | plugin 进程全程监控 + `dispose` 钩子清理 + 进程组杀 |
| **停止信号** | LLM 输出特定字符串 | LLM 输出 `---STOP <token>---`（128-bit 随机 token 防误触发） |
| **进度可见性** | 主 session 看到 `<task_result>` | 进度文件 `AGENT_SESSIONS/loop-{label}.md` + `ctx.metadata()` 实时更新 |
| **类比** | Function call（内联执行） | 独立 Node 进程 + IPC 协议 |
| **优点** | 充分利用 OC 内置（permission / background job / parent wake） | **完全脱离主 session**——主 session 不需要等、不需要上下文、可以并行跑多个 Loop |
| **缺点** | 占用主 session context + 受 OC API 演化影响 | 进程管理复杂（已踩 6 个坑：process.execPath / POST body 400 / undici timeout / runner 卡住 / 进程泄漏） |

**Loop Tool 实际解决了 OMO/CC 都没解决的问题**：
- **真正的外部循环**——LLM 反复执行任务直到完成，不被 OC 的 message loop 限制
- **隔离 session**——主 agent 的 context 完全不被 subagent 污染（比 OC 的 task tool 更彻底）
- **可独立管理**——进程组、PID 文件、tmux 集成
- **可观测**——进度文件、metadata、tui.prompt.append 等多通道

**与 OMO BackgroundManager 的对比**：
| 维度 | OMO BackgroundManager | Serenity Loop Tool |
|---|---|---|
| 是否在 OC 进程内 | ✅ 是（同一个 opencode 实例，async task） | ❌ 否（spawn 独立 serve 实例） |
| 通信方式 | OC SDK（client.session.create + promptAsync） | HTTP API（POST /session + /message） |
| 停止信号 | OC 内置 BackgroundJob state | 自定义 `---STOP <token>---` |
| Context 共享 | subagent type 自动派生 | 完全独立 |
| 适用场景 | 快速 spawn N 个并行 subagent | 长任务、可恢复、外部驱动 |

**结论**：Loop Tool 是 **"delegate 模式的第四种变体"**——不是 wrap native task，也不是 patch OC，而是**绕开 OC 协议栈，自己起独立 opencode 实例做长循环**。

### 3.4 当前 plugin 在 delegate 维度的不足

按 S015 L3 识别的 5 个扩展点评估：

| 扩展点 | 当前 plugin | 评估 |
|---|---|---|
| E1 加载器 | ✅ | OK |
| E2 tool.execute.before/after | ✅ 用于 bash 禁用 + 路径守卫 | OK，但**只针对 bash，subagent task 没碰** |
| E3 权限拦截 | ✅ 用于让 LLM 不被人工问 | OK |
| E4 上下文压缩 | ✅ 用于 SKILL.md 注入 | OK，但**subagent 压缩不触发（OC 设计如此）** |
| E5 错误处理 | ✅ try/catch | OK |

**未用但应评估的**（按重要性排序）：

1. **`experimental.primary_tools`**（config 层）：当前 plugin 没配这个字段。意味着 subagent 默认能看到所有 primary tool（包括 bash）。**应该配**——把 bash/serialize_background_task 等主 agent 专属 tool 排除。

2. **`tool.execute.before` 对 `task` tool 的拦截**：当前 plugin 只在 bash 上注册 before hook。可以**选择性拦截 task tool**——比如禁止 subagent_type=cheap-worker 或 subagent_type=orchestrator。

3. **session event hook（session.created/idle/deleted）**：当前 plugin 的 event hook 只处理 `permission.asked`，没订阅 session 生命周期。**应该订阅**——用于 subagent 完成通知 + 审计。

4. **Subagent depth limit**：当前 plugin **无**。理论上 OMO 的 limit=5，但 OC 原生不限制——可能陷入无限嵌套（task → subagent task → sub-subagent task...）。**应该实现**。

5. **Task persistence 跨 session**：当前 plugin 的 `AGENT_SESSIONS/` 已经支持，但**只对主 session 维护**，subagent 派生任务没有持久化机制。

---

## 4. Q4 — 未来扩展方向（D24+）

### 4.1 优先级矩阵（10 项候选）

| # | 候选 | 优先级 | 复杂度 | 价值 | 死胡同？ |
|---|---|---|---|---|---|
| 1 | **Category-aware subagent routing**（OMO 模式） | 🔴 P0 | ★★ | 极高 | ❌ |
| 2 | **`experimental.primary_tools` 自动感知** | 🔴 P0 | ★ | 高 | ❌ |
| 3 | **`tool.execute.before` 拦截 `task` tool** | 🟡 P1 | ★ | 中 | ❌ |
| 4 | **Subagent depth limit（OMO 模式）** | 🟡 P1 | ★★ | 高 | ❌ |
| 5 | **Session event hook 订阅（session.created/idle）+ parent wake** | 🟡 P1 | ★★ | 高 | ❌ |
| 6 | **`BackgroundManager` 轻量版**（队列 + 并发控制） | 🟡 P1 | ★★★ | 中 | ❌ |
| 7 | **`call_omo_agent` 包装 tool**（OC 原生 task 的"替代入口"） | 🟢 P2 | ★★★ | 中 | ⚠️ 部分 dead-end |
| 8 | **Task state machine + 持久化**（Task Master 模式） | 🟢 P2 | ★★★ | 中 | ⚠️ 与 AGENT_SESSIONS/ 重叠 |
| 9 | **Worktree isolation**（CC 模式） | ⚪ P3 | ★★★ | 低 | ⚠️ 偏离 ACC/CCC 哲学 |
| 10 | **替换 OC 原生 `task` tool** | ⚪ Dead-end | ★★★★★ | — | ✅ **完全 dead-end** |

### 4.2 各候选详细方案

#### 4.2.1 🔴 P0-1: Category-aware subagent routing（OMO 模式）

**目标**：把 `subagent_type` 从"agent name"升级为"category → agent mapping"。

**实现路径**：
1. 在 `home-serenity.plugin.json` 新增 `categories` 段：
   ```jsonc
   {
     "categories": {
       "research": { "agent": "explore", "tools": { "bash": false, "write": false } },
       "implement": { "agent": "general", "tools": { "webfetch": true } },
       "audit": { "agent": "orchestrator", "tools": { "edit": false } }
     }
   }
   ```
2. 注册 `tool.execute.before` hook 拦截 `task` tool：
   ```ts
   "tool.execute.before": async (input, output) => {
     if (input.tool === "task" && output.args.category) {
       const cat = config.categories[output.args.category]
       if (cat) {
         output.args.subagent_type = cat.agent
         // 注入 tools 限制（通过 session-tools-store 或 wrapper session）
       }
     }
   }
   ```
3. 配套 `tool.execute.after` 处理 category 完成通知

**价值**：把 OMO 的核心创新移植到我们的 plugin，且**不破坏 OC API**——plugin 层透明改写，LLM 完全感知不到差异。

**风险**：与 OC `experimental.primary_tools` 重复——优先用 OC 原生机制。

#### 4.2.2 🔴 P0-2: `experimental.primary_tools` 自动感知

**目标**：subagent 默认看不到 primary-only tool。

**实现路径**：在 `opencode.json` 加：
```jsonc
{
  "experimental": {
    "primary_tools": ["cc_git", "loop", "eap", "neat", "session", "cc_ck"]
  }
}
```

**价值**：直接借用 OC 原生机制——subagent 在 spawn 时自动把这些 tool 设为 false（`task.ts:162-166, 210`）。

**风险**：低。零代码改动。

#### 4.2.3 🟡 P1-1: `tool.execute.before` 拦截 `task` tool

**目标**：限制某些 subagent_type 不能被调用（细粒度权限）。

**实现路径**：
```ts
"tool.execute.before": async (input, output) => {
  if (input.tool === "task" && !policy.allowSubagent(output.args.subagent_type)) {
    throw new Error(`subagent_type "${output.args.subagent_type}" is disabled by serenity policy`)
  }
}
```

**价值**：解决 S015 L3 §3.2 的"`default_agent: home-serenity` 启动失败"延伸问题——可以禁止特定 subagent_type 防 LLM 误用。

**风险**：低。

#### 4.2.4 🟡 P1-2: Subagent depth limit（OMO 模式）

**目标**：防止 subagent 无限嵌套。

**实现路径**：订阅 `event` hook 的 `session.created`，维护 Map<sessionId, parentId>：
```ts
event: async ({ event }) => {
  if (event.type === "session.created") {
    const depth = await computeDepth(event.properties.sessionID)
    if (depth > MAX_DEPTH) {
      await client.session.abort({ path: { id: event.properties.sessionID } })
    }
  }
}
```

**价值**：必需——否则恶意/混乱的 prompt 可能让 LLM 无限嵌套 task。

**风险**：中。depth 计算需递归查 session tree，可能慢。

#### 4.2.5 🟡 P1-3: Session event hook + parent wake

**目标**：subagent 完成时**主动注入 system-reminder 到主 agent**（OC 原生 `background inject` 的强化版）。

**实现路径**：监听 `session.idle`，找到 child session 的 parent，inject system-reminder：
```ts
event: async ({ event }) => {
  if (event.type === "session.idle" && event.properties.sessionID) {
    const child = event.properties.sessionID
    const parent = await getParentSession(child)  // 自己维护 Map
    if (parent) {
      await client.session.prompt({
        path: { id: parent },
        body: {
          parts: [{
            type: "text",
            synthetic: true,
            text: `<system-reminder>\n[CHILD TASK ${child} COMPLETED]\n...</system-reminder>`
          }]
        }
      })
    }
  }
}
```

**价值**：让主 agent 实时知道 background subagent 完成，**而不用等 foreground 工具调用**。

**风险**：高。system-reminder 注入是侵入式，需谨慎设计防滥用。

#### 4.2.6 🟡 P1-4: `BackgroundManager` 轻量版

**目标**：参考 OMO，但只做并发控制，不做 mailbox / team mode。

**实现路径**：
- 维护 Map<agent_type, count>
- `tool.execute.before` for `task`：count++，> limit 时 throw
- `event` hook `session.idle`：count--

**价值**：解决"LLM 一口气 spawn 10 个 explore subagent 爆 API 配额"。

**风险**：中。需配 SDK `client.session.list()` 看 active session。

#### 4.2.7 🟢 P2: 替换/包装 `task` tool

**目标**：注册 `call_serenity_agent` 作为 task 的 wrapper，加 category / depth limit / 并发控制。

**评价**：⚠️ **部分 dead-end**——LLM 习惯调 `task` 而不是 `call_serenity_agent`，要让 LLM 切到新 tool 需要改 prompt，工作量大。**不如 P1-1 在 task 上加 before hook 透明拦截**。

#### 4.2.8 🟢 P2: Task state machine + 持久化

**目标**：参考 Task Master，加 TaskCreate/TaskUpdate tool。

**评价**：⚠️ **部分 dead-end**——`AGENT_SESSIONS/` 已经是类持久化机制（session close 时存 SESSION.md）。新增 task layer 价值不高。**如果未来要做"长任务分解给 N 个 subagent 并行 + 依赖管理"，再考虑**。

#### 4.2.9 ⚪ P3: Worktree isolation

**目标**：subagent 在独立 git worktree 工作，不污染主 worktree。

**评价**：⚠️ **偏离 ACC/CCC 哲学**——宁静号的核心理念是**单一 CCC 根**（P1 有 `.serenity`），worktree 会破坏 RR5（cwdRoot 内操作）。**不推荐**。

#### 4.2.10 ⚪ Dead-end: 替换 OC 原生 `task` tool

**目标**：plugin 注册同名 `task` tool，整体替换。

**评价**：✅ **完全 dead-end**——OC API 演化时（如新增 `run_in_background`、`primary_tools`）必须自己实现对应逻辑。OMO 已证明这条路**收益低、维护成本高**。**绝不做**。

### 4.3 推荐路线图（D24+）

| 阶段 | 任务 | 风险 | 价值 |
|---|---|---|---|
| **D24 v0.6** | P0-2 `experimental.primary_tools`（零代码） + P1-1 task tool before hook（细粒度权限） | 低 | 高 |
| **D25 v0.7** | P0-1 Category 系统（OMO 模式 + home-serenity config） + P1-2 subagent depth limit | 中 | 极高 |
| **D26 v0.8** | P1-3 Session event hook + parent wake injection + P1-4 BackgroundManager 轻量版 | 高 | 高 |
| **D27+** | P2 Task state machine（仅当 home-yh-exist 演化需要） | 低 | 中 |

**不做**：worktree isolation（P3）、替换 task tool（Dead-end）、全功能 Team Mode（OMO 路线偏离 ACC/CCC 哲学）。

---

## 5. 总结与建议

### 5.1 三句话

1. **OpenCode 的 delegate 是单层 task tool + BackgroundJob 扩展**，没有 first-class subagent concept——这是 OC 与 CC 的根本差异。所有插件层 delegate 增强都是"在 task 前后包装"或"绕开 task 自己造"。
2. **OMO 是当前最深入的 delegate 扩展**（54+ hooks、Category 系统、BackgroundManager、Team Mode）——值得借鉴的是 Category + BackgroundManager，不是 Team Mode（偏离 ACC 哲学）。
3. **当前 plugin 在 delegate 维度最欠的是 subagent 权限策略 + 深度限制**——这两个是 P0/P1 优先级，零代码或低代码即可落地。

### 5.2 决策建议

| 决策 | 建议 |
|---|---|
| 是否要做 Category 系统？ | ✅ **做**——D25 v0.7，P0 |
| 是否要做 Subagent depth limit？ | ✅ **做**——D25 v0.7，P1 |
| 是否要做 Team Mode？ | ❌ **不做**——偏离 ACC/CCC 哲学，且 OMO/CC 已有 |
| Loop Tool 是 delegate 吗？ | ❌ **不是**——是独立 headless agent harness；保留 Loop Tool 不动 |
| 是否要替换 OC task tool？ | ❌ **绝不做**——OMO 已证明 dead-end |

### 5.3 与 S035 主线的衔接

| S035 D# | 当前 | D24+ 建议 |
|---|---|---|
| D6 TUI 状态指示 | 🔴 未开始 | **可与 session event hook 联动**——TUI 顶部显示"1 background subagent running" |
| D24 SEP v1 | ✅ v0.4.14 已落地 | 与 subagent task 集成——subagent 也可以发 SEP hook |
| **D25 Category + depth limit** | ❌ | **本调研推荐 P0 候选** |
| **D26 BackgroundManager 轻量版** | ❌ | **本调研推荐 P1 候选** |
| Loop Tool D27 | ✅ v0.5.5-0.5.21 | **保留**——与 delegate 并行存在 |

---

## 附录 A — 关键源码引用清单

| 引用 | URL / 文件 |
|---|---|
| opencode TaskTool 实现 | `AGENT_SESSIONS/2026-06-04--S015--opencode-plugin-investigation/refs/opencode-src/packages/opencode/src/tool/task.ts:104-322` |
| opencode subagent permission 派生 | `AGENT_SESSIONS/2026-06-04--S015--opencode-plugin-investigation/refs/opencode-src/packages/opencode/src/agent/subagent-permissions.ts:18-35` |
| opencode 5 扩展点（S015 L3） | `AGENT_SESSIONS/2026-06-04--S015--opencode-plugin-investigation/docs/opencode-extension-points-codebase.md:11-18` |
| opencode plugin 官方文档 | <https://opencode.ai/docs/plugins/> |
| OMO README | <https://github.com/code-yeongyu/oh-my-openagent/blob/dev/README.md> |
| OMO Features Reference | <https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md> |
| OMO BackgroundManager | <https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/features/background-agent/manager.ts> |
| OMO create-hooks | <https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/create-hooks.ts> |
| OMO create-core-hooks | <https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/plugin/hooks/create-core-hooks.ts> |
| Claude Code Subagent | <https://docs.claude.com/en/docs/claude-code/sub-agents> |
| Claude Code Agent Teams | <https://new.qq.com/rain/a/20260207A0403T00> + 多个二级源 |
| claude-task-master | <https://github.com/eyaltoledano/claude-task-master> |
| Serenity plugin 当前版本 | `AI_LAB/opencode-serenity-plugin/package.json` (v0.5.21) |
| Serenity Loop Tool | `AI_LAB/opencode-serenity-plugin/src/tools/loop-tool.ts:1-178` |
| Serenity plugin entry | `AI_LAB/opencode-serenity-plugin/src/index.ts:42-82` |
| Serenity hooks 目录 | `AI_LAB/opencode-serenity-plugin/src/hooks/{compacting,permission-auto-reply,permission-guards,shell-env}.ts` |

## 附录 B — OMO 54+ Hook 完整分类

| Tier | Hook | Event | 用途 |
|---|---|---|---|
| Session (24) | directory-agents-injector | PreToolUse + PostToolUse | 注入 AGENTS.md（OC 1.1.37+ 已自动，deprecated） |
| Session | directory-readme-injector | PreToolUse + PostToolUse | 注入 README.md |
| Session | rules-injector | PreToolUse + PostToolUse | 注入 `.claude/rules/` |
| Session | compaction-context-injector | Event | 压缩时保留关键 context |
| Session | preemptive-compaction | Event | 主动压缩避免 token 满 |
| Session | auto-update-checker | Event | 启动时显示版本 |
| Session | background-notification | Event | 后台 agent 完成通知 |
| Session | session-notification | Event | OS 系统通知（agent idle） |
| Session | task-resume-info | PostToolUse | task resume 信息 |
| Session | anthropic-context-window-limit-recovery | Event | Claude context 限制恢复 |
| Session | runtime-fallback | Event + Message | API error 自动切 fallback model |
| Session | model-fallback | Event + Message | model fallback chain |
| Session | ralph-loop | Event + Message | 自指循环 |
| Session | todo-continuation-enforcer | Event | todo 完成强制继续 |
| Session | compaction-todo-preserver | Event | 压缩时保留 todo 状态 |
| Session | unstable-agent-babysitter | Event | 不稳定 agent 恢复 |
| Session | claude-code-hooks | All | 兼容 CC hook 系统 |
| Session | interactive-bash-session | PostToolUse + Event | tmux session 管理 |
| Session | non-interactive-env | PreToolUse | 非交互环境约束 |
| Session | agent-usage-reminder | PostToolUse + Event | 提醒用专门 agent |
| Session | stop-continuation-guard | Event + Message | 阻止 continuation |
| Session | keyword-detector | Message + Transform | IntentGate 关键词检测 |
| Session | delegate-task-retry | PostToolUse + Event | 重试失败的 delegate |
| Session | empty-task-response-detector | PostToolUse | 检测空响应 |
| Tool Guard (16) | write-existing-file-guard | PreToolUse | 防覆盖未读文件 |
| Tool Guard | comment-checker | PostToolUse | 检查 AI 注释 |
| Tool Guard | tool-output-truncator | PostToolUse | 截断输出 |
| Tool Guard | tasks-todowrite-disabler | PreToolUse | task 模式下禁 todowrite |
| Tool Guard | question-label-truncator | PreToolUse | 截断 question 标签 |
| Tool Guard | prometheus-md-only | PreToolUse | Prometheus 只输出 markdown |
| Tool Guard | edit-error-recovery | PostToolUse + Event | edit 失败恢复 |
| Tool Guard | hashline-read-enhancer | PostToolUse | 加 hashline 标记 |
| Tool Guard | (其他 8 个) | ... | ... |
| Transform (5) | (5 个 transform) | ... | chat.system.transform 等 |
| Continuation (7) | ralph-loop | Event + Message | 已在 Session |
| Continuation | todo-continuation-enforcer | Event | 已在 Session |
| Continuation | start-work | Message | 处理 /start-work |
| Continuation | auto-slash-command | Message | 自动执行 slash 命令 |
| Continuation | (其他 3 个) | ... | ... |
| Skill (2) | skill-set-router | ... | skill 路由 |
| Skill | intent-gate | ... | IntentGate |
| **Team Mode 增量 (+7)** | +1 Tool Guard | ... | team 工具守卫 |
| Team Mode | +2 Transform | ... | team 转换 |
| Team Mode | +4 session event handlers | ... | team session 处理 |

## 附录 C — 与 S015 L3 扩展点对照（验证完整性）

| S015 L3 扩展点 | 当前 plugin | D24+ 增量 |
|---|---|---|
| E1 plugin 加载器 | ✅ | — |
| E2 tool.execute.before/after | ✅ bash + 路径 | + P1-1 task tool 拦截 |
| E3 权限拦截 | ✅ permission.asked | — |
| E4 compacting | ✅ SKILL.md 注入 | — |
| E5 throw 错误处理 | ✅ try/catch | — |
| (新) **subagent task 配置** | ❌ | + P0-2 `experimental.primary_tools` |
| (新) **subagent depth limit** | ❌ | + P1-2 |
| (新) **subagent parent wake** | ❌ | + P1-3 |
| (新) **subagent 并发控制** | ❌ | + P1-4 BackgroundManager 轻量版 |
| (新) **subagent category routing** | ❌ | + P0-1 |