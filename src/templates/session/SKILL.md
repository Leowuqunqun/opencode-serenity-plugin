---
name: {{prefix}}-session
description: AGENT_SESSIONS 工作会话追踪 — 全周期记录探索/分析/实施类工作的目标、决策、进度与结果
---

# Skill: {{prefix}}-session — 工作会话追踪

> AGENT_SESSIONS 全生命周期管理

## 用途

管理认知容器 (CCC) 的工作会话记录，确保每次多步骤工作都有完整的决策链路和进度追踪。

## 目录位置

```
$ {{prefix}}-serenity/AGENT_SESSIONS/
```

## 核心规则（硬约束）

以下三条为 ACC 强制规则，违反的 session 将被 `health` 检测为 ghost/drift：

### 1. 编码规则

每个 session 必须在目录名中包含 `S###` 编码（3 位数字，零填充，如 `S001`, `S042`）。

`session create` 自动分配编码 — 从现有最大值 + 1。

目录名格式：`YYYY-MM-DD--S###--<short-description>`

### 2. 创建 = 初始化 SESSION.md

`session create` 创建 session 目录的**同时**写入 `SESSION.md` 模板。

Agent 在创建 session 后应立即补充目标和初始决策，不可留空。

### 3. 文件归属

session 的所有产物（记录、设计稿、数据）**必须**在该 session 目录内，不可散落在 `AGENT_SESSIONS/` 顶层。

## 核心原则

- **自由容器**：会话目录可以包含任何文件（SESSION.md、设计草案、原始数据、示意图）
- **SESSION.md 是唯一硬约束**：其他一切自由
- **项目即会话**：独立 git 仓库的长期项目，用项目自身的 git 历史做进度追踪

## SESSION.md 模板

```markdown
# SESSION: <标题>
- ID: S###

## 目标
<一句话>

## 状态
- [ ] 进行中

## 关键决策
| # | 决策 | 理由 |
|---|------|------|

## 进度记录
- YYYY-MM-DD HH:mm — <做了什么>

## 产出物
- <文件路径>

## 未解决的问题
- <问题>
```

## 可用工具

| 工具 | 用途 |
|------|------|
| `session list` | 列出所有会话 |
| `session show <id>` | 查看会话详情 |
| `session create` | 创建会话（--desc <desc> [--goal <goal>]） |
| `session health` | 健康检查（stale/stalled/drift/ghost） |
| `session archive` | 归档已关闭会话 |
| `session summary` | 全局仪表盘 |
| `msm_exec session-tool <subcommand>` | 扩展子命令（如 reindex） |

所有路径通过 `file-system root` 动态解析。

## 扩展 ACC 会话能力

本 CCC 可以通过注册 `session-tool` MSM 来扩展 ACC 的 `session` 工具。

详见 `session hook-develop-guide`（ACC session 工具的内置扩展指南）。
