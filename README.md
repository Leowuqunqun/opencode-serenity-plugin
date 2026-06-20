# Serenity（宁静号）

> **给 AI 一个它不能逃逸、但可以自由思考的工作空间。**
>
> 不是安全沙箱——是认知容器。

---

## 你遇到的可能是同一个问题

你用 OpenCode + Claude / DeepSeek 写代码。它很聪明——但聪明也意味着危险。

有一天你发现 Agent 改了你不该改的文件。或者它跑了不该跑的命令。或者三周后你忘了它当时做了什么决策、改了哪些文件、为什么那样改。

你开始犹豫：到底该给它多大权限？

**Serenity 的回答：不给权限——给它一个容器。**

---

## 什么是 Serenity

Serenity 是一个 OpenCode 插件。安装后，它把任何 git 目录变成 **CCC（Concrete Cognitive Container）**——一个 Agent 可以自由工作但无法逃逸的空间。

```
ACC (Abstract Cognitive Container)     ← 本插件（蓝图）
  │  定义"认知容器应该有什么"
  │  9 个内置工具 + 6 个安全 hook
  │
  ├── CCC  home-serenity/              ← 家庭数字系统管理
  ├── CCC  work-project-serenity/       ← 工作项目
  └── CCC  experiment-serenity/         ← AI 实验
```

一个插件，多个容器。每个容器独立，互不干扰。

---

## 它解决了什么

| 问题 | Serenity 怎么解决 |
|------|------------------|
| Agent 误操作外部文件 | 路径硬隔离（P3）——读写只能在这个目录内 |
| Agent 裸跑危险命令 | `msm_exec` 替代裸 bash（D19）——只执行**已注册**的操作 |
| 几周后忘了 Agent 做了什么 | `session` 自动记录每次多步工作——目标、决策、产出物 |
| Agent 的"为什么这样"不可追溯 | EAP 框架驱动每一步决策结构化记录 |
| 用户表达模糊，Agent 瞎猜 | Phase 2 EAP 驱动访谈——帮用户把模糊想法变显式抽象 |

---

## Quick Start

```bash
# 1. 安装插件
npm install @shgroup/opencode-serenity-plugin
npx opencode-serenity-plugin install

# 2. 在任意目录启动 opencode

# 3. 输入 slash command：
/serenity-init
```

TUI 会问你容器名（如 `my-project`）和一句话描述。确认后自动创建完整容器骨架——即刻可用。

```bash
# 也可以用 CLI 初始化
opencode-serenity-plugin init /path/to/my-project \
  --prefix my-project \
  --description "Manages my startup's code, docs, and dev workflow"
```

---

## 演示：创建一个 CCC 的全过程

假设你要管理一个 SaaS 初创项目的软件开发。

### Step 1 — 安装并启动

```bash
npm install @shgroup/opencode-serenity-plugin
npx opencode-serenity-plugin install
cd ~/projects/saas-app
opencode
```

### Step 2 — 告诉 Serenity 你的名字

输入 `/serenity-init`，TUI 弹出对话框：

```
┌─────────────────────────────────────────────┐
│ CCC Name                                     │
│                                               │
│ kebab-case — 只用小写字母、数字和连字符       │
│                                               │
│ █ saas-platform                    [Create]  │
└─────────────────────────────────────────────┘
```

点击 Create，几秒后终端输出：

```
CCC "saas-platform-serenity" created at /home/yh/projects/saas-app
  prefix: saas-platform
  description: A concrete cognitive container (CCC)
  Pre-installed 3 skill(s): compass, session, sqc

Next steps (two-phase init):
  Phase 1 ✅  — CCC skeleton created.
  Phase 2 ⏳  — Restart OpenCode and open /home/yh/projects/saas-app.
     Type anything — your first message will be intercepted
     and the Agent will guide you through a collaborative interview
     to complete the root skill configuration.
```

目录已经生成好了——`AGENT_SESSIONS/`、`docs/`、`.serenity`、3 个预装技能。

### Step 3 — 重启 opencode，进入 Phase 2

你输入：`hi, 帮我设置好这个工作区`

Agent 不会直接回答你——它先进入 EAP 模式，启动协作访谈：

