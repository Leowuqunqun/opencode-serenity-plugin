# plugin-self-contained-msm v1 — 设计文档

> 关联会话：[S028](../AGENT_SESSIONS/2026-06-08--S028--plugin-self-contained-msm/SESSION.md)
> 关联决策：反转 S024/D26（plugin 仓 3 个 msm tool 不再 spawn 子进程）
> 目标 release：plugin v0.0.3

## 1. 背景

### 1.1 S024 现状（v0.0.2 release 2026-06-07）

S024 v1.14 选择了"**serenity 侧新 MSM + plugin 薄包装**"（**而非 plugin-only 或 plugin-replaces-MSM**）双仓架构：

| 仓 | 文件 | 行数 | 职责 |
|----|------|------|------|
| serenity | `msm-exec.ts` | 579 | 协议 runtime：6 必含 flag + stderr 6 字段 schema + spawn 业务 msm |
| plugin | `src/util/msm-call.ts` | 122 | 薄包装：spawn `npx tsx <serenity>/msm-exec.ts <args>` |

plugin 仓 3 个 msm tool 全部经过 `msm-call.ts`：
- `msm_exec` ← 唯一调用 msm-call 的 tool
- `msm_list` ← 直读 registry
- `msm_admin` ← 直写 registry

### 1.2 反转触发（S028 2026-06-08）

用户的核心约束（plugin 作为 serenity 的"创建者/管理者"，durable 基础设施；serenity 是可再生 artifact）：

> plugin 不假设 serenity 仓任何文件存在。新 serenity 项目冷启动时 plugin 必须能工作。

当前架构下，plugin 仓 4 个 msm tool 全部依赖 serenity 仓 `msm-exec.ts` 的绝对路径在 plugin 仓 cwd 下存在。新 serenity 项目（plugin 用户 clone 完 plugin 装到全局，但 serenity 仓还没初始化或在不同位置）就 spawn 失败。

### 1.3 关键发现（探索后）

- `msm-exec.ts` 579 行**零三方依赖**（仅 `node:fs` / `node:child_process` / `node:path` / `node:url`）— 可直接 in-process 化
- plugin 端 `parseMechRegistryFile`（v1.13 zod-first D26）已支持 v0 数组 + v1 wrapped 双 schema
- 9 个 `msm-call.test.ts` 用例是 E2E（真 spawn + tmp dir stub）— 反转后可保留高保真回归
- `msmExecTool` 当前 description 写"30s timeout"但实际 600_000ms（10 分钟）— 反转时修复
- plugin 端 SESSION.md v0.0.2 留 "msm_exec tool-level protocol flag prefix parsing (v1.15 deferred)" — S028 自动消解

## 2. 关键决策（D1-D8，S028）

| # | 决策 | 影响 |
|---|------|------|
| D1 | 反转 S024/D26 双仓设计。plugin 端 3 个 msm tool 完全自包含，serenity 仓 msm-exec.ts 保留供 eap-tool 等内部使用 | plugin 仓新增 ~600 行；serenity 仓 0 改动 |
| D2 | 冷启动边界 = 新 serenity 项目 | plugin 不假设任何 serenity 文件存在 |
| D3 | msmExec tool description 在 opencode 工具面板（LLM 视角）显示参数 schema | 描述重写为极简 A 版 |
| D4 | plugin 仓内独立文件 `src/util/msm-exec-runtime.ts`（~579 行），`msm-call.ts` 改为直接 import | 不新增 repo / 不 npm 化 / 不 git subtree |
| D5 | msmExec tool 描述只讲 msmName / args + 1 示例 | 极简 |
| D6 | Bootstrap on missing：plugin 初始化时若 `mech-registry.json` 不存在 → 创建空注册表 `{version:1, entries:[]}` | 不是 error，是合法初始状态 |
| D7 | drift 不防：plugin = 真相源（durable），serenity = 可再生 artifact | serenity 旧了直接删了重建 |
| D8 | msmRegistry 来源 = C：plugin 仓独立注册表，与 serenity 仓分离 | plugin 不读 serenity 的 registry |

## 3. 文件变更

