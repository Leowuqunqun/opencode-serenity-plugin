# RR7 Init — Design Doc

> **plugin**: opencode-serenity-plugin
> **版本**: v1.10 (RR7 实现)
> **日期**: 2026-06-06
> **状态**: 📐 设计层（待 review → 实施）
> **上游**: `docs/requirements-v0-scope.md` §3 RR7

---

## 1 目标

把"非 serenity 目录无法被 plugin 识别"的**死循环**打破：用户在任何 git 仓内运行 `/serenity-init` 即可把它转成 serenity 实例。

---

## 2 范围

### 2.1 在范围内

| # | 项 | 备注 |
|---|----|------|
| 1 | TUI plugin 注册 `/serenity-init` slash command | 入口点 |
| 2 | DialogPrompt 让用户输入 prefix | 智能预填默认值 |
| 3 | 写 `/.serenity` + `git add` + `git commit` | RR7 ④ ⑤ 行为 |
| 4 | 失败用 `api.ui.toast` 通知（variant=error） | 不抛错给 TUI |
| 5 | 成功后 toast 提示"请重启 opencode" | 不做 live re-activation（v0） |
| 6 | `initSerenity(cwd, prefix)` 纯函数 | 单元测试友好 |

### 2.2 在范围外（v1+ 候选）

- **Live re-activation**（成功后 plugin 立即变 active）：state machine 需加 `disabled → loading → ready` 转移路径。v0 不做，提示用户重启。
- **Server `serenity_init` tool**（让 LLM/脚本可调）：handler 复用 `initSerenity` 纯函数，但 TUI slash 已是主入口，v0 跳过。
- **多实例并存 / 重命名**（RR7 spec "可选更新"分支）：v0 默认 no-op，提示"已是 serenity"。
- **Slash args 直通**：`/serenity-init my-prefix` 在 TUI 中 args 被丢弃（`keymap.tsx:279` `dispatchCommand` 不传 args），所以 v0 永远走 dialog。

---

## 3 命名模型（RR7 ② 精修）

| 元素 | 旧 RR7 ② 描述 | 精修后 |
|------|----------------|--------|
| 用户输入 | 实例名（kebab-case） | **prefix**（不带后缀） |
| 最终实例名 | = 用户输入 | `= ${prefix}-serenity` |
| 例子 | `my-cool-project` | `xx` → `xx-serenity`；`tg` → `tg-serenity` |

**为什么精修**：让所有 serenity 实例**天然带 `-serenity` 后缀**，便于：
- 一眼区分 serenity vs 普通 skill
- 与 opencode 自带 skill（`home-*`）的命名风格不同
- prefix 是用户可控的短字符串（≤ 20 字符），dialog 输入更轻

**默认 prefix 计算**（`defaultPrefix(cwdRoot)`）：

| 目录名 | 推导 prefix |
|--------|-----------|
| `tg-serenity` | `tg`（剥后缀） |
| `xx-serenity` | `xx`（剥后缀） |
| `my-cool-project` | `my-cool-project`（kebab-case 转换） |
| `MyProject` | `myproject`（kebab-case 转换） |
| `My Cool App` | `my-cool-app`（kebab-case 转换） |

> 目录名后缀检测必须要求 prefix 部分自身是合法 kebab-case（`^[a-z0-9]+(-[a-z0-9]+)*$`），避免 `---serenity` 之类误判。

---

## 4 触发 + UX 流程

```
用户输入: /serenity-init
  ↓ TUI slash 识别
onSelect(dialog) 触发
  ↓ 检查 dialog 非空
dialog.replace(() => <DialogPrompt
  title: "Initialize serenity"
  placeholder: "kebab-case prefix (e.g. xx, tg)"
  value: defaultPrefix(cwdRoot)  ← 智能预填
  onConfirm(value):
    prefix = value.trim()
    验证 prefix (kebab-case) ─────→ 失败: toast error, dialog 保持
    ↓ 通过
    initSerenity(cwd, prefix):
      - 查 git repo
      - 查 /.serenity 已存在?
        - 是 → return { kind: 'already', name }
        - 否 → write /.serenity + git add + commit
      - 失败抛错（带 rollback）
    ↓ 成功
    dialog.clear()
    toast: "initialized (instance: xx-serenity); please restart opencode"
  onCancel:
    dialog.clear()
    toast: "init cancelled"
>)
```

**关键决策**：
- **Dialog 在错误时**保持开启**（invalid prefix / git error）**：让用户能改完重试，不强制从头开始
- **Dialog 在成功 / 已是 / 取消时关闭**：减少认知负担
- **args 被忽略**：`/serenity-init my-prefix` 与 `/serenity-init` 走同一流程

---

## 5 失败矩阵

