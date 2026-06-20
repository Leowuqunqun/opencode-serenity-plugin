# Serenity（宁静号）

> **不是安全沙箱——是认知容器。**

---

## 什么是宁静号

宁静号（Serenity）是一个**认知基础设施**（Cognitive Infrastructure）——不是一个编码辅助工具，不是一个项目管理系统，也不是一个 AI Agent 平台。

它是 Agent 与人类在认知层面协作的工作空间。

### 它在解决什么问题

当前 AI Coding Agent 的核心困境：Agent 很聪明，但每次对话都是从零开始。它不知道你做过什么决策、积累了哪些知识、遵守什么约束。上下文窗口一关，一切归零。

**宁静号的回答**：不是给 Agent 更大的上下文窗口——而是给它一个**持续积累知识的容器**。

```
ACC (Abstract Cognitive Container)     ← 本插件（认知容器的蓝图定义层）
  │  ─ 工具系统（cc-fs, cc-git, session, msm）
  │  ─ 安全约束（P1/P2/P3 根目录三原则）
  │  ─ 认知质量框架（EAP + Neat）
  │  ─ 会话全周期追踪
  │
  ├── CCC my-project-serenity/         ← 认知容器实例（运行在项目上）
  ├── CCC my-ops-serenity/             ← 认知容器实例（运行在运维环境上）
  └── CCC my-experiment-serenity/      ← 认知容器实例（运行在实验上）
```

一个 ACC，任意数量的 CCC。每个 CCC 独立、互不干扰、各自积累领域知识。

### 为什么它改变了游戏规则

传统工作流中，Agent 是**编码协作者**（Coding Agent）——你描述需求，它生成代码，但每次对话的认知上下文被模型上下文窗口锁定。

在宁静号中，Agent 与人的协作**上升到了认知层面**（Cognitive-level Collaboration）：

| 维度 | Coding Agent | 宁静号（Serenity） |
|------|-------------|-------------------|
| 上下文来源 | 模型上下文窗口（一次性） | **CCC 内持续积累的知识**（会话记录、skill 文档、设计文档、MSM 注册表） |
| 知识持久化 | 不持久 — 窗口关闭即丢失 | **结构化的外部编码** — 决策记录在 SESSION.md，领域知识编码在 SKILL.md |
| 模型能力需求 | 依赖模型自身的隐式知识 | **降低** — 领域知识已显式编码，模型只需执行而非记忆 |
| 产出质量 | 受限于上下文窗口内的信息量 | **大幅提升** — Agent 始终访问完整的领域上下文 |
| 可追溯性 | 无 | **全周期可追溯** — 每次决策都有记录、理由、产出物 |
| 协作层级 | 代码层（需求→代码） | **认知层**（目标→决策→结构→产出） |

**核心事实**：使用 ACC 约束产生的 CCC 宁静号，可以在同等工作中以知识的收集和积累降低上下文耗用，从而使得对模型能力要求降低，产出和效率大幅提升。其本质是：相比于 Coding Agent，Agent 与人的协作上升到了认知层面。

---

## 快速上手能解决的问题

| 问题 | 宁静号怎么解决 |
|------|----------------|
| Agent 误操作外部文件 | 路径硬隔离（P3）——读写只能在这个容器根目录内 |
| Agent 裸跑危险命令 | `msm_exec` 替代裸 bash（D19）——只执行**已注册**的操作 |
| 几周后忘了 Agent 做了什么 | `session` 自动记录每次多步工作——目标、决策、产出物 |
| Agent 的"为什么这样"不可追溯 | EAP 框架驱动每一步决策结构化记录 |
| 用户表达模糊，Agent 瞎猜 | Phase 2 EAP 驱动访谈——帮用户把模糊想法变显式抽象 |

---

## 使用场景

Serenity 不绑定任何领域。容器的**形状**取决于你注册什么 MSM、写什么 SKILL.md：

| 场景 | 容器就是 |
|------|---------|
| 开发软件项目（需求 → 设计 → 代码 → 测试） | 受控开发环境 |
| 管理服务器、网络、NAS、智能家居 | 运维中枢 |
| 做 AI 实验（跑模型、记录结果、横向对比） | 可复现实验舱 |
| 处理媒体文件、写文档、做翻译 | 内容工作台 |

