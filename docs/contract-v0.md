# Plugin API Contract v0 — 接口/契约层

> **会话**：2026-06-04--opencode-serenity-plugin
> **承接**：`docs/architecture-v0.md`（方案层）
> **范围**：v0 plugin 暴露给 opencode runtime + LLM 的**全部接口契约**。
> **不含**：实现代码（`src/`）。

---

## 1. 契约清单

| # | 契约 | 暴露给 | 类型 |
|---|------|--------|------|
| C1 | plugin 入口默认 export | opencode loader | `async (api) => PluginReturn` |
| C2 | `msm_list` tool | LLM | tool registration |
| C3 | `msm_exec` tool | LLM | tool registration |
| C4 | 同名 `bash` tool 覆盖 | LLM | tool registration (throws) |
| C5 | `/serenity-init` slash command | LLM | command registration |
| C6 | `permission.asked` event hook | opencode runtime | event subscription |

---

## C1 — Plugin 入口

```typescript
// src/index.ts
import type { Plugin, Hooks } from '@opencode-ai/plugin';

const plugin: Plugin = async (input) => {
  // ... 2 阶段启动协议
  // Phase 1: tryActivateSync（RR6 git 验证，同步）
  // Phase 2: activateAsync（RR1+RR2，fire-and-forget 后台）
  return hooks;  // Hooks
};

export default {
  id: 'opencode-serenity-plugin-server',
  server: plugin,
};
```

**契约**：
- 必须**默认 export 一个对象** `{ id, server }`（opencode 1.16+ SDK 加载协议）
- `server` 是 async `(input) => Promise<Hooks>` 形式
- 不抛错（抛错会中断 opencode 启动；不激活时返回 `{}` hooks）
- 同仓另存 TUI entry `src/tui.ts`，默认 export `{ id, tui }`（详见 C5 注释）

---

## C2 — `msm_list` Tool

### 注册

```typescript
import { tool, type ToolDefinition } from '@opencode-ai/plugin';

export const msmListTool: ToolDefinition = tool({
  description: '...',  // LLM 可见的 description
  args: {},  // 无参数（zod schema）
  execute: async () => { /* 返回 msm 列表 */ },
});
```

### 描述文本（LLM 可见）

```
[PRIMARY] List all available MSM (Mech & Semi-Mech) tools in the current serenity
instance. **This is the FIRST tool to call for any shell/exec operation** —
bash, read (path arguments), and most plugin tools are intentionally limited.
Each MSM is a deterministic, audited operation registered in mech-registry.json.
Returns one MSM per line: `name | skill | category | description`.
If you need an operation that has no MSM, ask the user to register a new one
before running arbitrary commands.
```

### 入参

无。

### 出参

**字符串**（不是 JSON），每行一个 MSM：

```
ssh-connect | home-serenity | mech | 唯一授权 SSH 工具。凭证统一管理，禁止裸 ssh
resolve-path | home-serenity | mech | 宁静号根路径解析工具
mech-manifest | home-serenity | mech | 全域 MSM 清单查询
...
```

格式严格遵循：`name | skill | category | description`（4 字段，`|` 两边空格分隔）。

空注册表时返回 `"(no MSM registered)"`；plugin 未激活时返回 `"serenity plugin is not active: <reason>"`。

### 错误

- `MsmNotRegisteredError` — 用户调 `msm_exec` 时 name 不在注册表（C3 错误）
- 注册表文件读取失败时降级：返回空列表 + `log.warn`（不抛错）

---

## C3 — `msm_exec` Tool

### 注册

```typescript
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';

export const msmExecTool: ToolDefinition = tool({
  description: '...',  // LLM 可见的 description
  args: {
    msm_name: z.string().describe('MSM 名称（来自 msm_list 输出）'),
    args: z.string().default('').describe('CLI args 字符串'),
  },
  execute: async (input) => { /* ... */ },
});
```

### 描述文本（LLM 可见）