```
Agent:
> 你好！我们正在进入 **Phase 2 初始化**。我先用 EAP 框架
> 帮你把目标从模糊想法变成显式结构。这会让后续所有操作更
> 准确、更可追溯。
>
> **Topic 1 — What is this CCC for? (purpose + team size)**
>
> 这个容器管理什么？一句话告诉我它的目的。

你：
> 管理我们的 SaaS 平台开发——用户端 Web、后端 API、
> 部署脚本和产品文档。

Agent:
> 清楚了。这是 `solo`（仅你）还是 `team`（多人协作）？

你：
> team，核心团队 3 个人都会用。

Agent:
> 好。我记录为 scope: team。
>
> **Topic 2 — Git remote**
>
> 你想设置 Git remote 还是先本地用着？

你：
> 设一个。git@github.com:myco/saas-platform-serenity.git

Agent 调 `cc-git` 设置 remote。

你：
> 其他几个话题我现在还没想好……

Agent:
> 没问题。剩下的我们先用合理默认值，后续任何时间都可以
> 通过修改 SKILL.md 来调整。访谈记录我会保存在
> `docs/phase2-interview-record.md` 里。

Agent 写出完整的 `SKILL.md`，commit，push。CCC 完全就绪。
```

**这就是 Serenity 的工作方式**——不是你填一张问卷，而是 Agent 帮你**把模糊想法变成显式结构**。你可以在任何时候说"我不确定"，Agent 会接受并推动对话向前，而不是卡在问题上死循环。

---

## 双阶段初始化（D1）

以上演示对应两个阶段的技术细节：

### Phase 1 — 骨架创建

你给一个名字，Serenity 创建：

```
my-project-serenity/
├── .serenity                    ← 容器标记："这里是边界"
├── .gitignore
├── opencode.json                ← Agent 配置（clean primary agent）
├── AGENT_SESSIONS/              ← 每一次多步工作自动生成 SESSION.md
├── docs/                        ← 设计方案文档
└── .opencode/
    ├── skills/
    │   ├── my-project-serenity/     ← 根技能（Phase 2 由 Agent 完善）
    │   ├── compass/                 ← 方向判断技能
    │   ├── session/                 ← 会话追踪技能
    │   └── sqc/                     ← 品质循环技能
    └── references/
```

Git 自动 `init → commit → push`（如果你提供了 remote URL）。

### Phase 2 — Agent 驱动访谈

你输入第一句话，Agent 启动 EAP 协作访谈，覆盖：

- **Topic 1** — What is this CCC for? (purpose + team size)
- **Topic 2** — Git remote configured?
- **Topic 3** — What concrete work items will this CCC track?
- **Topic 4** — Collaboration style (casual or structured?)
- **Topic 5** — Any external services or domain-specific skills needed?

访谈结束后，Agent 写出完整的根 `SKILL.md`，这个 CCC 就完全就绪了。

---

## 9 个内置工具

安装后 Agent 直接获得以下能力，不用写一行代码：

### 核心三角

| 工具 | 用途 |
|------|------|
| `msm_list` | 查询当前容器有哪些可执行操作（含描述、flag schema） |
| `msm_exec` | 安全执行已注册的操作。**替代裸 bash**。路径逃逸自动阻断 |
| `msm_admin` | 为容器注册新操作。自动 git commit |

### 文件与容器

| 工具 | 子命令 | 用途 |
|------|--------|------|
| `cc-fs` | `root` `resolve` `exists` `list` `tree` `relative` `mkdir` `rm` `mv` `cp` `touch` `append` | 12 个文件操作，全部限定在容器根目录内。路径逃逸自动阻断 |

### Git（无 bash 依赖）

| 工具 | 子命令 | 用途 |
|------|--------|------|
| `cc-git` | `status` `commit` `push` `log` | Git 高频操作。push 被 non-fast-forward 拒绝时自动输出操作建议。冲突解决走 bash |

### 会话与健康

| 工具 | 子命令 | 用途 |
|------|--------|------|
| `session` | `list` `show` `create` `health` `qa` `archive` `summary` | 会话全生命周期。自动分配 S### ID、snooze 检测、事实核对 |
| `cc-ck` | （无参数） | CCC 三原则健康检查。P1（.serenity 存在）、P2（git 管理）、P3（opencode.json 存在） |

### 认知质量

| 工具 | 用途 |
|------|------|
| `eap` | EAP 理论框架完整内容（渐进式披露）。显式抽象原则——告诉你**怎么想**才能让 Agent 准确执行 |
| `neat` | Neat 设计协作协议。结构化方法——告诉你**怎么对齐**才能让设计方案不走样 |

---

## 4 个安全 Hook（静默运行）

这些 Hook 对用户完全透明，但每一秒都在工作：

