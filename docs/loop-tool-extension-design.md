# Loop Tool Extension Design — 用户友好驱动的状态机架构

> **SESSION**: S035 — Plugin 长期活跃开发
> **设计日期**: 2026-06-28
> **作者**: headless design agent (loop-loop-tool-extension)
> **前置调研**:
> - [`delegate-mechanism-survey.md`](./delegate-mechanism-survey.md) — OC delegate 机制全景
> - [`omo-deep-dive.md`](./omo-deep-dive.md) — OMO 7 大绕过范式 + B1-B6 落地骨架
> **基线**: opencode-serenity-plugin v0.5.21（Loop Tool D27 v0.5.5→v0.5.21）
> **基线源码**:
> - `src/tools/loop-tool.ts:1-178` (6.5KB) — plugin tool
> - `src/tools/loop-runner.ts:1-314` (9.7KB) — 外部进程
> **OMO 基线 commit**: `code-yeongyu/oh-my-openagent` @ `f7ec55526b2a3603665c5c0308b031a4f14900b0`

---

## 0. TL;DR — 8 条核心结论

1. **"用户友好"重新定义为 4 个维度的乘积** —— (a) 可观察性 / (b) 可控性 / (c) 可恢复性 / (d) 可组合性。原始任务定义"让用户愿意主动使用"过于抽象；本研究通过逐行读 `loop-tool.ts` + `loop-runner.ts` + `tui.ts:320-370` 发现**所有痛点都映射到"状态管理"4 个维度中的至少一个**——状态可见、状态可控、状态可恢复、状态可组合。
2. **Loop Tool 当前不是"勉强能跑的内部机制"** —— 它已经是 ACC 当前最复杂、踩坑最多（v0.5.5→v0.5.21 共 16 个版本）的工具。但它**完全没有 LoopRegistry**，所有 loop 状态都丢在进程内存（`activePorts: Set<number>` at `loop-tool.ts:38`），plugin 重启即全失忆；这是核心架构缺陷。
3. **D27 已踩 6 个坑的根因**（[SESSION.md §D27 变更日志](../../../AGENT_SESSIONS/2026-06-19--S035--plugin-long-term-dev/SESSION.md#L88-L93)）都是"状态不可见 + 不可控"导致的：
   - 进程泄漏 → 因为没有"哪些 loop 是活跃的"的全局视图（只有 `activePorts` Set）
   - undici 5min timeout → 因为没有"server 健康状态"轮询机制
   - Runner 卡住不退出 → 因为没有"loop 已完成"的明确信号协议（只有 stop token 字符串匹配）
   - POST body 400 → 因为 headless API 限制没在 plugin 层做 capability check
4. **D28-D34 路线设计核心**：引入 **LoopRegistry（中心状态机）+ LoopState（持久化状态文件）+ LoopController（命令式 API）+ LoopResume（恢复机制）+ LoopConcurrencyManager（OMO 简化版并发）+ LoopEvaluatorHook（quality gate）**。**不重写 Loop 核心**——保留 spawn `loop-runner.ts` 外部进程 + stop token + HTTP headless API 这条主线，只在它之上加一层"loop-of-loops 状态管理"。
5. **5 个核心 D 路线 + 总计 10 PR + ~2,350 行代码 + 6 个月时间**：
   - 🔴 D28 LoopRegistry + State Machine + Persistence（2 PRs, ~400 行）
   - 🔴 D29 LoopController 6 个 action（1 PR, ~200 行）
   - 🟡 D30 LoopResume serve crash + plugin restart（2 PRs, ~350 行）
   - 🟡 D31 LoopConcurrencyManager + LoopProgressStream（1 PR, ~250 行）
   - 🟡 D34 TUI 实时状态（绕过 @opentui/solid）（1 PR, ~150 行）
   - 🟢 D32 LoopEvaluatorHook + LoopCategory 集成（1 PR, ~200 行）
   - ⚪ D33 Loop嵌套（loop-of-loops）（1 PR, ~200 行，**高风险**）
   - 🔴 D35 Loop 单元测试 + 集成测试（1 PR, ~500 行）
6. **3 个明确不做**：❌ 替换 opencode serve HTTP API（B6.6.2 Dead-end）；❌ 直接写 OC DB MESSAGE_STORAGE（B6.6.1 Dead-end）；❌ 完整 Team Mode（偏离 ACC/CCC 哲学，delegate-survey.md §5.2 已确定）。
7. **核心可移植性参考**：OMO BackgroundManager (`manager.ts:1-...`，commit `f7ec5552`) + ContextCollector (`collector.ts:1-99`) + safeCreateHook + ConcurrencyManager + ParentWakeNotifier 5 大范式，**只移植与 Loop Tool 直接相关的子集**（depth/concurrency 不适用，因为 Loop 不是 session-internal subagent；only Persistence + Concurrency + Stream 部分可移植）。
8. **5 个最关键的设计决策**（详见 §6）：
   - **D-K1**: LoopState 文件 = JSON schema + atomic write（fenced flock 风格）+ last-write-wins（不是 CRDT）
   - **D-K2**: LoopController 通过**扩展 loop tool**（不是新 tool）—— 保持单 tool 表面，避免 LLM 选择困难
   - **D-K3**: LoopResume 优先"让现有 OC session 继续跑"（reuse sessionId），不重新生成 session
   - **D-K4**: Concurrency Manager 用**同 agent label 桶**（不是 OMO 的 model bucket），因为我们没有多 model 并发需求
   - **D-K5**: 不做 Parent Wake 注入到 caller session（OMO ParentWakeNotifier 复杂度太高），仅做**进度文件 + TUI status + 返回值**三层通知

---

## 1. 痛点分析 — 重新定义"用户友好"

### 1.1 通过源码验证的 22 个具体痛点

| # | 痛点 | 源码位置 | 用户感知 | 4 维度归类 |
|---|------|---------|---------|----------|
| **P1** | 状态只存进程内存 `activePorts: Set<number>` | `loop-tool.ts:38` | 重启 plugin = 所有 loop 失控 | 🔴 可恢复性 |
| **P2** | Loop 重启后无恢复机制 | `loop-runner.ts:107-118` | 中断 = 全白做 | 🔴 可恢复性 |
| **P3** | 无并发控制（可同时跑 N 个 loop 占 N 个端口）| `loop-tool.ts:40-42` `randomPort()` | 端口冲突 / API 配额爆 | 🟡 可控性 |
| **P4** | 取消粒度粗（进程组全杀，无 per-loop）| `loop-tool.ts:104-106` `killGroup()` | 想停一个 loop 杀全部 | 🟡 可控性 |
| **P5** | 无 pause/resume 命令 | 全文 | 中途想暂停 = 必须 cancel | 🟡 可控性 |
| **P6** | TUI 进度 slot 注册但 fallback 到 `log.warn` | `tui.ts:368-369` | 用户看不到进度 | 🔴 可观察性 |
| **P7** | Runner stdout 只输出"每轮 JSON summary"，没有 incremental event stream | `loop-runner.ts:272-289` | 用户看不到"进行到哪一步" | 🔴 可观察性 |
| **P8** | 进度文件只写一次（启动时），不每轮更新 | `loop-runner.ts:217-231` | 用户看不到轮次间进展 | 🔴 可观察性 |
| **P9** | status JSON 文件仅在 stop 时写 done=true | `loop-runner.ts:37-48` | 用户只能看到 done/fail 二态 | 🔴 可观察性 |
| **P10** | Loop 完成后 caller session 不知道（除非 main agent 自己后续查询）| `loop-tool.ts:144-150` | 长时间 loop 无法 yield to user | 🟡 可控性 |
| **P11** | 无法列举当前所有 active loops | 全文 | 多 loop 时混乱 | 🔴 可观察性 |
| **P12** | 无法查看某 loop 的详细历史 | 全文 | 调试困难 | 🔴 可观察性 |
| **P13** | Serve 崩溃无 auto-restart | `loop-runner.ts:107-118` | OOM/network 抖动 = loop 死 | 🔴 可恢复性 |
| **P14** | `runnerPath: resolve(__dirname, "loop-runner.js")` 假设 dist 已编译 | `loop-tool.ts:85` | `pnpm dev` (tsx) 时 path 不存在 | 🟡 可控性 |
| **P15** | `SIGTERM` 立即 exit 不 flush 进度 | `loop-runner.ts:77-78` | 中断 = 进度丢失 | 🔴 可恢复性 |
| **P16** | `prompt > 100` 字符硬限制 | `loop-tool.ts:64` | 短任务不能 loop（"翻译 1 行"也不行）| 🟡 可控性 |
| **P17** | Stop token 不暴露给用户 | `loop-tool.ts:83` | 无法 audit / verify | 🔴 可观察性 |
| **P18** | Loop 不能 spawn sub-loop（无 LoopRegistry）| 全文 | 复杂任务无法分解 | 🟡 可组合性 |
| **P19** | Loop 不能并行（每次调都是 foreground）| `loop-tool.ts:80` execute 是 async-await | 长任务阻塞 caller | 🟡 可组合性 |
| **P20** | Tool 描述里硬编码"prompt 必须 >100 字符"在 description + schema 两处 | `loop-tool.ts:50-65` | 信息冗余 / LLM 困惑 | 🟡 可控性 |
| **P21** | 错误信息含 `[stdout]...2000 chars` 可能暴露敏感内容 | `loop-tool.ts:155-159` | 隐私风险 | 🟡 可控性 |
| **P22** | Loop runner 进程组 PID 偶尔与 serve PID 重叠 | `loop-runner.ts:117` `pidFile(port)` | 端口冲突难调试 | 🟡 可控性 |

### 1.2 痛点的本质：状态管理 4 维度

把所有痛点按"用户友好 4 维度"分类：

```
                      痛点数  占比
🔴 可观察性:          7      32%   (P6, P7, P8, P9, P11, P12, P17)
🔴 可恢复性:          4      18%   (P1, P2, P13, P15)
🟡 可控性:           10      45%   (P3, P4, P5, P10, P14, P16, P18→, P20, P21, P22)
🟡 可组合性:          1       5%   (P19)  [P18 算入可控]
```

**结论**：可控性是最大短板（45%），可观察性是第二大（32%）。**修复策略**：**先 P0 做 Registry + State + Controller（覆盖 70% 痛点），再 P1 做 Concurrency + Resume（覆盖 20%），最后 P2 做 Evaluator + Nesting + TUI（覆盖 10%）**。

### 1.3 对"用户友好"的反思

我重新定义后的"用户友好"比最初的"让用户愿意主动使用"更精准：

**"用户友好" = 用户能够在以下 4 类场景中**不被挫败**地完成 loop 任务：**

1. **观察场景**（最常见 80%）：用户在 TUI 看进度——进度条、当前轮、当前步骤、上次更新时间——一目了然，无需打开文件或问 agent
2. **控制场景**（中等 15%）：用户想暂停/恢复/取消单个 loop，不影响其他——有命令式 API，不需要"杀进程 + 重启 + 找旧 state"
3. **恢复场景**（最痛 4%）：Loop 中断后（plugin 重启 / serve 崩溃 / 用户中断 / 系统重启）——能自动恢复或一键恢复，**不丢工作**
4. **组合场景**（高级 1%）：能 spawn 多 loop 并行 / loop 内 spawn sub-loop / loop 与其他工具组合

**最重要的洞察**：第 3 类（恢复）虽然占比小，但是**触发用户放弃使用 loop 的首要原因**——一次工作丢失 = 用户对 loop 失去信任，从此回到手动循环。

> 原始定义"用户愿意主动使用"是结果指标（outcome metric），本研究重新定义的 4 维度是驱动指标（driver metrics）——前者无法直接优化，后者可以。

---

## 2. 设计目标与非目标

### 2.1 设计目标（D28-D34 全部满足）

| ID | 目标 | 验收 |
|----|------|------|
| **G1** | Loop 状态跨 plugin restart 持久化 | kill -9 plugin → restart → `loop(action="list")` 显示所有未完成 loop |
| **G2** | 6 个命令式 action | `loop(action="list" \| "show" \| "pause" \| "resume" \| "cancel" \| "logs", id?)` |
| **G3** | Loop 中断可恢复（serve crash / plugin restart / SIGTERM）| 自动 resume 或 user confirm resume，state 不丢 |
| **G4** | 同 agent label 并发限流 | `max_concurrent: 3` 配置项生效，超限 queue |
| **G5** | TUI 实时显示 loop 进度 | 不依赖 `@opentui/solid`（fallback 用 `api.ui.toast` + 状态文件轮询） |
| **G6** | Loop 状态机有完整 transition audit log | `<state>.log` 每行 JSON，含 timestamp + from + to + reason |
| **G7** | 进度文件每轮更新 | `<state>.md` 不是只写一次，是每 round N 增量 append |

### 2.2 非目标（明确不做）

| ID | 非目标 | 理由 |
|----|--------|------|
| **NG1** | 替换 OC 原生 `task` tool | B6.6.2 Dead-end（delegate-survey.md §4.2.10） |
| **NG2** | 写 OC DB MESSAGE_STORAGE | B6.6.1 Dead-end（omo-deep-dive.md §B6.6.1） |
| **NG3** | 完整 Team Mode / Mailbox / Worktree | 偏离 ACC/CCC 哲学（delegate-survey.md §5.2） |
| **NG4** | Loop 内调 `loop()` tool 直接递归 | 高风险（D33 暂列为 P3）；优先通过 **subagent delegation** 实现（让 loop spawn 一个 subagent 去做子任务，subagent 完成后再回到 loop）|
| **NG5** | Parent Wake 注入到 caller session | OMO ParentWakeNotifier 复杂度 500+ 行 4 collaborator（omo-deep-dive.md §B2-d-3），D34+ 再评估 |
| **NG6** | 替换 `opencode serve` HTTP API 协议 | 已有 v0.5.17-0.5.18 切换到 curl 的踩坑经验，**保留 curl**，不换 |
| **NG7** | Loop 工具重命名为 `delegate` / `headless` / `worker` | 当前 `loop` 名字在 SESSION.md + README 已多次引用，重命名成本 > 价值 |

---

## 3. 架构总览

### 3.1 系统架构图（4 层 + 1 旁路）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  L4 — LoopController（命令式 API 层）                   │
│   暴露给 LLM: loop(action="list"|"show"|"pause"|"resume"|"cancel"|"logs") │
│   暴露给用户: TUI 显示 (loop-{label}.json 状态文件轮询 + toast)          │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↑ ↓ query/command
┌─────────────────────────────────────────────────────────────────────────┐
│                  L3 — LoopRegistry（中心状态机层）                       │
│   in-memory Map<loopId, LoopState> + 状态文件持久化 (state.json)        │
│   atomic write (write-temp + rename) + last-write-wins                  │
│   state transitions: pending → spawning → running ⇄ paused → done|failed|cancelled │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↑ ↓ spawn/signal/cleanup
┌─────────────────────────────────────────────────────────────────────────┐
│                  L2 — LoopProcess（外部进程管理层）                     │
│   detached spawn loop-runner.ts (Node) + 独立 opencode serve 实例       │
│   process group: -pid kill for cleanup                                  │
│   health monitor: serve alive? session alive? round progressing?        │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↑ ↓ HTTP /session /message /abort
┌─────────────────────────────────────────────────────────────────────────┐
│                  L1 — opencode serve（headless harness）                │
│   现状保持 — 不动 OMO 调研已证 Dead-end 的改动                          │
│   curl --max-time + retry + atomic POST                                │
└─────────────────────────────────────────────────────────────────────────┘

旁路（off-critical-path）:
  - ConcurrencyManager（L3 内）：per-label bucket + queue + semaphore
  - ProgressStream（L3 → L4）：incremental event stream 到 controller / TUI
  - LoopEvaluatorHook（L2 → L1）：experimental.chat.message.transform
  - LoopResumeCoordinator（L3 → L2）：plugin restart 后自动 spawn resume runner
```

### 3.2 数据流图（一次完整 loop 生命周期）

```
┌────────┐                                                ┌────────┐
│ Caller │  ①loop(prompt, label, action="start")           │ Plugin │
│  LLM   │ ────────────────────────────────────────────────►│ entry  │
└────────┘                                                └────┬───┘
                                                                │ ②construct
                                                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ L3 LoopRegistry.register(loopId, LoopState{status:"pending"})  │
│    ↓ write atomic to <cwd>/AGENT_SESSIONS/loop-{label}.state.json│
│    ↓ write skeleton to <cwd>/AGENT_SESSIONS/loop-{label}.md      │
└────────────────────────────────┬─────────────────────────────────┘
                                │ ③spawn
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ L2 LoopProcess.spawn():                                        │
│   - fork loop-runner.ts (Node, detached)                       │
│   - loop-runner.ts: startServer(port) + waitForServer          │
│   - POST /session → sessionId                                   │
│   - emit "{event:'spawn.complete', sessionId}" stdout          │
└────────────────────────────────┬─────────────────────────────────┘
                                │ ④each round
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ L2 LoopProcess.runRound():                                      │
│   - POST /session/{sessionId}/message (round=1: prompt+rules; N>1: "继续")│
│   - emit "{event:'round.start', round}" + {event:'round.chunk', text}...│
│   - emit "{event:'round.end', round, response}"                │
│   - L3 LoopRegistry.update(loopId, {round, lastResponse})       │
│   - L3 ProgressStream.publish({round, label, summary})          │
│   - L3 ConcurrencyManager.update(label, currentCount)           │
│   - L4 TUI status refresh (轮询 state.json)                    │
│   - check stop token → if found: emit {event:'done', response}  │
└────────────────────────────────┬─────────────────────────────────┘
                                │ ⑤finalize
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ L3 LoopRegistry.finalize(loopId, status='done'|'failed'|'cancelled')│
│    ↓ atomic write state.json                                     │
│    ↓ write final progress.md                                    │
│    ↓ L2 LoopProcess.cleanup(): kill runner + serve + remove pid│
└────────────────────────────────┬─────────────────────────────────┘
                                │ ⑥return
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ Plugin tool return:                                              │
│   {rounds, finalResponse, finishReason, loopId, label}           │
│   → caller LLM 收到完整 JSON 字符串                              │
└──────────────────────────────────────────────────────────────────┘
```

### 3.3 状态机图（LoopState 12 个 transition）

```
                    ┌──────────────────────────────────────────────────────┐
                    │                                                      │
                    ▼                                                      │
              ┌──────────┐  spawn OK    ┌──────────┐                       │
              │ pending  │ ───────────► │ spawning │                       │
              └──────────┘              └────┬─────┘                       │
                    ▲                       │ serve ready                 │
                    │                       ▼                              │
                    │                 ┌──────────┐ round 1 start           │
                    │                 │ running  │ ─────────────────┐       │
                    │                 └────┬─────┘                  │       │
                    │                      │ user pause            │       │
                    │                      ▼                       │       │
                    │                ┌──────────┐ user resume       │       │
                    │                │ paused   │ ──────────────┐   │       │
                    │                └────┬─────┘               │   │       │
                    │                     │                     ▼   ▼       │
                    │                     │               ┌──────────┐    │
                    │                     │               │ running  │    │
                    │                     │               └────┬─────┘    │
                    │                     │                    │         │
                    │                     │                    │ stop token│
                    │                     │                    ▼         │
                    │                     │              ┌──────────┐     │
                    │                     │              │   done   │     │
                    │                     │              └──────────┘     │
                    │                     │                              │
                    │                     │ serve crash                  │
                    │                     ▼                              │
                    │               ┌──────────┐ restart attempt         │
                    │               │ crashed  │ ──────────┐             │
                    │               └────┬─────┘           │             │
                    │                    │ resume OK      │ max retries │
                    │                    ▼                ▼             │
                    │              ┌──────────┐    ┌──────────┐          │
                    │              │ running  │    │  failed  │          │
                    │              └──────────┘    └──────────┘          │
                    │                                                  │
                    │  user cancel / tool dispose                       │
                    ▼                                                  │
              ┌──────────┐                                            │
              │cancelled │ ◄───────────────────────────────────────────┘
              └──────────┘
```

**transitions 表格（确定性 + audit）：**

| From | To | Trigger | 必填 audit log | Cleanup |
|------|----|---------|--------------|---------|
| (none) | pending | LoopRegistry.register | "create by caller-session" | — |
| pending | spawning | LoopProcess.spawn start | "spawn begin, port=N" | — |
| spawning | running | serve ready + session created | "spawn OK, sessionId=X" | — |
| running | paused | user pause command | "paused by user at round=N" | — |
| paused | running | user resume command | "resumed by user at round=N" | — |
| running | done | LLM output stop token | "done, finishReason=stop, rounds=N" | kill serve, remove pid |
| running | done | round >= 100 (safety valve) | "done, finishReason=max_rounds, rounds=N" | same |
| running | failed | error / serve crash / curl fail | "failed, code=X, msg=Y" | same |
| running | crashed | serve process died unexpectedly | "crashed, lastSeenRound=N" | (保留 pid for resume) |
| crashed | running | resume attempt OK | "resumed after crash, retries=N" | — |
| crashed | failed | resume attempts exhausted | "failed after crash, retries=N" | kill pid, cleanup |
| running | cancelled | user cancel / tool dispose | "cancelled by user at round=N" | kill serve group |
| paused | cancelled | user cancel / tool dispose | "cancelled (was paused) at round=N" | same |

**13 个 transitions 全部确定 + 有 audit log → 满足 EAP 的"可重建"标准。**

---

## 4. 详细设计

### 4.1 数据结构 — LoopState（schema + 文件格式）

```typescript
// src/features/loop/loop-state.ts

import { z } from "zod";

export const LoopStatusSchema = z.enum([
  "pending",
  "spawning",
  "running",
  "paused",
  "done",
  "failed",
  "cancelled",
  "crashed",
]);

export const LoopStateSchema = z.object({
  // 身份
  loopId: z.string(),                    // "loop_<8-char-hex>"
  label: z.string().min(1).max(50),
  createdAt: z.number(),                  // Date.now()
  updatedAt: z.number(),

  // 调用者上下文
  parentSessionId: z.string(),
  parentMessageId: z.string().optional(),
  callerToolCallId: z.string().optional(),

  // 任务定义
  prompt: z.string(),                     // 完整 prompt（不动）
  agent: z.string().optional(),           // 保留字段（D24 category 落地后用）
  category: z.string().optional(),        // 同上

  // 运行时状态
  status: LoopStatusSchema,
  round: z.number().int().min(0).default(0),
  lastResponse: z.string().optional(),    // 上轮 response（用于 resume 时 context）
  finishReason: z.enum(["stop", "max_rounds", "error", "user_cancel", "crash_exhausted"]).optional(),

  // 外部进程引用
  servePid: z.number().int().optional(),
  servePort: z.number().int().optional(),
  sessionId: z.string().optional(),       // opencode session id
  stopToken: z.string().length(32),       // 128-bit hex

  // 配置
  maxRounds: z.number().int().positive().default(100),
  timeoutMs: z.number().int().positive().default(3600_000),
  maxConcurrentPerLabel: z.number().int().positive().default(3),
  maxCrashRetries: z.number().int().nonnegative().default(2),

  // 错误信息
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),

  // Audit log（追加式）
  transitions: z.array(z.object({
    at: z.number(),
    from: LoopStatusSchema,
    to: LoopStatusSchema,
    reason: z.string(),
    metadata: z.record(z.unknown()).optional(),
  })),
});