| # | 文件 | 旧 | 新 | 备注 |
|---|------|----|----|------|
| 1 | `src/util/msm-exec-runtime.ts` | 不存在 | 从 serenity `msm-exec.ts` 移植 579 行 | 调整 `resolveRegistryPath` 路径解析（D9 待定） |
| 2 | `src/util/msm-call.ts` | spawn 子进程 122 行 | in-process import 调用 ~50 行 | 删 spawn / timeout 600s 保留 / 错误处理保留 |
| 3 | `src/msm.ts` | msmExec description 6 行（"30s timeout" + "ALWAYS msm_list first" + "RR3" 等）| 极简 A 版（2-3 字段 + 1 示例）| D5 |
| 4 | `src/util/mech-registry.ts` (新) | 不存在 | 路径解析 + bootstrap 逻辑（D6） | 独立文件，避免污染 msm-exec-runtime |
| 5 | `tests/msm-call.test.ts` | 9 用例（E2E spawn 风格）| 9 用例改 in-process 断言 | 保留 §9 错误回归 |
| 6 | `tests/msm-exec-runtime.test.ts` (新) | 不存在 | 6 必含 flag 单测（v0.0.2 deferred from v1.14）| 覆盖 --format/--log/--help/--version/--list/--schema |
| 7 | `mech-registry.json` (新) | 不存在 | 初始空 `{version:1, description:"...", entries:[]}` | D6 + D8 联合产物 |
| 8 | `SESSION.md` | 0 行 msm 改动 | 增 v0.0.3 块 + D27 + open follow-ups 更新 | 沿用 v0.0.2 release 块模板 |

**serenity 仓（home-serenity/）：0 改动**。msm-exec.ts 保留供 eap-tool 等内部使用（D1）。

## 4. 实施步骤

### Step 1 — 移植 msm-exec-runtime.ts
- 从 `home-serenity/.opencode/skills/home-serenity/scripts/msm-exec.ts` 复制 579 行到 `opencode-serenity-plugin/src/util/msm-exec-runtime.ts`
- `resolveRegistryPath` 改：D9 决定（见 §5）
- 保持所有 6 必含 flag / stderr schema / JSON Lines 日志行为不变

### Step 2 — 创建 mech-registry bootstrap 工具
- 新文件 `src/util/mech-registry.ts`（~50 行）：
  - `resolveMechRegistryPath(): string` — 返回 plugin 仓 registry 路径
  - `loadMechRegistry(): {version, description, entries}` — 不存在则创建空并返回空 schema
  - 单一职责：路径解析 + bootstrap，不做业务逻辑

### Step 3 — 重写 msm-call.ts 为 in-process
- 删除 spawn 相关代码（~80 行）
- 改为 `import { runMsmExec } from "./msm-exec-runtime"` + 直接调用
- 保持对外 API `callMsmExec(opts): Promise<MsmCallResult>` 不变（msm.ts 引用点不动）
- timeout 处理：msm-exec-runtime 内 business msm 30s → 统一为 600s（D5x 新增决策，见 §5）

### Step 4 — 改 msmExecTool description（D5）
- 旧描述剥到只剩：
  ```
  [PRIMARY] Execute a registered MSM (Mech/Semi-Mech) tool.

  Args:
    msm_name: string (required) — name of the MSM
    args:      string[] (default []) — passed positionally; protocol flags supported (--format, --log, --schema, --list, --help, --version)

  Example:
    args: ["list"]   // → calls msm named "list" with text output
  ```
- 删除：
  - "30s timeout"（错文案，反转时统一 600s 后也不显眼写出）
  - "ALWAYS call msm_list first"（D5：极简，无引导）
  - "Direct bash is disabled by serenity policy (RR3)"（D5：极简；RR3 保护是隐式的）

### Step 5 — 创建初始 mech-registry.json
- plugin 仓根目录 `mech-registry.json`：
  ```json
  {
    "version": 1,
    "description": "opencode-serenity-plugin 内部 msm 注册表（plugin 仓独立 — 不依赖 serenity 仓）",
    "entries": []
  }
  ```
- D6 bootstrap：plugin 启动时若不存在则创建这个空文件
- 不主动注册任何 MSM（让用户用 msm_admin 工具加）

### Step 6 — 更新测试
- `tests/msm-call.test.ts` 9 用例：
  - #1-#5 (resolveMsmExecScriptPath / callMsmExec 基本透传) → 改 in-process 直接断言 msm-exec-runtime 收到正确 args
  - #6/#7 (tool 注册) → 不变
  - #8/#9 (§9 fix 错误处理) → 保留 E2E 行为（spawn business msm，断言错误捕获路径）
  - #10 (空 stdout) → 保留 E2E
