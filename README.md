# Serenity（宁静号）

> **不是安全沙箱——是认知容器。**

[English](./README.en.md) | 中文

---

> ⚠️ **安全说明**
>
> 本插件仅在包含 `.serenity` 标记文件的目录中完全激活。在其他目录中启动 OpenCode，它对 OpenCode 的原生行为**零影响**：
>
> - 不注入系统提示
> - 不安装路径隔离
> - 不控制 bash
> - 不激活任何工具
>
> 可放心全局安装。只有当你**主动进入一个 CCC 目录**时，宁静号才唤醒。

---

## 你遇到了什么问题

你使用 AI 编码助手。每次对话它都表现很好——但下次对话它什么都不记得。你要一遍遍重复上下文：

- "这个项目用 React + Vite..."
- "我们的命名规范是 camelCase..."
- "部署步骤是先 build 再 scp 到服务器..."

决策丢失。约定遗忘。每次从零开始。

**因为你没有一个让 Agent 持续记忆的系统。**

---

## 快速开始

你需要两样东西：Node ≥ 20 和 OpenCode ≥ 1.16。

```bash
npm install @shgroup/opencode-serenity-plugin
npx opencode-serenity-plugin install
```

然后打开 OpenCode，进入你想长期工作的目录，输入：

```
/serenity-init
```

TUI 会问你容器名称和描述。回答几个问题就完成了。

或者用 CLI：

```bash
opencode-serenity-plugin init /path/to/my-project \
  --prefix my-project \
  --description "管理我的 SaaS 项目代码、文档和开发流程"
```

**从安装到完成，不到一分钟。**

---

## 发生了什么事

你刚刚告诉 OpenCode："这个目录是我的工作区，记住它。"

插件在这个目录里创建了一个 `.serenity` 标记文件，以及配套目录结构：

```
my-project-serenity/
├── .serenity              ← 标记：此目录是 CCC 边界
├── opencode.json          ← OpenCode Agent 配置
├── AGENT_SESSIONS/        ← 工作会话自动存储
├── docs/                  ← 设计方案文档
└── .opencode/
    ├── skills/            ← 领域知识（初始包含 3 个预装技能）
    └── references/
```

这个带 `.serenity` 标记的目录叫做 **CCC**（Concrete Cognitive Container）——具体认知容器。

翻译成大白话：**一个有边界的、有记忆的工作区。**

- Agent 只能读写这个目录里的文件（不会跑出去乱翻你的系统）
- 每次对话的决策、约定、约束自动记录
- 你可以把领域知识写成 Skill，下次对话 Agent 自动加载

重启 OpenCode，输入任何消息。Agent 会进入一轮简短访谈（Phase 2），了解你的项目目的、Git 地址、工作项。访谈完成后，CCC 完全就绪。

---

## 这些工具从哪来的

`/serenity-init` 能工作，是因为你安装了一个插件。

这个插件是 **ACC**（Abstract Cognitive Container）——抽象认知容器。

| 名词 | 一句话 |
|------|--------|
| **ACC** | 你安装的 npm 包。它定义了"认知容器应该有哪些工具和规则"。全局只有一个。 |
| **CCC** | 你创建的带 `.serenity` 的目录。它是 ACC 的运行时实例。你可以有多个。 |

就好像：
- **ACC** 是手机的出厂系统——定义了"手机应该能打电话、能装 App"
- **CCC** 是你的手机——具体装了什么 App、设了什么壁纸、联系人有哪些

升级插件（`npm update`），所有 CCC 自动获得新工具和新功能。因为 ACC 是共享蓝图，CCC 是独立实例。

---

## 你现在有哪些工具

安装后你获得 **9 个工具**，按设计目的分为四组。

### 安全的执行通道

裸 bash 不可记录、不可审计、容易越界。MSM（Mech & Semi-Mech）框架将常用操作注册为可执行单元，通过统一的安全通道执行。