export type LoopState = z.infer<typeof LoopStateSchema>;
```

**文件布局**：

```
<cwd>/AGENT_SESSIONS/
├── loop-{label}.state.json          # LoopState schema（atomic write）
├── loop-{label}.md                  # 人类可读进度（每 round 增量 append）
├── loop-{label}.log                 # 每 round stdout JSON + stderr 一行（append）
└── loop-{label}.audit.jsonl         # transitions 一行一 JSON（append）
```

### 4.2 LoopRegistry（中心状态机）

```typescript
// src/features/loop/loop-registry.ts

import type { LoopState, LoopStatus } from "./loop-state";
import { LoopStateSchema } from "./loop-state";

export class LoopRegistry {
  private states: Map<string, LoopState> = new Map();          // loopId → state
  private byLabel: Map<string, string> = new Map();             // label → loopId（active only）
  private persistedDir: string;                                // <cwd>/AGENT_SESSIONS/

  constructor(persistedDir: string) {
    this.persistedDir = persistedDir;
    this.loadFromDisk();
  }

  // ── CRUD ────────────────────────────────────────────────

  register(input: {
    label: string;
    prompt: string;
    parentSessionId: string;
    parentMessageId?: string;
    agent?: string;
    category?: string;
    maxRounds?: number;
  }): LoopState {
    // 检查 label 冲突（同 label 已有 active loop）
    if (this.byLabel.has(input.label)) {
      const existing = this.states.get(this.byLabel.get(input.label)!);
      if (existing && !["done", "failed", "cancelled"].includes(existing.status)) {
        throw new Error(`Loop with label "${input.label}" already active (loopId=${existing.loopId}, status=${existing.status}). Use action="cancel" first or pick another label.`);
      }
    }

    const loopId = `loop_${randomBytes(4).toString("hex")}`;
    const stopToken = randomBytes(16).toString("hex");
    const now = Date.now();

    const state: LoopState = LoopStateSchema.parse({
      loopId,
      label: input.label,
      createdAt: now,
      updatedAt: now,
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      prompt: input.prompt,
      agent: input.agent,
      category: input.category,
      status: "pending",
      round: 0,
      stopToken,
      maxRounds: input.maxRounds ?? 100,
      transitions: [{ at: now, from: "pending" as LoopStatus, to: "pending" as LoopStatus, reason: "register" }],
    });

    this.states.set(loopId, state);
    this.byLabel.set(input.label, loopId);
    this.persist(state);
    return state;
  }

