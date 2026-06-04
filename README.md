# opencode-serenity-plugin

> **WIP** — 仓库骨架阶段；需求未完全确定（待用户核对决策对账表）
> **作用**：opencode 平台本地插件，承载「宁静号」v0 5 条需求的实现
> **关联调研**：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/`（home-serenity 主仓）

---

## 0. 状态

| 项 | 状态 |
|----|------|
| 调研（L0-L6） | ✅ 已完成（home-serenity 主仓 SESSION）|
| 需求 v0 锁定（5 条 R1-R5） | ✅ 已锁定（`docs/requirements-v0-summary.md`）|
| 仓库骨架 | ✅ 本仓库（待核对元信息）|
| `git init` | ⏸ **未执行**（等核对后再 init）|
| 实现代码 | ⛔ **未开始**（用户明确：先核对再写）|

---

## 1. 待核对决策对账表（重要）

> 每个待决策项都给出**推荐 + 备选**。用户核对时只回复 "采用推荐" 或 "改 X" 即可。

| # | 决策项 | 推荐 | 备选 | 影响 |
|---|--------|------|------|------|
| **D1** | 仓库名 | `opencode-serenity-plugin` | `home-serenity-plugin` / `serenity-opencode-plugin` | 远程 URL + README 标题 + npm 包名 |
| **D2** | 父目录 | `AI_LAB/` | `INFRA/` | home-landscape 分类；CI 路径 |
| **D3** | 命名空间 | `yh`（与其他 yh 仓一致） | `agents`（群组）| GitLab 远程 URL |
| **D4** | 可见性 | **private**（v0 阶段）| public | 远程 clone 权限 |
| **D5** | 默认分支 | `main` | `master`（与多数 yh 仓一致）| 首次 push |
| **D6** | 包管理 | **pnpm**（与 home-serenity 一致）| npm | lockfile 类型 |
| **D7** | Node 版本 | **>= 20** | >= 18 | tsconfig target |
| **D8** | TypeScript | **5.x** | 4.x | language version |
| **D9** | 是否含 `.opencode-plugin.json` 描述文件 | **否**（opencode 插件纯 npm 入口，描述在 `package.json` 的 `opencode` 字段）| 是（独立 manifest）| plugin 加载逻辑 |
| **D10** | 测试框架 | **vitest**（与 @opencode-ai 生态一致）| jest | 配置文件 |
| **D11** | 引用调研文档方式 | **软引用**（README 注明 SESSION 路径，不复制内容）| 复制 + 重写 | 文档同步成本 |
| **D12** | 与 home-serenity 的耦合方式 | **通过相对路径** + `HOME_SERENITY_ROOT` env var | npm link / workspace | plugin 启动假设 |

**用户核对方法**：直接回复 "D1-D12: 全采用推荐" 或 "D3 改 agents, D6 改 npm, 其余推荐"。

---

## 2. 已知 v0 需求（5 条 R1-R5）

> **完整版见** `docs/requirements-v0-summary.md`（含 20 条验收）
> **源文档**：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/requirements-locked-v0.md`

| 需求 | 摘要 | 关键设计 |
|------|------|----------|
| **R1** | bash 工具替换 | plugin 注册同名 bash tool 抛错 + `permission.bash:"deny"` 双层 |
| **R2** | 1+1 msm 设计 | `msm_list` + `msm_exec` 两个 tool（替代 31 tool 化）|
| **R3** | read 弹窗关闭 | `permission.read:"allow"` 静态白名单 |
| **R4** | primary-agent 集成 | 修 L3 验证的 `default_agent` throw bug + 禁 cheap-worker |
| **R5** | 作用域门控 | 只在 serenity 目录工作；非 serenity → degraded mode；`HOME_SERENITY_RESTRICT` env 控制（默认 true）|

**v0 明确不可行（4 条）**：100% 无弹窗 / 0 维护 / 0 延迟 / 纯 prompt 替代 plugin。

---

## 3. 目录结构（已搭好）

```
opencode-serenity-plugin/
├── README.md                              # 本文件（决策对账 + 需求引用）
├── SESSION.md                             # 项目即会话轻量追踪
├── .gitignore                             # Node + TS + 编辑器
├── package.json                           # 占位：声明依赖意图（待核对）
├── src/                                   # ⛔ 空目录（实现代码待定）
│   └── .gitkeep
├── docs/                                  # ⛔ 当前仅 1 个引用文件
│   └── requirements-v0-summary.md         # 引用调研的 5 条 R1-R5
└── (待定) tsconfig.json                   # ⏸ 等 D6-D8 决定后写
```

---

## 4. 与 home-serenity 主仓的关系

```
┌─────────────────────────────────────┐
│  home-serenity/  (主仓)             │
│  ├── opencode.json                  │  ← v0 实施时改这里（D4 修 default_agent + R1/R3 permission）
│  ├── .opencode/skills/              │  ← v0 不动这里（plugin 不通过 skill 加载）
│  └── AGENT_SESSIONS/2026-06-04--... │  ← 调研 SESSION（已归档/只读）
└────────────────┬────────────────────┘
                 │ npm install 加载 / 软链 / 相对路径
                 ▼
┌─────────────────────────────────────┐
│  AI_LAB/opencode-serenity-plugin/   │  ← 本仓
│  ├── src/plugin.ts                  │  ← 5 个 hook 实现（R1-R5）
│  └── docs/                          │  ← 需求 + 验收 + 决策日志
└─────────────────────────────────────┘
```

**关键解耦**：
- 本仓**不**包含 `mech-registry.json` / `home-credentials.json`（属于主仓）
- 运行时 plugin 通过 `HOME_SERENITY_ROOT` env 找到主仓路径
- `mech-registry.json` 的 31 条 MSM 条目**不**复制到本仓（plugin 启动时 readFileSync 主仓的注册表）

---

## 5. 下一步（用户核对后执行）

1. 用户回复 D1-D12 决策
2. 按决策更新本仓（改包名、init git、写 tsconfig/package.json）
3. **不写实现代码**，等下一轮需求细化
4. 与 home-serenity 主仓的 `opencode.json` 集成（独立的"opencode.json 改造"会话）

---

## 6. 关联文件

- 调研 SESSION：`/home/yh/our-home/HOME-SERENITY/home-serenity/AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/SESSION.md`
- v0 需求源：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/requirements-locked-v0.md`
- L4 架构：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/docs/plugin-v0-architecture.md`
- L5 可行性：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/docs/plugin-viability-analysis.md`
- L6 路线：`AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/docs/plugin-implementation-roadmap.md`

---

> **当前日期**：2026-06-04
> **作者**：yh + 宁静号 Agent
> **状态**：WIP — 决策对账表待用户核对