- **`msm_list`** — 查看当前 CCC 注册了哪些 MSM，以及它们的参数。
- **`msm_exec`** — 安全执行 MSM。路径逃逸自动阻断。**优先于 bash 使用。**
- **`msm_admin`** — 注册/注销 MSM。`register` 自动 git commit。`guide` 查看开发手册。`check` 运行品质检查。

### 边界内的日常操作

CCC 有明确的目录边界。Agent 对文件系统和版本控制的一切操作都限定在这个边界内。

- **`cc-fs`** — 15 种文件操作（`root` / `resolve` / `exists` / `list` / `tree` / `relative` / `mkdir` / `rm` / `mv` / `cp` / `touch` / `append` / `reveal` / `info` / `find`），全部路径逃逸自动阻断。
- **`cc-git`** — 高频 Git 操作：`status` / `commit` / `push` / `log` / `pull`。非快进推送自动输出建议，冲突解决走 bash。
- **`cc-ck`** — 无参数。三原则健康检查：.serenity 存在？Git 管理？配置完整？

### 跨对话的工作记忆

每次新对话 Agent 从零开始。会话系统把决策、进度、未解决问题沉淀为可追溯的记录。

- **`session`** — `create` / `use` / `close` / `list` / `show` / `summary` / `archive` / `health` / `qa`。Agent 自动创建会话，自动记录决策，对话压缩或重启后仍可恢复上下文。

### 思维质量框架

这两个工具不操作文件——它们提升 Agent 思考本身的品质。

- **`eap`** — 认知质量框架。定义 E↑ / R↓ / S↑ 标准，指导每一次输出的外部可重建性。
- **`neat`** — 设计协作协议。小步对齐、显式决策、文档驱动，确保复杂设计的每一步可追溯。

---

## 知识怎么增长

最关键的：**你不必手动管理知识。知识在工作过程中自然增长。**

```
你工作→产生决策、约束、领域经验
  → 自动沉淀在 SESSION.md（零操作成本）
  → 你判断哪些值得提炼为 Skill
  → 提炼为 SKILL.md 后，Agent 每次启动自动加载
  → 上下文更完整 → 效率更高 → 更多时间做新工作
  → 飞轮加速
```

这是知识的三层结构：

| 层 | 名称 | 谁写入 | 谁读取 | 积累成本 |
|----|------|--------|--------|---------|
| **L1 — Session** | 默认沉淀层 | Agent（自动） | 你 + Agent（追溯时） | 零 |
| **L2 — Skill** | 选择性提炼层 | 你要求 Agent 写入 | Agent（每次启动自动加载） | 你判断成本 |
| **L3 — MSM** | 操作封装层 | 你注册 | Agent（通过 msm_exec） | 你注册成本 |

工作完成后，问 Agent 一句："哪些值得提炼为 skill？"——就够了。

---

## 安全机制

以下几个安全机制自动生效，你不需要操心它们。

**路径隔离（P3）：** Agent 对文件系统的一切读写限定在 CCC 根目录内。它不会跑出去改你的系统文件。

**Bash 控制（D19）：** 默认首选 `msm_exec`（有路径逃逸检查），而非裸 bash。可以通过 `/serenity-bash-off` 和 `/serenity-bash-on` 控制。

**Subagent 继承：** Agent 启动的子 Agent 自动继承全部约束——不可能通过子 Agent 绕过安全规则。

---

## 质量保障

知识积累久了，自然会熵增——旧知识过时、新知识重复、约束冲突。

**SQC（品质循环）** 定期扫描所有 Skill 的质量：

- 自动修复可自动化的问题（引用断裂）
- 标记需要人工判断的项（冲突、孤儿技能）
- 推荐节奏：每周一次 `sqc-tool pipeline`

---

## 为什么叫 Serenity

电影《宁静号》（*Serenity*）里有一艘飞船。不大，不新，但可靠。它在宇宙里飞，不可能知道每颗星球，但它有自己的船舱和航道。船员不知道每个货舱装了什么，但需要的时候总能拿到。