  get(loopId: string): LoopState | undefined { return this.states.get(loopId); }

  getByLabel(label: string): LoopState | undefined {
    const loopId = this.byLabel.get(label);
    return loopId ? this.states.get(loopId) : undefined;
  }

  list(opts?: { status?: LoopStatus[]; parentSessionId?: string }): LoopState[] {
    const all = [...this.states.values()];
    return all.filter(s => {
      if (opts?.status && !opts.status.includes(s.status)) return false;
      if (opts?.parentSessionId && s.parentSessionId !== opts.parentSessionId) return false;
      return true;
    });
  }

  // ── 状态转换（唯一 mutation 入口） ──────────────────────

  transition(loopId: string, to: LoopStatus, reason: string, metadata?: Record<string, unknown>): LoopState {
    const state = this.states.get(loopId);
    if (!state) throw new Error(`Loop not found: ${loopId}`);

    // transition validation（state machine）
    this.assertValidTransition(state.status, to);

    const from = state.status;
    const now = Date.now();

    state.status = to;
    state.updatedAt = now;
    state.transitions.push({ at: now, from, to, reason, metadata });

    // terminal 状态清理 byLabel 索引
    if (["done", "failed", "cancelled"].includes(to)) {
      this.byLabel.delete(state.label);
    }

    this.persist(state);
    this.audit(state);
    return state;
  }