```
[PRIMARY] Execute a registered MSM tool or invoke a protocol meta-command.
ALWAYS call msm_list first to discover the MSM name.
**args is a CLI args string** — protocol flags (S022 RFC §2.2) are
intercepted at the prefix: --format=<text|json>, --log <path>, --help,
--version, --list, --schema.
Examples: args="--format=json /tmp/x" for real exec; args="--list" for
MSM listing; args="--schema ssh-connect" for a MSM schema.
**args in real-exec mode**: rest of the string after protocol flags =
business args, passed verbatim to the MSM. 30s timeout.
**Direct bash is disabled by serenity policy (RR3)** — msm_exec is the
only path for shell work.
```

### 入参

```typescript
interface MsmExecInput {
  msm_name: string;       // 必填，从 msm_list 获取
  args: string;           // CLI args 字符串（不解析 JSON），默认空串
}
```

**args 解析规则**（v1.16+）：
- `args` 是**不透明 CLI 字符串**，plugin 不解析 JSON；msm-exec.ts 协议层按 POSIX 风格 tokenize
- 协议 flag（前缀段，6 必含 flag）由 plugin 拦截：
  - `--format=text|json` — 输出格式
  - `--log <path>` — JSON Lines 日志
  - `--help [name]` — 显示帮助
  - `--version` — 显示版本
  - `--list` — 列出 MSMs（meta）
  - `--schema [name]` — 显示 schema（meta）
- 协议 flag 之后为**业务段**（rest），原样透传给业务 MSM

**示例**：
- `args="--format=json --log /tmp/x.log ssh-connect --host ubuntu --exec 'uptime'"` → `--format=json --log /tmp/x.log` 协议；`ssh-connect --host ubuntu --exec 'uptime'` 业务
- `args="--list"` → msm-exec 协议层输出 MSM 清单（meta）
- `args=""` → 调 `msm_name` 指定的 MSM，args 为空

### 出参

**字符串**（不是 JSON 对象），等于子进程 stdout：

```
<msm 子进程 stdout 原文>
```

空 stdout 时返回 `"(no output)"`。

**失败路径**（exit code != 0）：抛 `MsmExecutionError`，错误对象持有 `stdout` / `stderr` / `exitCode` 三个字段。LLM 看到的 message 包含 stdout 摘要（前 1000 字符）+ stderr 摘要（前 500 字符）。

### 错误

| 错误 | 触发条件 | LLM 看到的 message |
|------|---------|------------------|
| `MsmNotRegisteredError` | msm_name 不在注册表 | `MSM "<name>" is not in mech-registry.json; serenity plugin requires registration before use` |
| `MsmTimeoutError` | 执行超过 30s | `MSM "<name>" timed out after 30000ms` |
| `MsmExecutionError` | 子进程返回非 0 exit | `MSM "<name>" failed with exit code <n>\nstdout: <first 1000 chars>\nstderr: <first 500 chars>` |
| `MsmPathEscapeError` | path-arg 解析为 cwdRoot 之外（v0.1-2 守卫）| `MSM "<name>" path-arg "<argName>"="<value>" resolves to "<resolved>" which is outside cwdRoot; serenity plugin blocks path traversal (v0.1-2 pre-indexed guard)` |
| `MsmSymlinkError` | path-arg 指向 symlink（v1-1 守卫）| `MSM "<name>" path-arg "<argName>"="<value>" → "<resolved>": <reason>; serenity plugin blocks symlink attacks (v1-1 symlink guard)` |

---

## C4 — 同名 `bash` Tool 覆盖

### 注册

```typescript
api.registerTool({
  name: 'bash',
  description: '...',
  parameters: z.object({
    command: z.string(),
    description: z.string().optional(),
  }),
  execute: async () => {
    throw new BashDisabledError();
  },
});
```

### 描述文本（LLM 可见）

```
[DISABLED BY SERENITY POLICY] Direct shell execution is disabled in
serenity instances. Use `msm_list` + `msm_exec` to run MSMs, or create
a new MSM if none exists for your task.
```

### 行为

**每次** LLM 调 bash，**总是抛** `BashDisabledError`：

```typescript
class BashDisabledError extends Error {
  constructor() {
    super(
      'Direct bash execution is disabled by serenity policy (RR3). ' +
      'Use msm_exec to run an MSM, or create a new MSM in ' +
      '.opencode/skills/<instance>/scripts/ and register it.'
    );
    this.name = 'BashDisabledError';
  }
}
```