| Hook | 做什么 | 触发时机 |
|------|--------|---------|
| Path Isolation (P3) | 读写/编辑/grep 全部限定在 `.serenity` 所在目录 | 每次 Agent 调用文件工具前 |
| Bash降级 (D19) | 禁止裸 `bash`——Agent 必须优先用 `msm_exec` | 每次 Agent 试图调 bash 时 |
| Subagent 继承 | 子 agent 自动继承所有约束（路径、bash、SSH） | 每次 Agent 启动 subagent 时 |
| System Prompt 注入 | 自动向 Agent 注入"你在一个 CCC 中"的上下文 | 每次对话开始时 |

---

## 3 个预装技能

Phase 1 自动安装 3 个标准技能（含可执行 MSM 脚本）：

| 技能 | 做什么 | MSM 工具 |
|------|--------|---------|
| `compass` | 方向判断——3 通道快速评估新任务是否具备推进条件 | `compass-tool validate` / `judge` |
| `session` | 会话追踪——补充 ACC 内置 `session` 工具的容器级操作 | `session-tool reindex`（为历史会话补充 S### ID） |
| `sqc` | 品质循环——按 DC（设计检查）规则扫描所有 skill 质量 | `sqc-tool check` / `report` / `pipeline` |

后续你可以用 `msm_admin` 注册更多 MSM，用 TUI 或 CLI 安装更多技能模板。

---

## 使用场景

Serenity 不绑定任何领域。容器的**形状**取决于你注册什么 MSM、写什么 SKILL.md：

| 场景 | 容器就是 |
|------|---------|
| 管理家庭数字系统（服务器、网络、NAS、智能家居） | 家庭运维中枢 |
| 开发软件项目（需求 → 设计 → 代码 → 测试） | 受控开发环境 |
| 做 AI 实验（跑模型、记录结果、横向对比） | 可复现实验舱 |
| 写字幕、做翻译、处理媒体文件 | 内容工作台 |

Serenity 的**骨架**始终是一样的：边界 + 工具系统 + 会话记录 + 认知质量框架。

---

## 内在哲学：ACC/CCC 模型

如果把 Serenity 比作操作系统：

- **ACC** 是内核——它定义"认知容器应该有什么"（工具、hook、验证规则）。它在不同容器之间共享。
- **CCC** 是用户态工作区——它包含一个具体项目的技能、MSM 注册表、会话记录、项目文件。每个 CCC 独立。

升级插件（`npm update` + `install`），所有 CCC 自动获得新工具和新 guard。因为 ACC 是共享蓝图，CCC 是独立实例。

这套模型的理论基础是 **EAP**（Explicit Abstraction Principle）——"思维的功能价值与其外部可重建性成正比"。Serenity 的每一个设计决策都从这句话推导而来。

日常使用时不需要这些术语。记住"Serenity"就够了。

---

## 进阶

### 注册一个自定义 MSM

Agent 在 CCC 中可以直接注册新操作：

```
msm_admin register --name my-deploy --path .opencode/scripts/my-deploy.ts \
  --description "部署到生产环境" \
  --category mech
```

注册后，`my-deploy` 进入 `mech-registry.json`，Agent 可以用 `msm_exec my-deploy` 调用它。所有操作自动 git commit。

### 安装新技能

```
opencode-serenity-plugin install-skill <skill-name>
```

### 多容器管理

```
/home/yh/
├── sh/
│   └── sh-serenity/      ← 我的私人工作容器
├── work/
│   └── work-serenity/     ← 工作项目容器
└── experiments/
    └── ai-lab-serenity/   ← AI 实验容器
```

同一个插件管理所有容器。每个容器的 Agent 只看到自己的 `.serenity` 边界内的文件。

---

## 开发

```bash
git clone git@github.com:tellmewhattodo/opencode-serenity-plugin.git
cd opencode-serenity-plugin
pnpm install

# 开发循环
pnpm typecheck    # TypeScript 类型检查
pnpm test         # 413+ 测试（vitest）
pnpm build        # 编译 + 复制模板
pnpm install      # 安装到本地 ~/.config/opencode/
```

本 repo 是 **plugin 仓**（GitHub 发布源）。Serenity 根仓（home-serenity）是它的一个 CCC 实例，路径：

```
INFRA/opencode-serenity-plugin/    ← 源码（GitHub）
.opencode/skills/                  ← CCC 实例的技能文件（本地）
```

---

> **版本**: v0.4.3 &nbsp;|&nbsp; **许可**: MIT &nbsp;|&nbsp; **前置**: Node ≥ 20, OpenCode ≥ 1.16