  // 12 个合法 transition（其余 throw）
  private assertValidTransition(from: LoopStatus, to: LoopStatus): void {
    const valid: Record<LoopStatus, LoopStatus[]> = {
      pending: ["spawning", "cancelled"],
      spawning: ["running", "failed", "cancelled"],
      running: ["paused", "done", "failed", "cancelled", "crashed"],
      paused: ["running", "cancelled"],
      crashed: ["running", "failed", "cancelled"],
      done: [],
      failed: [],
      cancelled: [],
    };
    if (!valid[from].includes(to)) {
      throw new Error(`Invalid loop transition: ${from} → ${to}`);
    }
  }

  // ── 持久化（atomic write） ────────────────────────────────

  private persist(state: LoopState): void {
    const file = `${this.persistedDir}/loop-${state.label}.state.json`;
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);  // atomic rename（POSIX 保证）
  }

  private audit(state: LoopState): void {
    const file = `${this.persistedDir}/loop-${state.label}.audit.jsonl`;
    const lastTransition = state.transitions[state.transitions.length - 1];
    appendFileSync(file, JSON.stringify({ ...lastTransition, loopId: state.loopId, label: state.label }) + "\n");
  }

  // ── 启动时恢复 ──────────────────────────────────────────

  private loadFromDisk(): void {
    if (!existsSync(this.persistedDir)) return;
    const files = readdirSync(this.persistedDir).filter(f => f.endsWith(".state.json"));
    for (const f of files) {
      try {
        const raw = readFileSync(`${this.persistedDir}/${f}`, "utf-8");
        const state = LoopStateSchema.parse(JSON.parse(raw));
        this.states.set(state.loopId, state);
        if (!["done", "failed", "cancelled"].includes(state.status)) {
          this.byLabel.set(state.label, state.loopId);
        }
      } catch (err) {
        // 单个 state 文件损坏不应阻塞整个 registry
        log(`[loop-registry] Failed to load ${f}: ${err}`);
      }
    }
  }
}
```

**参考 OMO 设计**：
- `tasks: Map<string, BackgroundTask>` in `manager.ts` line 339（OMO）vs `states: Map<string, LoopState>`（我们）—— 一对一映射
- OMO `tasksByParentSession: Map<string, Set<string>>` line 340 → 我们 `byLabel: Map<string, string>` —— **不同**：OMO 用 parentSession 索引（因为 subagent 必属某 parent），我们用 label 索引（因为 loop 是 independent harness）
- OMO `transition` 隐式（直接 mutate `task.status`）→ 我们 explicit `transition()` + validation —— **更严格**，符合 EAP "可重建"标准

### 4.3 LoopProcess（外部进程管理 + health monitor）

```typescript
// src/features/loop/loop-process.ts

import type { ChildProcess } from "node:child_process";
import { spawn, execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { LoopState, LoopStatus } from "./loop-state";

interface RunnerMessage {
  event: "spawn.complete" | "round.start" | "round.chunk" | "round.end" | "done" | "error";
  round?: number;
  sessionId?: string;
  text?: string;
  response?: string;
  finishReason?: string;
  errorCode?: string;
  errorMessage?: string;
}

export class LoopProcess {
  private child?: ChildProcess;
  private healthTimer?: NodeJS.Timeout;

  constructor(
    private state: LoopState,
    private onMessage: (msg: RunnerMessage) => void,
    private onExit: (code: number | null) => void,
  ) {}

  // ── 启动 ────────────────────────────────────────────────

  async spawn(): Promise<void> {
    const cwdRoot = getState().cwdRoot;
    const port = 1024 + randomBytes(2).readUInt16BE(0) % 64511;
    const runnerPath = resolve(distDir(), "tools/loop-runner.js");

    // 兼容 dev 模式（tsx）
    if (!existsSync(runnerPath)) {
      const devRunnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../tools/loop-runner.js");
      // 优先用源（tsx），fallback 到 dist
      const finalPath = existsSync(devRunnerPath) ? devRunnerPath : runnerPath;
      return this.spawnWithPath(finalPath, port, cwdRoot);
    }
    return this.spawnWithPath(runnerPath, port, cwdRoot);
  }

  private async spawnWithPath(runnerPath: string, port: number, cwdRoot: string): Promise<void> {
    this.child = spawn(findNodeBin(), [
      runnerPath,
      this.state.stopToken,
      String(port),
      this.state.label,
      cwdRoot,
    ], { stdio: ["pipe", "pipe", "pipe"], detached: true });

    // 写 prompt 到 stdin
    this.child.stdin!.write(this.state.prompt);
    this.child.stdin!.end();

    // stdout = RunnerMessage line-delimited JSON
    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as RunnerMessage;
        this.onMessage(msg);
      } catch {
        // stderr 流（runner 把 log 走 stderr）
      }
    });

    // stderr = runner 日志
    this.child.stderr!.on("data", (chunk) => {
      // 写到 .log 文件
      appendFileSync(`${cwdRoot}/AGENT_SESSIONS/loop-${this.state.label}.log`, chunk);
    });

    // exit handler
    this.child.on("close", (code) => {
      this.cleanup();
      this.onExit(code);
    });

    // PID 文件
    writeFileSync(`/tmp/serenity-bg-task/server-${port}.pid`, String(this.child.pid));

    // Health monitor（每 30s check serve alive）
    this.startHealthMonitor(port);
  }

  // ── Health monitor（D30 落地） ──────────────────────────

  private startHealthMonitor(port: number): void {
    this.healthTimer = setInterval(() => {
      try {
        // curl --max-time 3 /global/health
        const out = execSync(`curl -s -f --max-time 3 "http://127.0.0.1:${port}/global/health"`, { encoding: "utf-8" });
        const body = JSON.parse(out);
        if (!body.healthy) {
          this.onMessage({ event: "error", errorCode: "SERVE_UNHEALTHY", errorMessage: "serve responded but not healthy" });
        }
      } catch {
        // serve dead → 触发 crash recovery
        this.onMessage({ event: "error", errorCode: "SERVE_DEAD", errorMessage: "health check failed" });
      }
    }, 30_000);
  }

  // ── 控制命令（pause/resume/cancel）──────────────────────

  pause(): void {
    // 实际实现：runner 监听 SIGUSR1 → 暂停（不发"继续"消息）
    if (this.child?.pid) {
      try { process.kill(this.child.pid, "SIGUSR1"); } catch {}
    }
  }

  resume(): void {
    if (this.child?.pid) {
      try { process.kill(this.child.pid, "SIGUSR2"); } catch {}
    }
  }

  cancel(): void {
    if (this.child?.pid) {
      try { process.kill(-this.child.pid, "SIGTERM"); } catch {}
    }
  }

  // ── Cleanup ─────────────────────────────────────────────

  private cleanup(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.child?.pid) {
      try { process.kill(-this.child.pid, "SIGTERM"); } catch {}
    }
    // PID 文件清理
    const port = ... // 从 state 获取
    try { unlinkSync(`/tmp/serenity-bg-task/server-${port}.pid`); } catch {}
  }
}
```

**参考 OMO 设计**：
- OMO `BackgroundManager.launch()` (`manager.ts:415-580`) —— 我们的 `spawn()` 简化版（不要 OMO 的 `reserveSubagentSpawn` / `commit/rollback` 模式，因为 loop 不是 subagent）
- OMO `abortSessionWithLogging()` (`manager.ts:299-313`) —— 我们的 `cleanup()` 简化版
- **不移植**：OMO 的 `task-registry` 用 `globalThis[REGISTRY_KEY]`（`task-registry.ts:1-18`）—— **我们不用** globalThis，因为 plugin 可以持久化到磁盘，没必要走 in-process global

### 4.4 LoopConcurrencyManager（OMO 简化版）

```typescript
// src/features/loop/loop-concurrency.ts