**关键**：bash 抛错 **不 throw 顶层**（即不能让 plugin 整体崩溃）—— `execute` 函数内 throw 是允许的（tool 层抛错），opencode 会把错误消息返回给 LLM。

---

## C5 — `/serenity-init` Slash Command

### 注册

```typescript
api.registerCommand({
  name: 'serenity-init',
  description: 'Initialize the current directory as a serenity instance',
  execute: async (args) => { /* ... */ },
});
```

### 描述文本（LLM 可见）

```
Initialize the current directory as a serenity instance. Creates
`/.serenity` (instance marker) and commits it.

Prerequisites (caller's responsibility):
- The current directory must be a git repo (run `git init` first if not)
- The current directory must NOT already have `/.serenity`

Arguments (all optional):
  --name <name>   Instance name (default: directory name, kebab-case)
  --no-commit     Do not auto-commit /.serenity (default: commit)
```

### 入参

```typescript
interface SerenityInitArgs {
  name?: string;          // --name <name>
  no_commit?: boolean;    // --no-commit
}
```

### 出参（用户可见消息）

```
✓ Initialized serenity instance "home-serenity"
  - Created /.serenity (1 file)
  - Committed: <commit-hash>

Next steps:
  - Add MSMs in .opencode/skills/<instance>/scripts/
  - Register MSMs in .opencode/skills/<instance>/references/mech-registry.json
  - Customize the SKILL.md if needed
```

### 错误

| 错误 | 触发条件 | 用户/CLI 看到 |
|------|---------|--------------|
| `SerenityInitAlreadyError` | `/.serenity` 已存在 | `/.serenity already exists. Remove it first to re-initialize.` |
| `SerenityInitNotGitRepoError` | cwd 不在 git repo | `Not a git repo. Run 'git init' first.` |
| `SerenityInitInvalidNameError` | name 包含非法字符 | `Instance name "X" is invalid. Use kebab-case (e.g. "home-serenity").` |
| `SerenityInitGitCommitError` | commit 失败 | 透传 git 错误 |

---

## C6 — `permission.asked` Event Hook（v1.3-v4 实现）

### 注册

```typescript
import { createPermissionAutoReplyHandler } from './hooks/permission-auto-reply.js';

const event: Partial<Hooks['event']> = createPermissionAutoReplyHandler({
  getServerUrl: () => input.serverUrl,
});
```

### 行为

**无条件 reply "always"**（v1.3-v4 决策）—— 不做 pattern check，不看 event.path。

- `event.permission.asked` 触发 → 调用 `client.postSessionPermissionReply()`，reply `"always"`
- "always" 写入 opencode own `always` list（**单一真相源**）
- 与 RR5 协同：
  - **cwd 内** read/edit/webfetch → opencode own allow 列表 + user "always" → 不弹窗
  - **cwd 外** → RR5 hard block（`src/hooks/permission-guards.ts#tool.execute.before` 抛 `MsmPathEscapeError`/deny）→ 永不弹窗（直接拒绝）

### 演进史

- v1.3-v1：实现 cwd 内 pattern check → 与 RR5 重复
- v1.3-v2：事件名错（`event.permission.asked` 实际是 `permission.asked`）→ 修复
- v1.3-v3：根因（user "always" 是单一真相源，plugin 重复做 pattern check 浪费）
- v1.3-v4：简化 → 无条件 reply "always"，trust opencode own allow list

---

## 附录 A — 完整工具 description 文案

### msm_list

```
[PRIMARY] List all available MSM (Mech & Semi-Mech) tools in the current
serenity instance. **This is the FIRST tool to call for any shell/exec
operation** — bash, read (path arguments), and most plugin tools are
intentionally limited. Each MSM is a deterministic, audited operation
registered in `mech-registry.json`. Returns one MSM per line:
`name | skill | category | description`. If you need an operation that
has no MSM, ask the user to register a new one before running arbitrary
commands.
```

### msm_exec