CCC 就是这样工作的：不是追求全知，而是追求可达。

---

## 内在哲学

这套模型的理论基础是 **EAP**（显式抽象原则，Explicit Abstraction Principle）：

> **"思维的功能价值与其外部可重建性成正比。"**
> The functional value of a thought is proportional to its external reconstructability.

Serenity 的每一个设计决策都从这句话推导而来。你在 README 里读到的每个概念——ACC、CCC、Skill、MSM、Session——都是这个原则在不同层面的具体化。

把 Serenity 比作操作系统：

- **ACC 是内核**——声明认知容器应该有什么工具、规则、验证
- **CCC 是用户态工作区**——包含具体项目的技能、MSM、会话记录、项目文件

升级内核，所有用户态工作区自动受益。

完整 EAP 理论：<https://github.com/tellmewhattodo/theory-eap>

---

## 多个容器

一个插件管理所有容器。每个 CCC 在自己的目录中，互不干扰：

```
~/projects/
├── saas-app/          ← CCC: SaaS 开发
├── ops-tools/         ← CCC: 运维工具
└── ai-lab/            ← CCC: AI 实验
```

同一 OpenCode 会话中，Agent 只能访问当前工作目录所属 CCC 的文件。

---

## 开发与贡献

```bash
git clone git@github.com:tellmewhattodo/opencode-serenity-plugin.git
cd opencode-serenity-plugin
pnpm install

pnpm typecheck    # TypeScript 类型检查
pnpm test         # 413+ 测试（vitest）
pnpm build        # 编译 + 复制模板
pnpm install      # 安装到本地 ~/.config/opencode/
```

---

## 最近更新

### v0.5.29 — 🧠 Todo 列表自动显示当前工作会话

激活一个工作会话后，Agent 创建的每条 todo 列表顶部都会自动出现当前会话的标识，一眼就知道"现在在哪个会话里干活"。这个标识项已完成状态显示，不会跟待办任务混在一起。

### v0.5.28 — 📋 切换会话后，Agent 立即知道该做什么

以前切换到会话后，Agent 可能过一会儿才"反应过来"。现在只要切过去，它立刻就知道：去读 SESSION.md、同步 todo、往进度记录里记东西。

### v0.5.27 — 🔗 会话进度和 todo 自动同步

激活工作会话后，Agent 会自动读取当前 SESSION.md，把里面的待办拆成 OpenCode 内置的 todo 条目。一件事完成了、进度更新了，两边同时记录，不用操心哪个才是最新的。

### v0.5.26 — 💬 Agent 的"脑内指令"写得更清楚了

Agent 每次思考前，插件会在它的系统提示里注入约束规则（哪些文件能碰、用哪个命令工具、怎么管理会话）。这次把 4 块提示词全部用完整 EAP 理论重写了一遍——逻辑更清晰，歧义更少，Agent 理解起来不再靠"猜"。

### v0.5.24 ~ v0.5.25 — 📚 `eap` 和 `neat` 现在是完整版了

之前这两个工具给的内容是精简版。现在跟理论仓库同步，拿到了完整 6 章论文（含语言接口分析、词汇辨析、英式中文指南、数学证明）和完整的 Neat 内容架构章（含论文写作、翻译规范等 11 条实战经验）。在对话框里直接问 `eap` 或 `neat` 就能看到全貌。

### v0.5.22 — 🔄 让 loop 跑起来后，能在 TUI 看到进度了

以前 loop 在后台跑，你不知道它干到哪了。现在每轮完成都会弹一个 toast 通知："第 3 轮完成"、"✅ 任务完成"、"❌ 任务失败"。不用切出去看进度文件了。

---

> **版本**: v0.5.29 &nbsp;|&nbsp; **许可**: MIT &nbsp;|&nbsp; **前置**: Node ≥ 20, OpenCode ≥ 1.16