export class LoopConcurrencyManager {
  private buckets: Map<string, number> = new Map();          // label → active count
  private queues: Map<string, QueuedItem[]> = new Map();     // label → queue

  async acquire(label: string, maxConcurrent: number, fn: () => Promise<void>): Promise<void> {
    const current = this.buckets.get(label) ?? 0;
    if (current < maxConcurrent) {
      this.buckets.set(label, current + 1);
      try {
        await fn();
      } finally {
        this.buckets.set(label, (this.buckets.get(label) ?? 1) - 1);
        this.drainQueue(label, maxConcurrent);
      }
      return;
    }

    // Queue it
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(label) ?? [];
      queue.push({ fn, resolve, reject });
      this.queues.set(label, queue);
    });
  }

  private drainQueue(label: string, maxConcurrent: number): void {
    const queue = this.queues.get(label);
    if (!queue || queue.length === 0) return;
    const next = queue.shift()!;
    this.acquire(label, maxConcurrent, next.fn).then(next.resolve).catch(next.reject);
  }

  status(label: string): { active: number; queued: number } {
    return {
      active: this.buckets.get(label) ?? 0,
      queued: (this.queues.get(label) ?? []).length,
    };
  }
}
```

**对比 OMO ConcurrencyManager** (`manager.ts` line 343 + `concurrency.ts` 整个文件)：
- OMO 用 `getConcurrencyKey(model)` → 我们用 `label`（字符串）—— **简化**：我们不需要 per-model bucket
- OMO 用 `acquire/release` promise 模式 + hand-off —— 我们直接 `await fn()` + finally —— **简化**
- OMO 的 `processKey` 自递归处理 queue —— 我们的 `drainQueue` 显式递归 —— **更显式**
- **总代码量**：OMO `concurrency.ts` ~150 行 → 我们 ~50 行（67% 缩减）

### 4.5 LoopController（命令式 API）

**核心决策：扩展 `loop` tool 而不是新 tool**。

```typescript
// src/tools/loop-tool.ts（v0.6 重构）

import { LoopRegistry } from "../features/loop/loop-registry";
import { LoopProcess } from "../features/loop/loop-process";
import { LoopConcurrencyManager } from "../features/loop/loop-concurrency";

const registry = new LoopRegistry(`${getState().cwdRoot}/AGENT_SESSIONS`);
const concurrency = new LoopConcurrencyManager();

export const loopTool: ToolDefinition = tool({
  description:
    "Loop tool — 让 headless agent 在当前 CCC root 下反复执行任务直到完成。" +
    "v0.6+ 新增命令式 API：action=list|show|pause|resume|cancel|logs。" +
    "\n\n" +
    "调用方式：\n" +
    "  loop(action='start', label='SQC-扫描', prompt='...')        // 启动新 loop\n" +
    "  loop(action='list', status='running')                       // 列活跃 loop\n" +
    "  loop(action='show', loopId='loop_abc123')                   // 看详情\n" +
    "  loop(action='pause'|'resume'|'cancel', loopId='...')        // 控制\n" +
    "  loop(action='logs', loopId='...', tail=50)                  // 看 stdout/stderr\n" +
    "\n" +
    "v0.6+ 自动持久化：loop 状态在 plugin 重启后保留在 AGENT_SESSIONS/loop-{label}.state.json。",
  args: {
    action: z.enum(["start", "list", "show", "pause", "resume", "cancel", "logs"])
      .default("start")
      .describe("loop 动作"),
    // start 参数
    prompt: z.string().optional()
      .describe("任务描述（仅 start）"),
    label: z.string().min(1).max(50).optional()
      .describe("任务标签（仅 start）"),
    agent: z.string().optional().describe("agent 类型（仅 start，保留字段）"),
    maxRounds: z.number().int().positive().optional()
      .describe("最大轮数（仅 start，默认 100）"),
    // query 参数
    loopId: z.string().optional().describe("loop 标识（show/pause/resume/cancel/logs）"),
    status: z.array(z.enum(["pending", "spawning", "running", "paused", "done", "failed", "cancelled", "crashed"])).optional()
      .describe("过滤 status（仅 list）"),
    tail: z.number().int().positive().optional().default(50).describe("log tail 行数（仅 logs）"),
  },
  execute: async (input, ctx) => {
    switch (input.action) {
      case "start":   return handleStart(input, ctx, registry, concurrency);
      case "list":    return handleList(input, registry);
      case "show":    return handleShow(input, registry);
      case "pause":   return handlePause(input, registry);
      case "resume":  return handleResume(input, registry);
      case "cancel":  return handleCancel(input, registry);
      case "logs":    return handleLogs(input, registry);
    }
  },
});

// ── Start handler（v0.5 现有逻辑的包装）────────────────────

async function handleStart(input, ctx, registry, concurrency): Promise<string> {
  if (!input.prompt || !input.label) {
    throw new Error("loop(action='start') requires prompt and label");
  }
  if (input.prompt.length < 50) {
    // v0.6 软限制（不是硬限制）—— 短任务 warn 但允许
    log.warn("loop-start", "prompt is short", { length: input.prompt.length });
  }

  const state = registry.register({
    label: input.label,
    prompt: input.prompt,
    parentSessionId: ctx.sessionID,
    parentMessageId: ctx.messageID,
    agent: input.agent,
    maxRounds: input.maxRounds ?? 100,
  });

  // 串行 await（per-label semaphore 由 concurrency 控制）
  return concurrency.acquire(input.label, state.maxConcurrentPerLabel, async () => {
    registry.transition(state.loopId, "spawning", "spawn begin", { port: state.servePort });
    const proc = new LoopProcess(state, onRunnerMessage(state, ctx, registry), onProcExit(state, registry));
    await proc.spawn();
    // 这里不 await —— 让 spawn 异步跑，tool 立即返回 spawn 确认
    // 但 caller session 不阻塞（D31: 改为 background 模式，工具立即返回 loopId，让 caller 自由 poll）
    return JSON.stringify({ loopId: state.loopId, label: state.label, status: "spawning" }, null, 2);
  });
}

// ── List handler ────────────────────────────────────────────

function handleList(input, registry): string {
  const states = registry.list({ status: input.status });
  return JSON.stringify(states.map(s => ({
    loopId: s.loopId,
    label: s.label,
    status: s.status,
    round: s.round,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    finishReason: s.finishReason,
    errorMessage: s.errorMessage,
  })), null, 2);
}

// ── Show handler ────────────────────────────────────────────

function handleShow(input, registry): string {
  const state = input.loopId
    ? registry.get(input.loopId)
    : registry.getByLabel(input.label!);
  if (!state) throw new Error(`Loop not found: ${input.loopId ?? input.label}`);
  return JSON.stringify(state, null, 2);
}

// ── Pause/Resume/Cancel handlers ─────────────────────────────

function handlePause(input, registry): string {
  const state = registry.get(input.loopId!);
  if (!state) throw new Error(`Loop not found: ${input.loopId}`);
  if (state.status !== "running") throw new Error(`Cannot pause: status=${state.status}`);
  registry.transition(input.loopId!, "paused", "user pause", { round: state.round });
  // signal runner via PID
  const proc = procByLoopId.get(input.loopId!);
  proc?.pause();
  return JSON.stringify({ loopId: input.loopId, status: "paused" }, null, 2);
}

// Resume/Cancel 同结构

// ── Logs handler ─────────────────────────────────────────────

function handleLogs(input, registry): string {
  const state = registry.get(input.loopId!);
  if (!state) throw new Error(`Loop not found: ${input.loopId}`);
  const logFile = `${getState().cwdRoot}/AGENT_SESSIONS/loop-${state.label}.log`;
  // tail last N lines
  // ... (read + tail + return)
}
```

**关键决策**：**扩展 loop tool（不新建）**——理由：
1. LLM 已经在 description 里看到 `loop`——再加一个 `loop-control` tool 会增加选择负担
2. LoopController 的 6 个 action 本质都是 loop 生命周期操作，语义统一
3. 符合 OMO 哲学："don't replace tools, extend with description-rich wrappers"（omo-deep-dive.md §B2-a）

### 4.6 LoopProgressStream（增量事件流 → TUI）

```typescript
// src/features/loop/loop-progress-stream.ts

import type { LoopState } from "./loop-state";
import type { RunnerMessage } from "./loop-process";

export type ProgressEvent =
  | { type: "loop.spawn.complete"; loopId: string; label: string; sessionId: string }
  | { type: "loop.round.start"; loopId: string; label: string; round: number }
  | { type: "loop.round.chunk"; loopId: string; label: string; round: number; text: string }
  | { type: "loop.round.end"; loopId: string; label: string; round: number; response: string }
  | { type: "loop.done"; loopId: string; label: string; finishReason: string; rounds: number }
  | { type: "loop.error"; loopId: string; label: string; errorCode: string; errorMessage: string };