- `tests/msm-exec-runtime.test.ts` (新) ~15 用例：
  - --format text/json
  - --log JSON Lines append
  - --help / --version / --list / --schema 各自输出格式
  - 业务 msm 调用的 argv 透传
  - 业务 msm 失败的 6 字段 stderr 解析
  - 未知 flag → PARAMETER_INVALID_VALUE

### Step 7 — plugin SESSION.md 更新
- 加 v0.0.3 release 块（含 commits + D27 + open follow-ups 更新）
- v0.0.2 块的 follow-ups 划掉"msm_exec tool-level protocol flag prefix parsing"和"msm-exec.ts unit tests"（S028 解决）

### Step 8 — commit + push
- 用 `serenity-plugin-develop-kit` MSM：typecheck → test → build → install → commit + push origin main
- 预期 commit 链：
  - `feat: msm_exec in-process runtime (D27, S028)`
  - `feat: msmExec tool description 极简化 (D5)`
  - `test: msm-exec-runtime unit tests (v1.14 deferred)`
  - `chore: v0.0.3 release`

## 5. 开放设计点（实施前决策）

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| D9 | plugin 仓 msm-exec-runtime 的 `resolveRegistryPath` | `__dirname/../../mech-registry.json`（plugin 根）| 镜像 serenity 的 `__dirname/../references/...` 模式，路径是 plugin 根。**不**放 `references/`（plugin 仓还没这个目录） |
| D10 | 初始 mech-registry.json 状态 | 空 entries `{version:1, description:"...", entries:[]}` | D6 bootstrap 自然结果；用户用 msm_admin 加 |
| D11 | timeout 统一值 | 600_000ms（10 分钟）| 保留 plugin 端原 600s 上限（业务 msm 长任务友好）。msm-exec.ts 原 30s（业务 msm）一并提到 600s |
| D12 | msmExec tool description 极简度 | msmName + args（2 字段）+ 1 示例 | D5 锁定 |

D9-D12 我自行决策（user: "剩下的你自己可以找到"）。如有偏差，实施后用户可调整。

## 6. 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| msm-exec.ts 移植时漏改路径解析 | 中 | plugin 找不到 registry → 启动失败 | 单测覆盖 resolveMechRegistryPath + e2e spawn |
| in-process 调用的 error 传递丢失 | 低 | §9 fix 退化 | 保留 #8/#9 E2E 回归 |
| 30s → 600s 改动影响用户预期 | 低 | 长 timeout 占用资源 | 业务 msm 仍是独立 spawn，可单独 timeout |
| plugin 仓 mech-registry 与 serenity 仓同名 | 中 | git pull / IDE 混淆 | plugin 用根 `mech-registry.json`；serenity 用 `references/mech-registry.json`。两仓同名但路径不冲突 | 

**回滚**：S024 状态可重现 — `git revert` v0.0.3 commits 即可恢复 spawn 架构。

## 7. 不在本次范围

- msmExec v1 签名（cwd/timeout/env 顶层字段）— plugin SESSION.md 留 v0.0.4+ follow-up
- msmHelp / msmVersion / msmSchema tool 复活 — 已被 v1.16 Option C 删，本会话不复活
- msmAdmin 拆 register/deregister — 已被 v1.17 合并，本会话不拆
- eap-tool 迁移到 plugin 自包含 msm-exec — D1 决定 serenity 仓 msm-exec.ts 保留，eap-tool 暂不动

## 8. 验收标准

- [ ] plugin 仓 `pnpm typecheck` 通过
- [ ] plugin 仓 `pnpm test` 通过（既有 320 + 新增 ~15 msm-exec-runtime + 9 msm-call 改 in-process = ~344）
- [ ] plugin 仓 `pnpm build` 通过
- [ ] plugin 加载到 opencode 后 toast 显示新版本号
- [ ] 模拟冷启动：删除 `mech-registry.json` 后 `msm_list` 调用 → 触发 bootstrap → 返回空列表（不报错）
- [ ] `msm_admin register` 注册一个测试 msm → `msm_list` 可见 → `msm_exec` 调通
- [ ] msmExec description 在 opencode tool list 显示极简版（2 字段 + 1 示例，无 "30s" / "ALWAYS" / "RR3" 字样）

---

**下一步**：写完设计文档后立刻进 Step 1 实施（移植 msm-exec-runtime.ts）。任何一步失败停下来回滚。