```
[PRIMARY] Execute a registered MSM tool or invoke a protocol meta-command.
ALWAYS call `msm_list` first to discover the MSM name.
**args is a CLI args string** — protocol flags (S022 RFC §2.2) are
intercepted at the prefix: `--format=<text|json>`, `--log <path>`,
`--help [name]`, `--version`, `--list`, `--schema [name]`. Examples:
`args="--format=json /tmp/x"` for real exec; `args="--list"` for MSM
listing; `args="--schema ssh-connect"` for a MSM schema. **args in
real-exec mode**: rest of the string after protocol flags = business
args, passed verbatim to the MSM. 30s timeout. **Direct `bash` is
disabled by serenity policy (RR3)** — msm_exec is the only path for
shell work.
```

### msm_admin (v1.17 合并 register + deregister)

```
Register or deregister an MSM (Mech/Semi-Mech) in mech-registry.json.
**v1.17**: replaces the old msm_register + msm_deregister tools with a
single tool + action enum. Auto-commits the registry change as
"chore(msm): register <name>" or "chore(msm): deregister <name>".
```

### bash (disabled)

```
[DISABLED BY SERENITY POLICY] Direct shell execution is disabled in
serenity instances. Use `msm_list` + `msm_exec` to run MSMs, or create
a new MSM if none exists for your task.
```

---

## 附录 B — 错误类清单（v0.0.2 — 与 src/errors.ts 1:1 对齐）

```typescript
// src/errors.ts (2026-06-07 状态)
export class SerenityError extends Error {
  constructor(message: string) { super(message); this.name = 'SerenityError'; }
}

// RR1 违反
export class NotInGitRepoError extends SerenityError { /* RR6 git 验证失败 */ }
export class SerenityFileNotFoundError extends SerenityError { /* /ᐧ.serenity 缺失 */ }
export class SerenityFileEmptyError extends SerenityError { /* /ᐧ.serenity 空 */ }
export class SkillNotFoundError extends SerenityError { /* SKILL.md 缺失 (RR2) */ }

// RR3 违反
export class BashDisabledError extends SerenityError { /* bash 同名覆盖抛错 */ }

// msm 相关
export class MsmNotRegisteredError extends SerenityError { /* name 不在 registry */ }
export class MsmTimeoutError extends SerenityError { /* 30s 超时 */ }
export class MsmExecutionError extends SerenityError { /* exit != 0；持有 stdout/stderr/exitCode */ }
export class MsmAlreadyRegisteredError extends SerenityError { /* msm_admin register 冲突 */ }
export class MsmScriptNotFoundError extends SerenityError { /* register 时脚本文件不存在 */ }
export class MsmNotInRegistryError extends SerenityError { /* msm_admin deregister name 不存在 */ }
export class MsmPathEscapeError extends SerenityError { /* v0.1-2 path-arg 守卫 */ }
export class MsmSymlinkError extends SerenityError { /* v1-1 symlink 守卫 */ }

// RR7 触发
export class InitGitCommitError extends SerenityError { /* git add+commit 失败 */ }
export class InvalidInstanceNameError extends SerenityError { /* prefix 非 kebab-case (RR7 v1.10) */ }
```

**13 个 SerenityError 子类 + 1 基类** = 14 个错误类。**所有错误 extends SerenityError**（grep 友好，统一 catch 模式）。

> **变更记录**（v0.0.1 → v0.0.2）：
> - 删 `MsmArgsInvalidError`（args 改 CLI 字符串后不再 JSON parse）— 见 T1
> - 删 `MsmArgsParseError`（同上历史原因，已 dead code）
> - `MsmExecTimeoutError` → 重命名 `MsmTimeoutError`（语义清晰）
> - `MsmExecFailedError` → 重命名 `MsmExecutionError`（持有 stdout 字段 §9 修复）
> - 新增 `MsmPathEscapeError`（v0.1-2）、`MsmSymlinkError`（v1-1）、`InvalidInstanceNameError`（v1.10）、`MsmAlreadyRegisteredError`（v1.1）、`MsmScriptNotFoundError`（v1.1）、`MsmNotInRegistryError`（v1.1）

---

> **本文件完成时间**：2026-06-04
> **下一文件**：`src/types/`（TS 类型定义）+ `src/`（实现）