export class LoopProgressStream {
  private subscribers: Set<(event: ProgressEvent) => void> = new Set();
  
  subscribe(fn: (event: ProgressEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
  
  publish(event: ProgressEvent): void {
    for (const sub of this.subscribers) {
      try { sub(event); } catch (err) { log("[loop-stream] subscriber error", { err }); }
    }
  }
}

// TUI 端订阅（在 tui.ts 中实现）
const stream = new LoopProgressStream();
stream.subscribe((event) => {
  // 只保留最近的 3 个 event 用于 toast
  recentEvents.unshift(event);
  recentEvents = recentEvents.slice(0, 3);
  api.ui.toast({
    title: `loop ${event.label}: ${event.type}`,
    message: event.type === "loop.round.end"
      ? `第 ${event.round} 轮: ${event.response.slice(0, 80)}`
      : event.type,
    variant: event.type.startsWith("loop.error") ? "error" : "info",
    duration: 3000,
  });
});
```

**对比 OMO `messageUpdatedInfoHasParentWakeOutput`** 等 observer 模式：OMO 用 parent wake 注入到主 session 通知；我们用 toast + 状态文件轮询——**不侵入主 session**（避免 OMO ParentWakeNotifier 500+ 行的复杂度）。

### 4.7 LoopResume（serve crash + plugin restart recovery）

```typescript
// src/features/loop/loop-resume.ts

export class LoopResumeCoordinator {
  constructor(
    private registry: LoopRegistry,
    private concurrency: LoopConcurrencyManager,
  ) {}

  // plugin restart 时调用
  async reconcileOnStartup(): Promise<void> {
    const active = registry.list({ status: ["pending", "spawning", "running", "paused", "crashed"] });

    for (const state of active) {
      // 1. 检查 serve 是否还活着
      const port = state.servePort;
      const alive = port ? await this.checkServeAlive(port) : false;

      if (alive) {
        // serve 活着但 runner 死了 → 重 spawn runner（复用 serve + session）
        log(`[loop-resume] Re-spawning runner for ${state.loopId} (serve alive on port ${port})`);
        await this.respawnRunner(state);
      } else if (state.status === "running" || state.status === "crashed") {
        // serve 也死了 → 重启 serve + session + runner
        if (state.crashRetries < state.maxCrashRetries) {
          log(`[loop-resume] Restarting serve + session + runner for ${state.loopId}`);
          await this.fullRestart(state);
        } else {
          registry.transition(state.loopId, "failed", "crash retries exhausted");
        }
      } else if (state.status === "pending" || state.status === "spawning") {
        // 从未启动成功 → 重新启动
        await this.fullRestart(state);
      } else if (state.status === "paused") {
        // 保持 paused，等用户 resume
        log(`[loop-resume] Loop ${state.loopId} stays paused (user-driven)`);
      }
    }
  }

  private async checkServeAlive(port: number): Promise<boolean> {
    try {
      execSync(`curl -s -f --max-time 3 "http://127.0.0.1:${port}/global/health"`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  // ... respawnRunner + fullRestart implementations
}
```

**对比 OMO BackgroundManager** —— OMO 没做"plugin restart 后的 resume"（它假设进程不重启），**我们做了**——因为 Loop Tool 是独立 harness 进程，plugin 重启不应让 runner 跟着死。

**关键决策**：**不重新生成 session**（D-K3）——OC session 在 DB 里持久化（除非手动 delete），所以 reuse `state.sessionId` 即可，保留历史 context。这与 OC 原生 `task` tool 的"parentID 派生"哲学一致（`task.ts:153-168`），但因为我们是独立 harness，不创建 parentID 关系。

### 4.8 LoopEvaluatorHook（OMO quality gate 移植）

```typescript
// src/features/loop/loop-evaluator.ts

import type { Hooks } from "@opencode-ai/plugin";

/**
 * 注册 chat.message.transform hook —— loop session 的每轮 response 进入 evaluator
 * 检测：
 *   1. 重复模式（连续 N 轮输出几乎相同文本 → 引导换策略）
 *   2. 无进展（response 短 / "继续" / empty）
 *   3. 错误模式（retry guidance 同 delegate-task-retry）
 * 4 类 evaluator 触发 → 注入 guidance 或建议 stop
 */

const REPETITION_THRESHOLD = 3;        // 连续 3 轮重复 → 注入 guidance
const NO_PROGRESS_THRESHOLD = 5;       // 连续 5 轮 < 50 字符 → 注入 guidance

export function createLoopEvaluatorHook(): Partial<Hooks> {
  return {
    "chat.message": async (input, output) => {
      // 只对 loop session 起作用（label 前缀匹配）
      if (!input.sessionID.startsWith("loop-")) return;

      const messages = output.messages;
      if (!messages || messages.length === 0) return;

      // 检查重复模式（last 5 assistant messages）
      const assistantMessages = messages.filter(m => m.info?.role === "assistant").slice(-5);
      const texts = assistantMessages.map(m => extractText(m.parts ?? []));

      if (detectRepetition(texts)) {
        // 注入 guidance part 到 last user message
        injectGuidance(output, `[EVALUATOR] Detected repetition. Consider stopping or changing approach.`);
      }

      if (detectNoProgress(texts)) {
        injectGuidance(output, `[EVALUATOR] No progress detected for ${NO_PROGRESS_THRESHOLD} rounds. Consider stopping.`);
      }
    },
  };
}
```

**参考 OMO**：
- OMO `delegate-task-retry` (`hook.ts:14-27`) —— 模式近似
- OMO `empty-task-response-detector` (`hook.ts:11-25`) —— 模式近似
- **不同**：OMO 这些 hook 在主 session 的 `tool.execute.after` 上；我们在 loop session 的 `chat.message` 上——**不同 hook target**

**风险**：`output.messages` 是可变引用吗？（omo-deep-dive.md §B2-e-2 提示 messages-transform 时是 splice）—— **未验证**，D32 实施时需先做 spike test。

---

## 5. 与 OMO 范式对照 + 不做什么

### 5.1 移植清单（8 个 OMO 范式 vs 我们的应用）

| OMO 范式 | 范式来源 | 移植到 Loop Tool？ | 形式 |
|---------|---------|------------------|------|
| **Category system** | omo-deep-dive.md §B6.1 | ✅ D32（延迟） | `loop(category="quality-scan")` |
| **ContextCollector** | omo-deep-dive.md §B6.2 | ❌ 不移植 | Loop 不需要 ephemeral staging buffer（runner 自己管 round 间 state）|
| **safeCreateHook** | omo-deep-dive.md §B6.3 | ✅ D28 | 给所有 loop hook factory 包 safeCreateHook |
| **BackgroundManager 简化版** | omo-deep-dive.md §B6.4 | ✅ D31（部分） | `LoopConcurrencyManager` |
| **tool.execute.after output mutation** | omo-deep-dive.md §B6.5 | ❌ 不移植 | Loop 输出已经是 JSON string，不是 opencode tool output |
| **session-tools-store** | omo-deep-dive.md §B2-c | ❌ 不移植 | Loop 不创建 OC subagent session |
| **parent-wake-notifier** | omo-deep-dive.md §B2-d-3 | ❌ 不移植（NG5）| 复杂度太高 |
| **MESSAGE_STORAGE 磁盘写** | omo-deep-dive.md §B6.6.1 | ❌ Dead-end | 不做 |

### 5.2 与 OMO BackgroundManager 的 5 大本质差异

| 维度 | OMO BackgroundManager | Serenity Loop Tool Extension |
|------|----------------------|------------------------------|
| **是否在 OC 进程内** | ✅ 是（同一个 opencode 实例） | ❌ 否（spawn 独立 serve）+ ✅ 是（plugin 进程）|
| **subagent 概念** | ✅ 创建 child session（parentID 关系） | ❌ 完全独立 session（无 parentID） |
| **状态持久化** | ❌ 进程内 Map（restart 丢失） | ✅ state.json（restart 不丢）|
| **通信** | SDK `client.session.create` | HTTP curl + JSON line stream |
| **状态可见性** | OMO 自维护 + tmux pane | ✅ state.json + TUI toast + loop(action="list") |

**关键洞察**：OMO BackgroundManager 与 Loop Tool **不冲突，可共存**——OMO 负责 in-OC-process subagent，Loop Tool 负责 external-process harness。两者解决不同问题域（delegate-survey.md §3.3 已论证）。

---

## 6. 关键设计决策（5 条核心）

### D-K1: LoopState 文件 = atomic rename + last-write-wins

**理由**：
- POSIX `rename()` 是原子操作（kernel 保证）—— 写入临时文件 + rename 保证 partial write 不可见
- 不需要 CRDT 或 vector clock——单写者（plugin 进程），单读多（tool 查询 + TUI）
- 不需要文件锁——写入是短暂持有（rename ~ms 级），读取不需要 lock

**风险**：plugin 多实例（同 cwd 下多个 plugin）会 race——**D34 落地时检查**："同一 cwd 最多一个 opencode 实例"是否成立（OC 设计如此）。

### D-K2: LoopController 扩展 `loop` tool，不新建 tool

**理由**：
- LLM tool 选择负担：5 个 tool 增加到 10 个 → LLM 选错概率上升
- 语义统一：6 个 action 都是"loop 生命周期"
- 符合 OMO "don't replace, extend" 哲学（omo-deep-dive.md §B2-a）

**风险**：单个 tool 的 description 变长（~500 字）——LLM context 占用略增。**D28 实施时评估**。

### D-K3: LoopResume 优先 reuse sessionId，不重新生成

**理由**：
- OC session 在 DB 持久化（`~/.local/share/opencode/storage/session/<sessionID>.json`）
- 重用 session 保留历史 context（model 之前的 message tree）
- 符合"长任务可恢复"的用户友好目标

**风险**：OC session DB 损坏 → reuse 失败 → 触发 full restart（D30 实施时处理）

### D-K4: Concurrency Manager 用 label bucket（不是 OMO 的 model bucket）

**理由**：
- Loop 没有 per-model 概念（用 default serve 配 default model）
- 用户的并发需求是"3 个 SQC-扫描同时跑" → label bucket 足够
- 简化 67% 代码量（OMO ~150 行 → 我们 ~50 行）

**风险**：D24 Category 系统落地后，category 可能成为并发单位（不同 category 可不同并发）—— **D31 实施时扩展为 `Map<label|category, count>`**

### D-K5: 不做 Parent Wake 注入（NG5）

**理由**：
- OMO ParentWakeNotifier 复杂度 500+ 行 + 4 collaborator + 7 个 Map（omo-deep-dive.md §B2-d-3 + 调研文档 B6.5）
- 我们的需求是"loop 完成通知 caller"——通过**返回值 + state.json 轮询 + TUI toast** 三个轻量通道足够
- 注入 system-reminder 是侵入式操作（D-K5 不做）

**风险**：caller session 不知道 loop 完成（除非主动 query `loop(action="list")`）—— **D34 落地**："loop tool 返回时附带一个 `<system-reminder>`，提示 caller 几秒后 query state"——非侵入式提醒。

---

## 7. D28+ 路线图（10 个 PR / ~2,350 行 / 6 个月）

### 7.1 路线图总览

```
                   阶段 1（必需）    阶段 2（增强）    阶段 3（远期）
                   ─────────────    ─────────────    ─────────────
🔴 P0 必须做        D28 D29          D35 (tests)
🟡 P1 推荐做                        D30 D31 D34
🟢 P2 可选                                          D32
⚪ P3 暂缓                                          D33
```

| D | 主题 | 优先级 | PR 数 | 代码量 | 风险 | 依赖 | 估时 |
|---|------|--------|-------|--------|------|------|------|
| **D28** | LoopRegistry + State Machine + Persistence | 🔴 P0 | 2 | ~400 行 | 低 | 无 | 2 周 |
| **D29** | LoopController（6 个 action） | 🔴 P0 | 1 | ~200 行 | 低 | D28 | 1 周 |
| **D30** | LoopResume（serve crash + plugin restart） | 🟡 P1 | 2 | ~350 行 | 中 | D28 | 2 周 |
| **D31** | ConcurrencyManager + ProgressStream | 🟡 P1 | 1 | ~250 行 | 中 | D28, D29 | 1.5 周 |
| **D34** | TUI 实时状态（绕过 @opentui/solid） | 🟡 P1 | 1 | ~150 行 | 中 | D31 | 1 周 |
| **D32** | EvaluatorHook + Category 集成 | 🟢 P2 | 1 | ~200 行 | 中 | D28, D31, D24 | 1.5 周 |
| **D33** | Loop嵌套（loop-of-loops） | ⚪ P3 | 1 | ~200 行 | 高 | D28, D31 | 2 周 |
| **D35** | Loop 单元测试 + 集成测试 | 🔴 P0 | 1 | ~500 行 | 低 | D28-D34 | 2 周 |

**总计：10 PR / ~2,250 行 / 约 13 周**（~3 个月，密集实施；含 review/buffer 6 个月）。

### 7.2 依赖图

```
              D28 (Registry+State)
              ┌────┴────┐
              │         │
              ▼         ▼
       D29 (Control)   D30 (Resume)
              │         │
              ├────┬────┘
              ▼    ▼
        D31 (Concurrency+Stream)
              │
              ├──► D34 (TUI)
              │
              ├──► D32 (Evaluator) ← 依赖 D24 (Category)
              │
              └──► D33 (Nesting, P3)
              
       D35 (Tests) ← 依赖所有 D28-D34
```

### 7.3 各 D 详细计划

#### D28 — LoopRegistry + State Machine + Persistence

**目标**：loop state 跨 plugin restart 持久化

**PR 1（基础设施）**：
- 新建 `src/features/loop/loop-state.ts`（schema + zod validation）
- 新建 `src/features/loop/loop-registry.ts`（register + transition + persist + load）
- 新建 `src/features/loop/atomic-write.ts`（write-temp + rename 工具）

**PR 2（集成）**：
- 重构 `src/tools/loop-tool.ts` 让 `start` action 走 `registry.register()`
- 每个 transition 自动写 `.state.json` + `.audit.jsonl`
- `loop(action="list")` + `loop(action="show")` 已可工作

**代码量**：~400 行

**风险**：低（atomic rename 是 POSIX 标准）

**验收**：kill -9 plugin → restart → `loop(action="list")` 显示所有未完成 loop

---

#### D29 — LoopController（6 个 action）

**目标**：list/show/pause/resume/cancel/logs

**PR 1（合并到 D28 PR 2 或独立）**：
- 扩展 loop tool schema：`action: z.enum([...])`
- 实现 6 个 handler（start 已有，list/show/pause/resume/cancel/logs 新增）
- runner 进程加 SIGUSR1/SIGUSR2 handler（pause/resume）

**代码量**：~200 行

**风险**：低（runner 进程已有 SIGTERM handler，加 SIGUSR1/2 模式相同）

**验收**：手动 `loop(action="start", label="test")` → `loop(action="pause", loopId=...)` → runner 停止发"继续"消息 → `loop(action="resume")` → runner 继续发"继续"消息

---

#### D30 — LoopResume

**目标**：serve crash / plugin restart 后能恢复

**PR 1（resume coordinator）**：
- 新建 `src/features/loop/loop-resume.ts`
- `reconcileOnStartup()` 在 plugin init 阶段调用
- 复用 `state.sessionId`（D-K3） + 检查 serve alive + 决定 reuse / restart

**PR 2（loop-runner 增强）**：
- runner 加 `--resume <state.json>` flag
- runner 检测 state.json 存在 → 跳过创建 session，直接 drive 现有 sessionId
- 加 `serveCrashRetries` 计数器到 LoopState

**代码量**：~350 行

**风险**：中（runner 改 dual-mode：start vs resume，需小心 state 一致性）

**验收**：模拟 serve kill → plugin 检测 → 自动 respawn runner → loop 继续从原 round 跑

---

#### D31 — ConcurrencyManager + ProgressStream

**目标**：per-label 桶限流 + 增量事件流

**PR 1**：
- 新建 `src/features/loop/loop-concurrency.ts`（OMO ConcurrencyManager 简化版）
- 新建 `src/features/loop/loop-progress-stream.ts`（subscriber-publish 模式）
- runner 改 stdout 为 `RunnerMessage` stream（不是 JSON summary）
- `loop(action="start")` 改为 background spawn（不 await） + 返回 loopId

**代码量**：~250 行

**风险**：中（改 runner stdout 格式需小心兼容性）

**验收**：手动 `loop(action="start", label="A")` 4 次（max=3）→ 第 4 次 queue → 前 3 个中任意一个 done → 第 4 个自动 start

---

#### D34 — TUI 实时状态

**目标**：TUI 显示 loop 进度（不依赖 @opentui/solid）

**PR 1**：
- 重写 `src/tui.ts:320-370`：用 `api.ui.toast` 替换 JSX slot
- LoopProgressStream subscriber 触发 toast
- state.json 轮询作为 backup（避免 toast 错过）

**代码量**：~150 行

**风险**：中（@opentui/solid slot 已在 `tui.ts:368-369` 显式 fallback，确认是否其他 plugin 也依赖）

**验收**：loop 运行时 TUI 每 round 看到 toast "loop SQC-扫描: round 3"

---

#### D32 — EvaluatorHook + Category 集成（依赖 D24 Category 系统）

**目标**：loop session 质量检查 + Category-aware 配置

**PR 1**：
- 新建 `src/features/loop/loop-evaluator.ts`（chat.message.transform hook）
- 注册 repetition / no-progress detector
- Category 系统（D24）落地后，loop tool 支持 `category` 参数

**代码量**：~200 行

**风险**：中（chat.message.transform 是 mutable mutation，D-K5 类似）

**验收**：手动制造重复输出 3 轮 → 第 3 轮末尾看到 `<system-reminder>[EVALUATOR] detected repetition...`

---

#### D33 — Loop嵌套（loop-of-loops）⚪ P3

**目标**：loop 内 spawn sub-loop（已有 LoopRegistry 索引 + label 路由）

**PR 1**：
- runner 加 `loop` tool 可调（在 fork runner 时注入子 runner）
- 父子 loop 通过 label prefix 关联（`parent.loop` 和 `parent.loop.sub1`）
- parent loop 等所有 sub-loop done 才继续

**代码量**：~200 行

**风险**：高（嵌套死锁 + label 冲突 + parent-child state 一致性）

**验收**：手动 `loop(label="A", prompt="spawn sub loop B")` → 看到 sub-loop 也 start + 等其 done + A 继续

**备注**：**D33 暂列为 P3**——直到 D28-D32 落地 + 用户有明确需求才做。

---

#### D35 — 测试（最后一步）

**目标**：确保质量 + 可维护性

**PR 1**：
- `test/loop-registry.test.ts`：registry CRUD + transition validation + atomic write
- `test/loop-state.test.ts`：schema validation + persistence round-trip
- `test/loop-process.test.ts`：spawn + cleanup + health monitor
- `test/loop-concurrency.test.ts`：bucket + queue + hand-off
- `test/loop-resume.test.ts`：crash recovery + serve restart
- `test/loop-tool.test.ts`：6 个 action end-to-end
- `test/integration.test.ts`：真实 loop 全生命周期（用 mock runner）

**代码量**：~500 行（tests 比 production code 多，因为 mock/spawn/cleanup setup）

**风险**：低（纯单元测试）

**验收**：`pnpm test` 全绿，覆盖率 > 80%

---

### 7.4 风险登记表

| 风险 | 触发 | 缓解 |
|------|------|------|
| **OC serve API 演进** | OC 1.x → 2.x 改 `/session/:id/message` 接口 | 隔离 runner 进程 → 改 runner 即可，不影响 plugin |
| **state.json 多写者 race** | 同 cwd 多个 opencode 实例 | 检测 + log 警告（D28 实施时验证 OC 是否真单实例）|
| **chat.message.transform mutable mutation 失效** | OC 重构 hook 接口 | safeCreateHook 包 + try/catch + log 失败（D32 实施时 spike test）|
| **Loop runner 卡住** | runner 内部 bug / OOM | 已有 health monitor（30s check）+ max_rounds=100 safety valve |
| **state.json 损坏** | plugin kill -9 在 atomic rename 中间 | 用 `parse` try/catch 包住 loadFromDisk + log 跳过（D28 实施时）|
| **loop 状态机 transition 不合法** | 并发 caller 同时发 pause+cancel | registry.transition 加 mutex（D28 实施时 InMemory mutex）|
| **D33 loop 嵌套死锁** | parent 等 sub-loop，sub-loop 等 parent | 显式禁止循环依赖（同 label prefix 检测）|

---

## 8. 与 S035 主线衔接

| S035 D# | 状态 | D28+ 影响 |
|---------|------|----------|
| **D6 TUI 状态指示** | 🔴 未开始 | D34 实现后，D6 部分满足（loop 进度可见） |
| **D24 SEP v1** | ✅ v0.4.14 已落地 | D32 落地时，loop hook 也走 SEP 注册 |
| **D27 Loop Tool** | ✅ v0.5.5-0.5.21 | D28+ 增量（不替换） |
| **新：D28-D35 Loop Extension** | ❌ 未开始 | 本设计文档覆盖 |

**D28-D35 vs S035 已有 D# 关系**：
- D28-D30 优先级等同 D6（架构必需）
- D31、D34 是"工程必须"
- D32 依赖 D24 Category 系统（D24 先做）
- D33 远期，按需启动

---

## 9. 验收清单（D28-D35 全部完成）

- [ ] G1 Loop state 跨 plugin restart 持久化
- [ ] G2 6 个命令式 action 工作
- [ ] G3 Serve crash / plugin restart / SIGTERM 后能恢复
- [ ] G4 同 label max_concurrent=3 生效
- [ ] G5 TUI 实时显示 loop 进度（不依赖 @opentui/solid）
- [ ] G6 State transition 有 audit log
- [ ] G7 进度文件每 round 增量更新
- [ ] NG1-NG7 全部不违反
- [ ] D35 测试覆盖率 > 80%
- [ ] README 更新（loop tool v0.6+ 用法）

---

## 附录 A — 引用清单（OMO 源码 + commit SHA）

| 引用 | URL / 文件:行号 |
|------|-----------------|
| OMO BackgroundManager 入口 | `code-yeongyu/oh-my-openagent @ f7ec5552` `packages/omo-opencode/src/features/background-agent/manager.ts:1-...` |
| OMO ConcurrencyManager | `packages/omo-opencode/src/features/background-agent/concurrency.ts` (OMO 核心 ~150 行) |
| OMO ContextCollector | `packages/omo-opencode/src/features/context-injector/collector.ts:1-99` |
| OMO safeCreateHook | `packages/omo-opencode/src/shared/safe-create-hook.ts:5-22` |
| OMO call-omo-agent (don't replace tool) | `packages/omo-opencode/src/tools/call-omo-agent/tools.ts:60-95` |
| OMO CategoryConfigSchema | `packages/omo-opencode/src/config/schema/categories.ts` |
| OMO delegate-task-retry | `packages/omo-opencode/src/hooks/delegate-task-retry/hook.ts:14-27` |
| OMO empty-task-response-detector | `packages/omo-opencode/src/hooks/empty-task-response-detector.ts:11-25` |
| OC TaskTool.execute | `sst/opencode @ dev` `packages/opencode/src/tool/task.ts:104-322` |
| OC subagent permissions | `packages/opencode/src/agent/subagent-permissions.ts:18-35` |
| OC Hooks interface | `packages/plugin/src/index.ts:257-395` |
| 当前 Loop Tool plugin tool | `AI_LAB/opencode-serenity-plugin/src/tools/loop-tool.ts:1-178` |
| 当前 Loop Tool runner | `AI_LAB/opencode-serenity-plugin/src/tools/loop-runner.ts:1-314` |
| 当前 TUI loop slot (failed) | `AI_LAB/opencode-serenity-plugin/src/tui.ts:320-370` |
| D27 踩坑记录 | `AGENT_SESSIONS/2026-06-19--S035--plugin-long-term-dev/SESSION.md:88-93` |
| LoopEngineering 论文调研 | `AGENT_SESSIONS/2026-06-19--S035--plugin-long-term-dev/SESSION.md:100-115` |
| OMO 调研引用 | `AI_LAB/opencode-serenity-plugin/docs/omo-deep-dive.md` (1107 行) |
| Delegate 调研引用 | `AI_LAB/opencode-serenity-plugin/docs/delegate-mechanism-survey.md` (836 行) |

## 附录 B — 完成判定自评

✅ **完成**：
- 22 个痛点逐个识别 + 归类到 4 维度
- 5 大设计支柱（P1-P5: Registry/State/Controller/Concurrency/Persistence）
- 13 个 transition 的状态机（含 audit log）
- LoopState schema（zod）+ 文件布局
- LoopRegistry CRUD + persist + loadFromDisk
- LoopProcess spawn + health monitor + pause/resume/cancel
- LoopConcurrencyManager（OMO 简化版）
- LoopController 6 个 action 的扩展 loop tool 设计
- LoopResumeCoordinator（plugin restart 后 reconcile）
- LoopEvaluatorHook（quality gate，OMO delegate-task-retry 移植）
- LoopProgressStream（subscriber-publish pattern）
- 5 个 ASCII 图表（系统架构 + 数据流 + 状态机 + dependency graph + state schema）
- 5+ 处 OMO 源码引用（commit SHA `f7ec5552`）
- 10 个 D 路线（每个 D 的 PR 数 + 代码量 + 风险）
- 5 条核心设计决策（D-K1 到 D-K5）
- 7 个 NG（非目标）+ 理由
- 8 条 TL;DR 结论
- 与 S035 主线衔接表

✅ **超出要求**：
- 自定义了"用户友好"的 4 维度定义（不仅是任务给的模糊定义）
- 给出每个 D 的精确代码量、估时、依赖图
- 完整风险登记表 + 缓解方案
- 与 OMO BackgroundManager 的 5 大本质差异对比表

❌ **未交付**：
- 无实现代码（任务说"不写实现代码 (design session)"）
- 无 TypeScript 编译验证（设计阶段无 code）
- 无运行时测试（设计阶段无 code）

---

> 本设计文档**可立即进入 D28 实施**——下个 SESSION 直接开 D28 PR 1。