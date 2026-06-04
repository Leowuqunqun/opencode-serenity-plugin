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
import type { PluginApi } from '@opencode-ai/plugin';

export default async function (api: PluginApi): Promise<PluginReturn> {
  // ... 10 步启动协议
}

export interface PluginReturn {
  // 工具注册
  tool?: ToolDefinition[];
  // 命令注册
  command?: CommandDefinition[];
  // 事件订阅
  hook?: HookDefinition[];
}
```

**契约**：
- 必须**默认 export 一个 async 函数**（opencode 加载协议）
- 函数返回 `PluginReturn`；不激活时返回 `{}`（即插件完全不工作）
- 不抛错（抛错会中断 opencode 启动）

---

## C2 — `msm_list` Tool

### 注册

```typescript
api.registerTool({
  name: 'msm_list',
  description: '...',  // LLM 可见的 description
  parameters: z.object({}),  // 无参数
  execute: async () => { /* 返回 msm 列表 */ },
});
```

### 描述文本（LLM 可见）

```
List all available MSM (Mech & Semi-Mech) tools in the current serenity
instance. Each MSM is a deterministic, audited operation that can replace
arbitrary shell commands. **You MUST use `msm_exec` to run an MSM** —
direct `bash` is disabled by serenity policy.

Returns: name | skill | category | description | flags
```

### 入参

无。

### 出参

```typescript
interface MsmListResult {
  msms: MsmEntry[];
  total: number;
  scope: 'cwd';
}

interface MsmEntry {
  name: string;            // 'ssh-connect'
  skill: string;           // 'home-serenity'
  category: 'mech' | 'semi-mech';
  description: string;     // '唯一授权 SSH 工具。凭证统一管理...'
  path: string;            // 'scripts/ssh-connect.ts'（相对 cwd）
  flags: string[];         // ['--host', '--exec']
  usage: string;           // 'ssh-connect --host <alias> --exec "<cmd>"'
}
```

### 错误

- `MsmRegistryNotFoundError`（注册表文件不存在 → plugin 应不激活，此错误不应出现）
- `MsmRegistryInvalidError`（注册表 JSON 损坏）→ 抛错

---

## C3 — `msm_exec` Tool

### 注册

```typescript
api.registerTool({
  name: 'msm_exec',
  description: '...',
  parameters: z.object({
    msm_name: z.string().describe('MSM 名称（来自 msm_list 输出）'),
    args: z.string().optional().describe('JSON 字符串，传入 MSM 的参数'),
  }),
  execute: async ({ msm_name, args }) => { /* ... */ },
});
```

### 描述文本（LLM 可见）

```
Execute a specific MSM (Mech & Semi-Mech) by name. **Replaces bash** —
required by serenity policy.

Steps:
1. `msm_list` to see available MSMs
2. Call `msm_exec({ msm_name: '<name>', args: '<json-or-empty>' })`
3. If the MSM you need doesn't exist, you MAY create a new MSM in
   `cwd/.opencode/skills/<instance>/scripts/<name>.ts`, register it in
   `mech-registry.json`, then call `msm_exec`. Direct `bash` is disabled.

