# SESSION: opencode-serenity-plugin

> **项目即会话模式**（home-session 定义）—— 本仓是独立 git 项目；日常演进通过 git commit 记录，本文件追踪**当前焦点 + 关键决策 + 项目初始化历史 + 关联文档**。
>
> **迁移说明**：本 SESSION 模式在 2026-06-04 21:00 从"事项化"切换为"项目即会话"。原事项化 session `AGENT_SESSIONS/2026-06-04--opencode-serenity-plugin-skeleton/` 已收口归档。

---

## 当前焦点

**等用户核对 R1-R5 需求细节**（5 条 v0 需求已锁定在 `requirements-locked-v0.md`）。

> 2026-06-04：项目框架 12 文件已落盘 + git init + push 到 `origin/main`（commit `99e95a3`）。
> D1-D12 元信息决策已默认全采用推荐。
> 下一步：用户回复 R1-R5 细节 → 我写 `src/plugin.ts` hooks（R1-R5）。

---

## 关键决策

| # | 决策 | 理由 | 状态 |
|---|------|------|------|
| 1 | 仓库放 `AI_LAB/opencode-serenity-plugin/` | 类比 `Claud Code Investigation` 同样为 agent 平台调研性质 | ✅ |
| 2 | v0 范围收窄到 5 条 R1-R5 | L5 可行性分析确认 GO；其余需求推 v1 | ✅ |
| 3 | 1+1 msm 设计（R2）替代 31 tool 化 | 消除 L4 §7.2 LLM 注意力分散风险 | ✅ |
| 4 | 作用域门控（R5）默认开启 | DR7-DR9 决策 | ✅ |
| 5 | v0 不解决完整权限拦截 | `permission.ask` hook 是死声明（L3 验证）| ✅（明确不可行）|
| 6 | 仓库骨架阶段不写实现 | 用户明确"需求未完全确定，先核对" | ✅ |
| 7 | D1-D12 全采用推荐 | 用户 m0055："别的我都没意见" | ✅ |
| 8 | SSH push 不用 token | 多个 GitLab SSH key 已配置；token 不进 shell 历史 | ✅ |
| 9 | `src/index.ts` 用 0-import stub | 避免 pnpm install 前 import SDK 类型报错 | ✅ |
| 10 | **改用项目即会话跟进** | 用户 m0062："SESSION 全部迁移到 repo 中" | ✅ |

### D1-D12 元信息决策（已默认通过）

| # | 决策项 | 采用 |
|---|--------|------|
| D1 | 仓库名 | `opencode-serenity-plugin` |
| D2 | 父目录 | `AI_LAB/` |
| D3 | 命名空间 | `yh` |
| D4 | 可见性 | `private` |
| D5 | 默认分支 | `main` |
| D6 | 包管理 | `pnpm`（含 `packageManager: pnpm@9.0.0`）|
| D7 | Node 版本 | `>=20` |
| D8 | TypeScript | `5.x` |
| D9 | 插件描述 | 仅 `package.json#opencode` 字段 |
| D10 | 测试框架 | `vitest` |
| D11 | 调研引用 | 软引用（README 注明 SESSION 路径）|
| D12 | 与主仓耦合 | `HOME_SERENITY_ROOT` env + 相对路径 |

---

## 未决问题

1. **R1-R5 需求细节核对**（用户主要关切）— 等用户回复
2. **msm_list / msm_exec 详细签名** — R2 验收 F1-F5 待敲定
3. **HOME_SERENITY_ROOT 传递方式** — D12 决定后写实现
4. **opencode.json 集成时机** — R1/R3/R4 涉及主仓改动，单独开 SESSION
5. **pnpm install 时机** — 框架已就绪；用户没要求现在 install；等放行实现时再装

---

## 项目初始化历史（从主仓事项化 SESSION 迁移）

> **来源**：`AGENT_SESSIONS/2026-06-04--opencode-serenity-plugin-skeleton/SESSION.md`（已收口为"已迁移"）
> **迁移时间**：2026-06-04 21:00

### 关键里程碑

| 时间 | 事件 |
|------|------|
| 20:45 | 创建 SESSION 目录 + plugin 仓目录 + src/ + docs/ |
| 20:46 | 写入 README / SESSION / .gitignore / package.json / requirements-v0-summary.md |
| 20:47 | 验证骨架完整 |
| 20:55 | GitLab API 创建远程仓（id=32, private, yh namespace）|
| 21:00 | 写 tsconfig.json (TS 5.x + Node 20+ strict) |
| 21:00 | 补 package.json (scripts + devDeps + engines + packageManager) |
| 21:00 | 写 vitest.config.ts + .nvmrc + .npmrc |
| 21:00 | 写 src/index.ts (空 stub) + tests/smoke.test.ts |
| 21:00 | `git init -b main` + commit `99e95a3` + push to origin/main (12 files / 458 lines) |

### 12 个文件清单（首推 commit `99e95a3`）

| 文件 | 用途 |
|------|------|
| `README.md` | 决策对账表 D1-D12 + 5 条 R1-R5 引用 |
| `SESSION.md` | 本文件 |
| `.gitignore` | Node + TS + 编辑器 + serenity-specific |
| `.npmrc` | pnpm 友好配置 |
| `.nvmrc` | Node 20 |
| `package.json` | scripts + devDeps + 依赖 `@opencode-ai/plugin@1.15.13` |
| `tsconfig.json` | TS 5.x + ES2022 + strict + Node 20+ |
| `vitest.config.ts` | D10 决策（vitest）|
| `src/index.ts` | 空 plugin stub（默认 export async () => ({})）|
| `src/.gitkeep` | 占位 |
| `tests/smoke.test.ts` | 验证 stub 加载 + 调用返回空对象 |
| `docs/requirements-v0-summary.md` | 5 条 R1-R5 引用 |

### 远程仓信息

- `git@home.gitlab:yh/opencode-serenity-plugin.git` — private, default_branch=main
- Web: `http://home.gitlab/yh/opencode-serenity-plugin`
- 首次 commit：`99e95a3` (12 files, 458 insertions)

---

## 最近变更

- 2026-06-04 21:00 — 项目框架 12 文件 commit `99e95a3` + push to origin/main
- 2026-06-04 21:00 — SESSION 模式从"事项化"切换到"项目即会话"（用户 m0062）
- 2026-06-04 21:00 — 主仓事项化 SESSION `2026-06-04--opencode-serenity-plugin-skeleton/` 收口归档

---

## 关联文档

- 调研 SESSION：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/`（home-serenity 主仓）
- 需求源：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/requirements-locked-v0.md`
- 架构 L4：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/docs/plugin-v0-architecture.md`
- 可行性 L5：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/docs/plugin-viability-analysis.md`
- 路线 L6：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/docs/plugin-implementation-roadmap.md`
- 主仓事项化 SESSION（已收口）：`AGENT_SESSIONS/2026-06-04--opencode-serenity-plugin-skeleton/SESSION.md`
- 主仓 project link：`AGENT_SESSIONS/_project-links.md`
