# Skill: {{prefix}}-session — 工作会话追踪

> AGENT_SESSIONS 全生命周期管理

## 用途

管理宁静号实例的工作会话记录，确保每次多步骤工作都有完整的决策链路和进度追踪。

## 目录位置

```
$ {{prefix}}-serenity/AGENT_SESSIONS/
```

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
| `session-tool list` | 列出所有会话 |
| `session-tool show <id>` | 查看会话详情 |
| `session-tool create` | 创建会话（item/project 双模式） |
| `session-tool health` | 健康检查（stale/stalled/drift/ghost） |
| `session-tool archive` | 归档已关闭会话 |
| `session-tool summary` | 全局仪表盘 |

所有路径通过 `file-system root` 动态解析。