Returns: { stdout, stderr, exitCode, durationMs }
```

### 入参

```typescript
interface MsmExecInput {
  msm_name: string;       // 必填，从 msm_list 获取
  args?: string;          // 可选，JSON 字符串，序列化为对象传给 MSM
}
```

**args 序列化规则**：
- 传 `{"host":"ubuntu","exec":"uptime"}` → MSM 接收 `args = { host: 'ubuntu', exec: 'uptime' }`
- 传空或省略 → MSM 接收 `args = {}`
- 非法 JSON → 抛 `MsmArgsInvalidError`

### 出参

```typescript
interface MsmExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;       // 0 = 成功
  durationMs: number;
  msm_name: string;      // 回显
  args: Record<string, unknown>;  // 回显（已解析）
}
```

### 错误

| 错误 | 触发条件 | LLM 看到的 message |
|------|---------|------------------|
| `MsmNotRegisteredError` | msm_name 不在注册表 | `MSM "foo" not registered. Run msm_list to see available MSMs.` |
| `MsmArgsInvalidError` | args 不是合法 JSON | `args is not valid JSON: <error>` |
| `MsmExecTimeoutError` | 执行超过 30s | `MSM "foo" timed out after 30000ms` |
| `MsmExecFailedError` | 子进程返回非 0 exit | 透传 stderr + exitCode |
| `MsmRegistryNotFoundError` | 注册表缺失 | (plugin 不应激活) |

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

## C6 — `permission.asked` Event Hook

### 注册

```typescript
api.on('permission.asked', (event) => {
  // event.tool, event.args, event.path
  // 返回 'allow' | 'deny' | undefined（undefined = 走 opencode 默认）
  return isInsideCwd(event.path) ? 'allow' : 'deny';
});
```

### 行为

- **cwd 内的工具调用**（read/edit/write/webfetch 等）→ `'allow'`
- **cwd 外的工具调用** → `'deny'`
- **bash 工具** → 不在 hook 处理（已被 C4 覆盖抛错）
- **未实现**：`permission.asked` hook 在 opencode 1.15.13 是**死声明**（L3 验证）—— v0 **不实现**该 hook；C6 留作接口定义但 v0 不使用

### v0 替代方案

v0 暂**不实现自动权限决策**——`permission` schema 写进 plugin 返回的 `api.inject` 配置（如果 SDK 支持），或主仓 `opencode.json` 静态配置：

```json
{
  "permission": {
    "bash": "deny",
    "read": "allow",
    "edit": "ask",
    "webfetch": "ask"
  }
}
```

> v1+ PoC：用 `event` hook + `client.postSessionPermissionReply()` SDK API 实现完整自动决策。

---

## 附录 A — 完整工具 description 文案

### msm_list

```
List all available MSM (Mech & Semi-Mech) tools in the current serenity
instance. Each MSM is a deterministic, audited operation that replaces
arbitrary shell commands. You MUST use `msm_exec` to run an MSM —
direct `bash` is disabled by serenity policy.

Output: JSON with `msms` (array of {name, skill, category, description,
path, flags, usage}) and `total` count.
```

### msm_exec

```
Execute a specific MSM (Mech & Semi-Mech) by name. **Replaces bash** —
required by serenity policy (RR3).

Steps:
1. Call `msm_list` to see available MSMs
2. Call `msm_exec({ msm_name: '<name>', args: '<json>' })`
3. If no suitable MSM exists, you MAY create a new MSM in
   `cwd/.opencode/skills/<instance>/scripts/<name>.ts` and register
   it in `mech-registry.json`, then call `msm_exec`. Direct `bash` is
   disabled.

Output: JSON with `stdout`, `stderr`, `exitCode`, `durationMs`.
Errors: MsmNotRegisteredError | MsmArgsInvalidError | MsmExecTimeoutError
```

### bash (disabled)

```
[DISABLED BY SERENITY POLICY] Direct shell execution is disabled in
serenity instances. Use `msm_list` + `msm_exec` to run MSMs, or create
a new MSM if none exists for your task.
```

---

## 附录 B — 错误类清单

```typescript
// src/errors.ts
export class PluginNotActiveError extends Error {
  constructor(reason: string) { super(`Plugin not active: ${reason}`); }
}

export class SerenityInitAlreadyError extends Error {
  constructor() { super('/.serenity already exists. Remove it first to re-initialize.'); }
}

export class SerenityInitNotGitRepoError extends Error {
  constructor() { super('Not a git repo. Run "git init" first.'); }
}

export class SerenityInitInvalidNameError extends Error {
  constructor(name: string) {
    super(`Instance name "${name}" is invalid. Use kebab-case (e.g. "home-serenity").`);
  }
}

export class SerenityInitGitCommitError extends Error {
  constructor(stderr: string) { super(`git commit failed: ${stderr}`); }
}

export class MsmRegistryNotFoundError extends Error {
  constructor(path: string) { super(`Mech registry not found: ${path}`); }
}

export class MsmRegistryInvalidError extends Error {
  constructor(path: string, parseError: string) {
    super(`Mech registry invalid: ${path} — ${parseError}`);
  }
}

export class MsmNotRegisteredError extends Error {
  constructor(name: string) {
    super(`MSM "${name}" not registered. Run msm_list to see available MSMs.`);
  }
}

export class MsmArgsInvalidError extends Error {
  constructor(raw: string, parseError: string) {
    super(`args is not valid JSON: ${parseError}`);
  }
}

export class MsmExecTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`MSM "${name}" timed out after ${ms}ms`);
  }
}

export class BashDisabledError extends Error {
  constructor() {
    super(
      'Direct bash execution is disabled by serenity policy (RR3). ' +
      'Use msm_exec to run an MSM, or create a new MSM in ' +
      '.opencode/skills/<instance>/scripts/ and register it.'
    );
  }
}
```

---

> **本文件完成时间**：2026-06-04
> **下一文件**：`src/types/`（TS 类型定义）+ `src/`（实现）