Serenity 的**骨架**始终是一样的：边界 + 工具系统 + 会话记录 + 认知质量框架。

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
CCC "saas-platform-serenity" created at ~/projects/saas-app
  prefix: saas-platform
  description: A concrete cognitive container (CCC)
  Pre-installed 3 skill(s): compass, session, sqc

Next steps (two-phase init):
  Phase 1 ✅  — CCC skeleton created.
  Phase 2 ⏳  — Restart OpenCode and open ~/projects/saas-app.
     Type anything — your first message will be intercepted
     and the Agent will guide you through a collaborative interview
     to complete the root skill configuration.
```

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

## 内在哲学：ACC/CCC 模型

如果把 Serenity 比作操作系统：

- **ACC** 是内核——它定义"认知容器应该有什么"（工具、hook、验证规则）。它在不同容器之间共享。
- **CCC** 是用户态工作区——它包含一个具体项目的技能、MSM 注册表、会话记录、项目文件。每个 CCC 独立。

升级插件（`npm update` + `install`），所有 CCC 自动获得新工具和新 guard。因为 ACC 是共享蓝图，CCC 是独立实例。

这套模型的理论基础是 **EAP**（Explicit Abstraction Principle）——"思维的功能价值与其外部可重建性成正比"。Serenity 的每一个设计决策都从这句话推导而来。

日常使用时不需要这些术语。记住"Serenity"就够了。

---

## 什么是 MSM（Mech & Semi-Mech）

MSM 是**属于某个 skill 的可执行操作单元**。它不是独立工具——每个 MSM 被一个 skill 持有：

```
skill（领域知识封装）
  ├── SKILL.md（文档：描述存在意义、触发条件、使用方式）
  ├── references/（辅助参考）
  └── scripts/（MSM 脚本：可执行操作）
           │
           └── 示例：compass-tool validate/judge
                （属于 compass skill，验证 3 通道信号报告）
```

MSM 分两类：

| 类别 | 含义 | 示例 |
|------|------|------|
| **Mech** | 纯 TS 脚本，零 LLM 推理 | `cc-fs`、`cc-git`、`ssh-connect` |
| **Semi-Mech** | TS 框架 + LLM 决策点 | `session-tool qa`、`sqc-tool pipeline` |

MSM 的核心价值：**确定性 + 可审计**。LLM 用 `msm_exec` 调用 MSM，所有路径参数自动校验逃逸、所有操作自动可追溯。

---

## CCC 生命周期最佳实践

### 飞轮效应：知识的自然沉淀与选择性提炼

一个 CCC 不是一次性创建的——它在持续使用中自然积累：

```
具体工作产出决策、约束、领域经验
  → 自动沉淀在 SESSION.md（零操作成本）
  → 用户自主决定：哪些 know-how 值得提炼为 Skill？
     （最方便的方式：工作完成后问 Agent：
      "哪些 know-how 值得提炼为宁静号的 skill？"）
  → 提炼为 SKILL.md 后，下次 Agent 自动加载
  → 上下文更完整 → 效率更高 → 更多时间做新工作
  → 飞轮加速
