# @shgroup/opencode-serenity-plugin

> **Serenity（宁静号）** — 为 OpenCode Agent 提供受控工作空间的插件。
>
> 安装后，Agent 自动获得安全文件操作、可审计命令执行、工作会话追踪等能力。
> 所有这些能力被限定在一个有明确边界的"认知容器"内——根内自由，根外隔离。

---

## 这是什么

Serenity 是一个 [OpenCode](https://github.com/open-code-ai/opencode) 平台插件。它的核心资产是**认知容器**（Cognitive Container）：

| 概念 | 是什么 | 怎么用 |
|------|--------|--------|
| 认知容器 | 一个 `.serenity` 标记的 git 目录。Agent 在该目录内拥有受控的工作权限。 | 每个项目创建一个。`home-serenity/` 是家庭管理用，`my-project-serenity/` 是开发用。 |
| 本插件 | 认知容器的"蓝图"。定义了容器有什么能力、遵守什么约束。 | `npm install` + `install`，一次配置，所有容器共用。 |

类比：插件是操作系统，认知容器是用户目录——装一次 OS，在各个目录下工作。

### 为什么需要认知容器

OpenCode Agent 原生的 `bash`、`read`、`edit`、`write` 可以访问整个文件系统。Serenity 加上一层边界：

| 无 Serenity | 有 Serenity |
|-------------|------------|
| Agent 可以读写任何路径 | 读写限制在容器根内（P3 权限二分） |
| `bash` 执行不可审计 | `msm_exec` 执行可追踪、可审查 |
| 没有工作记录 | 每次多步工作自动创建 SESSION |
| 没有上下文持久化 | SKILL.md 自动注入 Agent 对话 |

---

## 三个硬约束

每个认知容器遵守三条原则，由插件自动执行：

| # | 原则 | 含义 | 谁执行 |
|---|------|------|--------|
| P1 | **有根** | 容器有且仅有一个 `.serenity` 标记的根目录 | `file_system` 工具 |
| P2 | **git 管** | 根目录必须在 git 管理下，所有变更可追溯 | 激活检查 + `msm_admin` 自动 commit |
| P3 | **权限二分** | 根内完全读写，根外零权限 | `permission-guards` hook（RR5） |

---

## 6 个工具

安装后 Agent 获得以下工具，替代裸 bash 和原生文件操作：

| 工具 | 作用 |
|------|------|
| `msm_list` | 查看当前容器已注册的可执行操作（MSM）。**任何 shell 操作前先调这个。** |
| `msm_exec` | 容器唯一标准执行路径。替代裸 bash。自动注入 `SERENITY_ROOT` / `SERENITY_CCC` / `SERENITY_VERSION` 到子进程。 |
| `msm_admin` | 向容器注册新的 MSM。注册表变更自动 git commit。 |
| `file_system` | 安全文件操作。12 个子命令：`root` / `resolve` / `exists` / `list` / `tree` / `relative` / `mkdir` / `rm` / `mv` / `cp` / `touch` / `append`。写操作限定在容器根内。 |
| `session_tool` | 工作会话全周期管理。`create` / `list` / `show` / `health` / `qa` / `archive` / `summary`。 |
| `ccc_status` | 容器健康检查。验证 P1（`.serenity` 存在）、P2（git 仓库）、P3（`opencode.json` 配置完整）。 |

---

## 安装

```bash
# 前置：Node >= 20，OpenCode >= 1.16
npm install @shgroup/opencode-serenity-plugin
npx opencode-serenity-plugin install
```

`install` 写入两处配置：

| 目标 | 路径 | 作用 |
|------|------|------|
| 项目级 | 当前目录 `opencode.json` | 注册 6 个工具 |
| 全局级 | `~/.config/opencode/tui.json` | 注册 `/serenity-init` slash command |

---

## 创建认知容器

```bash
# 1. 进入 git 管理的目录
mkdir my-project && cd my-project && git init

# 2. 在 OpenCode 中输入
/serenity-init
```

TUI 会询问容器前缀（如 `my-project`）和一句话描述。确认后自动创建：

```
my-project-serenity/
├── .serenity                ← 容器标记文件
├── AGENT_SESSIONS/           ← 工作会话记录
├── .opencode/skills/
│   └── my-project-serenity/
│       ├── SKILL.md          ← 容器主入口文档
│       └── references/
│           └── mech-registry.json
```

初始化后立即可用：

```
msm_list                    # 查看已注册 MSM
ccc_status                  # 验证容器健康状态
session_tool create --desc "my-first-task"
file_system tree --path src/
```

---

## 概念模型（深入阅读）

如果你关心"为什么这样设计"，Serenity 的底层模型是 **ACC/CCC 分层**：

```
ACC (Abstract Cognitive Container)  →  本插件（持久源，定义"什么是容器"）
  └── CCC (Concrete Cognitive Container)  →  每个 `xxx-serenity/` 目录（可操作实例，可从 ACC 重建）
```

关系：ACC 是蓝图，CCC 是建筑。修改插件（ACC） → build + install → 所有 CCC 自动获得新能力。

日常使用时不需要这些术语——"Serenity" 或"认知容器"就够了。

---

**版本**: v0.2.2