| 条件 | 行为 | 错误类 / 返回 |
|------|------|---------------|
| cwd 不在 git repo | toast: "cwd is not a git repo; please run `git init` first, then `/serenity-init` again" | throw `NotInGitRepoError` |
| prefix 不合法（空 / 非 kebab-case） | toast: "Invalid name \"X\": must be kebab-case (a-z, 0-9, dashes; no leading/trailing dash)" | throw `InvalidInstanceNameError` |
| `/.serenity` 已存在 | dialog 关闭；toast: "already a serenity directory (instance: N); no changes made" | return `{ kind: 'already', instanceName }` |
| `git add` 失败 | rollback（删 `/.serenity`）；toast error | throw `InitGitCommitError` |
| `git commit` 失败 | 同上（rollback） | throw `InitGitCommitError` |
| `dialog` 为 undefined | toast error，return | （罕见，防御性） |

---

## 6 API 设计

### 6.1 `src/util/init.ts`（新文件）

```ts
export const SERENITY_SUFFIX = '-serenity';

export type InitResult =
  | { kind: 'created'; instanceName: string; prefix: string; cwdRoot: string }
  | { kind: 'already'; instanceName: string; cwdRoot: string };

/** 字符串 → kebab-case（lowercase, 非 alnum → -, 折叠）*/
export function toKebabCase(s: string): string;

/** 剥 "-serenity" 后缀；不在则原样返回 */
export function stripSerenitySuffix(name: string): string;

/** 验证 prefix 是 kebab-case；不合法抛 InvalidInstanceNameError */
export function validatePrefix(prefix: string): void;

/** 智能默认 prefix（见 §3 表格） */
export function defaultPrefix(cwdRoot: string): string;

/** 纯函数：初始化 cwd 为 serenity 实例 */
export function initSerenity(cwd: string, prefix: string): InitResult;
```

### 6.2 `src/util/serenity-file.ts`（新增 2 个函数）

```ts
/** 写 `/.serenity`（创建或覆盖），内容 = instanceName + '\n' */
export function writeSerenityFile(cwdRoot: string, instanceName: string): void;

/** 删 `/.serenity`（init 失败时 rollback 用），ENOENT 静默 */
export function removeSerenityFile(cwdRoot: string): void;
```

### 6.3 `src/errors.ts`（新增 1 个错误类）

```ts
export class InvalidInstanceNameError extends SerenityError {
  constructor(name: string) { ... }
}
```

（`NotInGitRepoError` / `InitGitCommitError` 已存在，直接复用）

### 6.4 `src/tui.ts`（重写）

```ts
const Tui: TuiPlugin = async (api) => {
  // 1. 激活 toast（v1.9.1 保留）
  api.ui.toast({ ... });

  // 2. 注册 /serenity-init slash command（v1.10 RR7）
  api.command?.register(() => [{
    title: 'serenity: init cwd',
    value: 'serenity-init',
    description: 'Create /.serenity and git-commit (requires restart)',
    slash: { name: 'serenity-init' },
    onSelect: (dialog) => { /* 见 §4 流程 */ },
  }]);
};
```

**注意**：
- 不用 `createElement`（v1.16.2 SDK 中 `api.ui.DialogPrompt` 是函数，**直接调用**即可，绕过 JSX 编译时 transform 问题）
- 走 `dialog.replace(() => api.ui.DialogPrompt({...}))` 模式，与 S019 调查结论一致

---

## 7 测试矩阵

### 7.1 `tests/util-init.test.ts`（新文件，~10 tests）

| # | 测试 | 覆盖 |
|---|------|------|
| 1 | `toKebabCase` 各种输入 | helper |
| 2 | `stripSerenitySuffix` 命中 / 不命中 | helper |
| 3 | `validatePrefix` 接受 / 拒绝 | helper |
| 4 | `defaultPrefix` 各种目录名 | helper |
| 5 | `initSerenity` 完整成功流程 | 写文件 + git commit + 读回 |
| 6 | `initSerenity` 已存在 → `{ kind: 'already' }` | 失败矩阵 |
| 7 | `initSerenity` invalid prefix 抛 `InvalidInstanceNameError` | 失败矩阵 |
| 8 | `initSerenity` 非 git repo 抛 `NotInGitRepoError` | 失败矩阵 |
| 9 | `initSerenity` git commit 失败时 rollback（文件被删） | rollback 验证 |
| 10 | `initSerenity` 不创建 `.opencode/skills/<N>/` | RR7 ⑤ |

### 7.2 `tests/util-serenity-file.test.ts`（+2 tests）

- `writeSerenityFile` 写盘 + 读回
- `removeSerenityFile` 存在/不存在都安全

### 7.3 `tests/tui.test.ts`（+2 tests）

- 验证 slash command 已被注册（mock `api.command.register`）
- 验证 onConfirm 成功路径触发 `initSerenity` + toast

### 7.4 `tests/errors.test.ts`（+1 line）

- `InvalidInstanceNameError` 加入 `all extend SerenityError` 列表

---

## 8 文件变更总览

