# @shgroup/opencode-serenity-plugin

> **ACC — Abstract Cognitive Container（抽象认知容器）**
>
> 一个 [OpenCode](https://github.com/open-code-ai/opencode) 平台插件。
> 它不是助手、不是框架、不是部署工具。
> 它定义"什么是认知容器"，并把它注入到你创建的任何 CCC 中。

---

## 概念模型

### 三层结构

```
ACC ──→ CCC ──→ 你的工作
抽象      具体      内容
```

| 层级 | 全称 | 是什么 | 例子 |
|------|------|--------|------|
| **ACC** | Abstract Cognitive Container | 认知容器的**抽象定义**——定义了容器应该有什么能力、遵守什么约束。持久源，不可替代。 | `opencode-serenity-plugin`（就是本仓库） |
| **CCC** | Concrete Cognitive Container | 认知容器的**具体实例**——从 ACC 生成的可操作工作空间。可删除后重建。 | `home-serenity/`、`my-project-serenity/` |
| **CC** (serenity) | Cognitive Container | 日常用语中的"认知容器"。代码里、沟通中说的 "serenity" 就是指 CC。 | — |

**关系**：
- ACC 是蓝图，CCC 是建筑。一栋建筑（CCC）按一张蓝图（ACC）建造。
- 修改 ACC → 重新 build + install → CCC 获得新能力。
- 不存在"ACC 和 CCC 谁更真实"——蓝图和建筑各有各的真实性。

### 三原则

每个 CCC 遵循三条硬约束，由 ACC 自动强制执行：

| 原则 | 含义 | 执行者 |
|------|------|--------|
| **P1 有根** | CCC 有且仅有一个 `.serenity` 标记的根目录 | `file_system` 工具 + activation |
| **P2 git管** | 根目录必须在 git 管理下，所有变更可追溯 | activation（RR6 git 检查）+ `msm_admin`（自动 commit） |
| **P3 权限二分** | 根内完全读写，根外零权限（绝对边界） | `permission-guards`（RR5 hard block） |

---

## 这个插件做了什么

安装后，OpenCode Agent 自动获得以下能力——这就是 ACC 定义的"认知容器的标准配置"：

### 6 个工具

| 工具 | 角色 | ACC/CCC 含义 |
|------|------|-------------|
| `msm_list` | 能力清单查询 | 查看当前 CCC 有哪些已注册的可执行操作（MSM） |
| `msm_exec` | 安全命令执行 | CCC 的唯一标准执行路径（替代裸 bash）；spawn 子进程时自动注入 CCC 上下文 |
| `msm_admin` | 能力扩展 | 向 CCC 注册新的 MSM；注册表变更自动 git commit |
| `file_system` | 安全文件操作 | bash 的文件操作替代层。12 个子命令（root / resolve / exists / list / tree / relative / mkdir / rm / mv / cp / touch / append）。所有写操作限定在 CCC 根内 |
| `session_tool` | 工作会话追踪 | 管理 `AGENT_SESSIONS/` 下的全周期工作记录 |
| `ccc_status` | CCC 健康检查 | 验证 P1（.serenity）、P2（git）、P3（opencode.json）状态 |

### 系统 Hook

| Hook | 职责 |
|------|------|
| `tool.execute.before` | RR5 路径守卫：read/edit/write/grep/glob 的路径参数必须在 CCC 根内 |
| `experimental.chat.system.transform` | 自动注入 CCC 的 SKILL.md 全文到 Agent 的 system prompt |
| `experimental.session.compacting` | 上下文压缩时保留 CCC 关键状态（根路径、CCC 名） |
| `tool.definition` | 向 subagent 的 tool 描述中注入 CCC 上下文，确保 subagent 也受相同约束 |
| `shell.env` | 注入环境变量 `SERENITY_ROOT` / `SERENITY_CCC` / `SERENITY_VERSION` |
| `event: permission.asked` | CCC 根内的文件操作自动授权 |

### TUI Slash Command

| 命令 | 作用 |
|------|------|
| `/serenity-init` | 将当前 git 仓库初始化为 CCC：创建 `.serenity` + git commit |
| `/serenity-bash-on/off/status` | bash 开关（D19：bash 是高危操作，CCC 默认使用 MSM） |

---

## 安装

### 前置条件

| 条件 | 要求 |
|------|------|
| Node.js | >= 20 |
| OpenCode | >= 1.16 |

### 标准安装

```bash
npm install @shgroup/opencode-serenity-plugin
npx opencode-serenity-plugin install
```

`install` 命令写入两处配置：

| 配置目标 | 写入位置 | 作用 |
|---------|----------|------|
| 项目级 | 当前目录 `opencode.json` | 注册 6 个工具 |
| 全局级 | `~/.config/opencode/tui.json` | 注册 slash command |

---

## 创建你自己的 CCC

### 从零开始

```bash
# 1. 进入一个新目录（必须是 git 仓库）
mkdir my-project && cd my-project && git init

# 2. 确保 opencode.json 中已安装本插件（`npx opencode-serenity-plugin install`）

# 3. 在 OpenCode 中输入 slash command
/serenity-init

# 按 TUI 提示：
#   前缀：my-project
#   描述：我的项目认知容器
#
# 结果：目录被标记为 CCC "my-project-serenity"
```

初始化后自动获得：
- `AGENT_SESSIONS/` — 工作会话记录目录
- `.opencode/skills/my-project-serenity/` — CCC 专属技能目录
- `.opencode/skills/my-project-serenity/references/mech-registry.json` — MSM 注册表
- 7 个标准技能模板（session / landscape / git / compass / exploration / sqc / quality-review）

### 日常使用

```bash
# 查看当前 CCC 状态
ccc_status

# 查看已注册的 MSM
msm_list

# 创建新的工作会话
session_tool create --desc "design-new-feature"

# 安全操作文件（代替裸 bash）
file_system tree --path src/
file_system append --path notes.md --content "新的观察记录\n"
```

---

## 开发

```bash
git clone git@github.com:tellmewhattodo/opencode-serenity-plugin.git
cd opencode-serenity-plugin
pnpm install
pnpm typecheck
pnpm test
pnpm build
npx opencode-serenity-plugin install
```

推荐使用 `serenity-plugin-develop-kit` MSM 自动执行 4 步流水线（typecheck → test → build → install）。

---

## 关联文档

| 主题 | 路径 |
|------|------|
| 范围层（RR1-RR7） | [`docs/requirements-v0-scope.md`](docs/requirements-v0-scope.md) |
| 架构设计 | [`docs/architecture-v0.md`](docs/architecture-v0.md) |
| 接口契约 | [`docs/contract-v0.md`](docs/contract-v0.md) |

---

> **版本**: v0.2.2
> **作者**: yh + 宁静号 Agent