```

**关键设计**：知识积累由用户掌控，而非自动推送。

- SESSION 是**默认沉淀层**——每次多步工作的目标、决策、产出物自动记录在这里，零操作成本
- Skill 是**选择性提炼层**——只有你确认有价值的结构化知识才提炼为 skill
- Agent 只做建议，不做决定：你可以随时问"今天的工作有哪些值得提炼"——Agent 会从 SESSION 中提取候选，你来判断

### Skill 实例：全栈工程师如何提炼

假设你是一个 React + Java 全栈开发者。你的项目已经运行了一段时间，你和 Agent 有过几十次协作。以下是一些你可能会从工作中提炼出来的 skill：

| Skill | 它封装了什么 | 你为什么会提炼它 |
|-------|-------------|----------------|
| **deployment** | 部署流程的完整知识：用哪些 CI 命令、环境变量怎么配、回滚步骤、常见失败原因和修复方式 | 每次部署都问 Agent 同样的问题，不如写进 skill——下次直接可用 |
| **frontend-patterns** | 你们团队的 React 约定：用哪个状态管理库、API 调用层怎么组织、错误反馈的 UI 标准 | 新需求来的时候 Agent 直接生成符合团队风格的代码，不再需要每次纠正 |
| **backend-api** | Java 后端的 API 设计规范：URL 命名风格、统一响应格式、异常处理层级、分页规范 | Agent 生成的 API 代码直接符合团队约定，review 通过率大幅提升 |
| **code-review** | 你们特别关注的审查点：数据库迁移的兼容性要求、前端组件边界规则、安全审查清单 | Agent 提交代码前自我审查一遍，把低级问题扼杀在 commit 之前 |

每个 Skill = 一份 **SKILL.md**（写给 Agent 看的文档，描述领域知识、规则和场景）+ 可选的 **MSM** 脚本（可执行的操作）。提炼过程很简单：

```
会话中积累的知识（SESSION.md）
  → 你问 Agent："哪些值得提炼？"
  → Agent 从 SESSION 提取候选
  → 你判断：这个确实重要 → 写成 SKILL.md
  → 下次 Agent 自动加载，就像团队新成员读了入职文档
```

### MSM 实例：把常规操作变成可审计的自动化

Skill 封装知识，MSM 封装操作。同一个全栈工程师的项目，可以 MSM 化的操作：

| 操作 | 为什么 MSM 化 | 效果 |
|------|--------------|------|
| **部署** (`deploy`) | 部署步骤固定（build → test → tag → push → rollout），但每次手动敲容易出错 | Agent 一行命令完成安全部署，错误自动拦截 |
| **API 测试** (`api-test`) | 冒烟测试、契约测试、回归测试需要重复执行 | Agent 随时执行，结果结构化返回，CI 之外的补充验证层 |
| **代码提交** (`commit`) | 项目有特殊的 commit 规范（scope 格式、co-author、issue 链接） | Agent 自动按规范提交，不再出现"fix bug"这类无意义信息 |
| **数据库迁移检查** (`migrate-check`) | 上线前必须检查迁移脚本的向下兼容性 | Agent 自动分析迁移脚本，标记破坏性变更 |

这些都是 Mech（纯脚本，零 LLM 推理）——一旦注册，Agent 用 `msm_exec deploy` 即可调用，所有路径参数自动校验逃逸，全部操作可审计可追溯。

**更进一步的想象**：当你的项目中部署、测试、提交、lint、发布等所有常规操作都 MSM 化了，这些 MSM 的组合就构成了一个**自然的 Harness**——一个可编排、可观测、可约束的操作层。Agent 不再需要猜测"怎么部署"——它在 Harness 中工作，只调用你授权的操作。

这正是 D19（bash/msm 风险分级）的实践落地：不安全的手动操作逐步被安全的 MSM 取代，不是靠禁令，而是靠提供更好的替代品。

### 用 SQC 控制信息熵增

知识积累会自然带来信息熵增——旧知识过时、新知识重复、约束冲突。SQC（品质循环）定期扫描所有 skill 质量（引用断裂、孤儿技能、模板合规等），自动修复可自动化的问题，标记需人工判断的项。推荐节奏：**每周一次 `sqc-tool pipeline`**。

---

## 双阶段初始化（D1）

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

Agent 在 CCC 中可以直接注册自定义 MSM：

```
msm_admin register --name my-deploy --path .opencode/scripts/my-deploy.ts \
  --description "部署到生产环境" \
  --category mech
```

注册后，`my-deploy` 进入 `mech-registry.json`，Agent 可以用 `msm_exec my-deploy` 调用它。

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

后续你可以用 `msm_admin` 注册更多 MSM，安装更多技能模板。

---

## 多容器管理

同一个插件管理所有容器：

```
~/projects/
├── saas-app/          ← SaaS 开发容器
├── ops-tools/         ← 运维工具容器
└── ai-lab/            ← AI 实验容器
```

每个容器的 Agent 只看到自己的 `.serenity` 边界内的文件。互不干扰，各自积累。

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

---

> **版本**: v0.4.3 &nbsp;|&nbsp; **许可**: MIT &nbsp;|&nbsp; **前置**: Node ≥ 20, OpenCode ≥ 1.16