| 文件 | 变更类型 | 摘要 |
|------|----------|------|
| `docs/rr7-init-design.md` | 新建 | 本文档 |
| `docs/requirements-v0-scope.md` | 修改 | RR7 ② 改为 prefix 模型（§3 命名模型） |
| `src/util/init.ts` | 新建 | RR7 init 纯函数 + 4 个 helper |
| `src/util/serenity-file.ts` | 修改 | + `writeSerenityFile` / `removeSerenityFile` |
| `src/errors.ts` | 修改 | + `InvalidInstanceNameError` |
| `src/tui.ts` | 重写 | + slash command 注册（保留 toast） |
| `tests/util-init.test.ts` | 新建 | §7.1 测试矩阵 |
| `tests/util-serenity-file.test.ts` | 修改 | §7.2 |
| `tests/tui.test.ts` | 修改 | §7.3 |
| `tests/errors.test.ts` | 修改 | §7.4 |
| `SESSION.md` | 修改 | v1.10 记录（实施后） |

---

## 9 决策记录

| # | 决策 | 理由 |
|---|------|------|
| D1 | 用户输入 prefix，plugin 加 `-serenity` 后缀 | 用户 m0040 明确要求；统一命名风格 |
| D2 | 用 `api.ui.DialogPrompt`（直接调用），不写 JSX | v1.9.1 已确认 `@opentui/solid` JSX runtime 不可用；函数直调等价 |
| D3 | Dialog 在错误时**不关闭** | 让用户能改完重试 |
| D4 | 成功 / 已是 / 取消时**关闭** Dialog | 减少认知负担 |
| D5 | 不做 live re-activation | 状态机变更面较大，v0 提示用户重启最简 |
| D6 | "已存在"走 no-op（不更新实例名） | 重命名隐含 `.opencode/skills/<N>/` 重建，超出 init 范围 |
| D7 | `git add` 失败要 rollback 写文件 | 保持 cwd 一致状态（不留半成品） |
| D8 | args 路径**不实现** | SDK 不支持 slash arg 传递（keymap.tsx:279） |
| D9 | 不在 v0 加 server `serenity_init` tool | 入口已覆盖；tool 复用纯函数但增量价值小 |
| D10 | 错误抛 `InvalidInstanceNameError`（不返回） | 真正的非法状态，应该 throw；"已存在"才是软失败 |

---

## 10 未决 / 已决

| 项 | 状态 |
|----|------|
| Slash command 路径 | ✅ TUI onSelect + DialogPrompt |
| 实例命名 | ✅ prefix + `-serenity` 后缀 |
| Live re-activation | ⏸ 推迟 v1+ |
| Server tool | ⏸ 推迟 v1+ |
| 失败 UX | ✅ toast variant=error，dialog 错误时保持 |
| Rollback 策略 | ✅ 写文件后 git 失败 → 删文件 |
| **v1.10.1 全局可见** | ✅ TUI plugin 自安装到 `~/.config/opencode/tui.json`，slash command 在**任何**目录可见（详见 §11）|

---

## 11 v1.10.1 — slash command 全局可见

> 状态：✅ 实施（commit 待生成；与本文档同步更新）

### 11.1 根因

TUI plugin 只在 `tui.json` 文件里登记的路径下被 opencode 加载。plugin 路径只登记在项目 tui.json（`<serenity-root>/tui.json`），非 serenity 目录 walk-up 找不到 tui.json → plugin 不加载 → `Tui(api)` 永不调 → slash command 不出现。

机制文件：
- `packages/opencode/src/config/paths.ts:10-21`（`ConfigPaths.files` walk-up 找 tui.json）
- `packages/opencode/src/cli/cmd/tui/config/tui.ts:194-231`（合并 config）
- `packages/opencode/src/cli/cmd/tui/plugin/runtime.ts:1074-1129`（从 `config.plugin_origins` 加载 plugin）

### 11.2 修复

plugin `Tui(api)` 入口**自检并自安装**到 global TUI config（`$XDG_CONFIG_HOME/opencode/tui.json` 或 `~/.config/opencode/tui.json`）：

- 幂等：plugin path 已在 list 中时 no-op
- 保留其他字段（theme / keybinds / attention / prompt / …）
- 写失败不抛：返回 `{ changed: false, error }`，仅 log.warn
- 路径规范化：所有 path 走 realpathSync + pathToFileURL，与 opencode 的 `ConfigPlugin.resolvePluginSpec` 一致

### 11.3 行为契约

- **首次启动**（plugin 第一次被加载）：写入 global tui.json + 弹 toast "restart opencode to enable /serenity-init in non-serenity directories"（与 D5 一致）
- **后续启动**（plugin 已 global 注册）：no-op，无额外 toast
- **self-install 失败**（permission denied / 磁盘满 / …）：slash command 仍注册，仅 log.warn（plugin "dormant" 状态下也可用）
- **D1-D10 不动**：本节是 v1.10 RR7 设计的"可见性补丁"，不动 UX / 命名 / 失败矩阵

### 11.4 关联

- 代码：`src/util/tui-install.ts`（新）+ `src/tui.ts`（B 段接入）
- 测试：`tests/tui-install.test.ts`（23 unit tests）+ `tests/tui.test.ts`（+5 integration tests）
- 调研 SESSION：`AGENT_SESSIONS/2026-06-06--S020--fix-serenity-init-visibility/`

> 本文档是 RR7 实施的 source of truth。任何对触发流程 / 命名 / 失败矩阵的修订都应改本文档 + 在 SESSION.md 留 commit 历史。
