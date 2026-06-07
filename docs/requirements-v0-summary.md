# v0 需求摘要（5 条 R1-R5）⚠️ 已过时

> **源文档**：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/requirements-locked-v0.md`
> **本文件作用**：在 plugin 仓内快速引用，避免每次回主仓查。
> **同步约定**：调研 SESSION 文档若改动，本文件手动更新（**不**自动同步——需求一旦锁定即冻结）。
>
> ⚠️ **已过时**（v0.0.2 — 2026-06-07）：R1-R5 已被 RR1-RR7 完全取代，本文件仅保留演进历史。**新需求请阅 [`docs/requirements-v0-scope.md`](./requirements-v0-scope.md)**。

---

## R1：bash 替换为 msm 执行工具

**问题**：LLM 可用 `bash { command: "ssh root@ip ..." }` 静默绕开 ssh-connect

**方案**（双层）：
1. **plugin 层**：在 `package.json#opencode.tools` 注册同名 `bash` tool，**每次调用直接 throw 错误**（"此环境禁用 bash，请使用 msm_exec"）
2. **opencode.json 层**：在 `permission.bash` 设 `"deny"`

**验收 F1**：plugin 加载后，LLM 工具列表中 `bash` 仍可见（同名覆盖），但调用必抛错。
**验收 F2**：即使绕过 plugin（直接改 opencode.json），`permission.bash:"deny"` 也兜底。

---

## R2：1+1 msm 设计

**问题**：原"31 tool 化"会让 LLM 注意力分散（L4 §7.2）

**方案**：**只注册 2 个 tool**：
- `msm_list`：返回 31 条 MSM 清单（按 category 分组），描述每个 MSM 用途
- `msm_exec(msm_name, args)`：执行指定 MSM

**验收 F3**：`msm_list` 返回结构化清单，category 至少含：`ssh-connect / resolve-path / mech-manifest / server-health-check / orbit-status / container-mgmt / vllm-status / health-check / session-qa / create-session / archive / eap-diagnose / eap-checklists / check-triggers / repo-scan / scan-network / batch-sync / batch-clone / ssh-host / ...`
**验收 F4**：`msm_exec` 调用 `ssh-connect --host <name> --exec "<cmd>"` 时透传参数。
**验收 F5**：任意非 serenity 目录下 `msm_list` 仍能工作（R5 单独处理 exec）。

---

## R3：read 弹窗静态白名单

**问题**：opencode.json 当前 `permission` 只声明 `task`，read 每次弹 ask

**方案**：**opencode.json 静态配** `permission.read: "allow"`（**不开 plugin hook**——纯配置够用）

**验收 F6**：read 操作不弹窗。
**验收 F7**：edit / webfetch 仍弹（v0 不可行项，v1 PoC 再处理）。

---

## R4：home-serenity primary-agent 集成

**问题**：
- 当前 `default_agent: "home-serenity"` 在 agent 字典未定义 → `throw new Error`（L3 验证 agent.ts:315）
- `cheap-worker` 仍 enabled

**方案**（主仓 opencode.json 改动，**不在本仓**）：
1. 在 `agent` 字典定义 `home-serenity` 主 agent（prompt 引用 system prompt + 必加载 skill 列表）
2. 设 `cheap-worker.enabled: false`
3. 保留 `build` / `plan` 为 subagent（`enabled: false` 保留为将来 v1 启用）

**验收 F8**：启动不再 throw。
**验收 F9**：主 agent 名称 "home-serenity" 出现在 LLM system prompt 顶部。
**验收 F10**：cheap-worker 不可见 / 不可用。

---

## R5：作用域门控（degraded mode + env var）

**问题**：plugin 应只在宁静号目录工作，防止误用到其他项目

**方案**（DR7-DR9）：
- **DR7**：非 serenity 目录走 **degraded mode**（不静默 no-op）
  - `msm_list` 返回 `[{"name": "info", "description": "本环境已禁用 msm 工具（HOME_SERENITY_RESTRICT=true）", "category": "system"}]`
  - `msm_exec` 抛错 `"msm_exec unavailable: HOME_SERENITY_RESTRICT=true, 请在宁静号根目录运行"`
- **DR8**：判定 = `process.cwd()` 是否以 `$HOME_SERENITY_ROOT` 为前缀
- **DR9**：行为受 `HOME_SERENITY_RESTRICT` env var 控制（默认 `true`）

**验收 S1**：在 serenity 目录下 `msm_list` 返回完整 31 条。
**验收 S2**：在 `/tmp` 下 `msm_list` 返回 degraded 单条说明。
**验收 S3**：在 `/tmp` 下 `msm_exec("ssh-connect", ...)` 抛错。
**验收 S4**：`HOME_SERENITY_RESTRICT=false` 时所有目录都正常（escape hatch）。

---

## 不可行项（v0 明确不做）

| # | 项 | 原因 | 后续 |
|---|----|------|------|
| I1 | 100% 无弹窗（edit / webfetch 仍弹）| `permission.ask` hook 是死声明（L3 验证）| v1 PoC 用 event hook + SDK reply |
| I2 | 0 维护成本 | plugin 必须跟随 opencode 升级 | 锁 commit + 每次 release 回归 |
| I3 | 0 延迟 | 物理规律 | 接受 |
| I4 | 纯 prompt 替代 plugin | L1 证伪 8 处软约束失效 | 不可能 |

---

## 20 条验收索引

- **F1-F10**：功能性（10 条）
- **P1-P2**：性能/兼容性（2 条）
- **S1-S4**：作用域/隔离（4 条）
- **M1-M3**：可维护性（3 条）
- **总计 19 条**（源文档是 20 条 = F1-F14 + P1-P2 + S1-S4 + M1-M3；本摘要仅列 10 条关键 F）

**完整验收**见源文档 §3。

---

> **本文件锁定日期**：2026-06-04
> **如需求改动**：回主仓 SESSION 改 `requirements-locked-v0.md`，**不**改本文件（防止两处不同步）
