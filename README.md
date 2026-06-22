# Serenity（宁静号）

> **不是安全沙箱——是认知容器。**

[English](./README.en.md) | 中文

---

> ⚠️ **插件安全性说明**
>
> 本插件（ACC — Abstract Cognitive Container）仅在包含 `.serenity` 标记文件的目录（即 CCC — Concrete Cognitive Container）中**完全激活**。
>
> 在普通项目目录中启动 OpenCode，本插件**不影响任何 OpenCode 原本功能**：
>
> - 不注入系统提示（System Prompt）
> - 不安装路径隔离守卫
> - 不控制 bash 开关
> - 不提供 msm/cc-fs/cc-git/session 等容器工具（工具已注册但无容器上下文，不生效）
> - 不修改 OpenCode 的任何原有行为
>
> 你可以放心全局安装。只有当你**主动进入一个 CCC 目录**时，宁静号的能力才被激活。

---

## 1. 实体定义

### 1.1 实体清单

本系统由 **5 个核心实体** 构成。以下按抽象层级从高到低定义。

#### 实体 A — ACC（Abstract Cognitive Container）

| 属性 | 值 |
|------|-----|
| **定义** | 认知容器的蓝图定义层。它声明"一个认知容器应该具备哪些工具、约束和生命周期规则"。 |
| **类型** | OpenCode 插件（npm 包 `@shgroup/opencode-serenity-plugin`） |
| **存在形式** | 安装至 `~/.config/opencode/plugins/` 的 JavaScript 代码 |
| **激活条件** | OpenCode 启动时自动加载。**完全激活**需要当前工作目录包含 `.serenity` 文件。无 `.serenity` 时所有 hook 静默、所有工具注册但惰性（lazy）。 |
| **去激活条件** | 进入无 `.serenity` 的目录。 |
| **拥有者** | 插件作者（`@tellmewhattodo`）维护。用户通过 `npm update` 升级。 |
| **生命周期** | 安装 → 升级 → 卸载。全局唯一实例。 |
| **依赖** | Node ≥ 20, OpenCode ≥ 1.16 |

#### 实体 B — CCC（Concrete Cognitive Container）

| 属性 | 值 |
|------|-----|
| **定义** | ACC 的一个运行时实例。它是 Agent 与人类在特定领域（项目、运维、实验）中协作的**边界化工作区**。 |
| **类型** | 目录（由 `.serenity` 标记文件标识的目录树） |
| **存在形式** | 文件系统中的一个目录，包含 `.serenity`、`.opencode/skills/`、`AGENT_SESSIONS/`、`docs/`、`opencode.json` |
| **激活条件** | OpenCode 的当前工作目录是 CCC 的根目录（即包含 `.serenity` 的目录）。 |
| **去激活条件** | OpenCode 切换到其他目录。 |
| **创建方式** | `npx opencode-serenity-plugin init <path>` 或 OpenCode 中 `/serenity-init` 命令。 |
| **拥有者** | 用户。用户创建、命名、配置、删除 CCC。 |
| **生命周期** | Phase 1 骨架创建 → Phase 2 Agent 驱动访谈 → 持续使用 → 可选归档。 |
| **依赖** | 依赖 ACC 插件安装在前。ACC : CCC = 1:N。 |

**涉及范围**:

| 范围 | 包含 |
|------|------|
| **范围内** | CCC 根目录及所有子目录。Agent 心智模型（root skill）。AGENT_SESSIONS/ 中的会话记录。.opencode/skills/ 中的技能文档。.opencode/scripts/ 中的 MSM。opencode.json。 |
| **范围外** | CCC 根目录之外的任何文件。宿主系统的全局配置（除 opencode 自身）。其他 CCC 目录内的文件。 |

#### 实体 C — Skill

| 属性 | 值 |
|------|-----|
| **定义** | 面向 Agent 的结构化领域知识封装。它告诉 Agent"在这个领域有哪些实体、规则、操作和边界"。 |
| **类型** | 目录（位于 `.opencode/skills/<skill-name>/`） |
| **必要成分** | `SKILL.md` — 描述存在理由、触发条件、使用方式。可选：`references/`（参考数据）、`scripts/`（MSM 可执行操作）。 |
| **激活条件** | CCC 启动时，Agent 自动加载 `.opencode/skills/` 下所有已安装的 SKILL.md 内容到系统提示。 |
| **创建方式** | 用户要求 Agent 从 SESSION.md 提炼，或手动编写。Phase 1 预装 3 个标准技能（compass、session、sqc）。 |
| **拥有者** | 用户创建和管理。Agent 只在用户指示下操作技能文件。 |
| **依赖** | 依赖 CCC 存在。Skill : CCC = N:1。 |
| **与 MSM 的关系** | Skill 持有 MSM。一个 skill 可以有 0 到多个 MSM 脚本（位于 `scripts/` 子目录）。 |

#### 实体 D — MSM（Mech & Semi-Mech）

| 属性 | 值 |
|------|-----|
| **定义** | 由某个 skill 持有的可执行操作单元。它是 skill 中确定性操作的封装——将常规操作转化为可审计、可编排的接口。 |
| **类型** | 脚本文件（`.ts`、`.js`、`.py`、`.sh`），注册于 `mech-registry.json` |
| **子类型** | **Mech** — 纯 TypeScript 脚本，零 LLM 推理。**Semi-Mech** — TypeScript 框架 + LLM 决策点。 |
| **执行方式** | Agent 通过 `msm_exec <name>` 调用。用户不可直接执行（无 bin 入口）。 |
| **注册方式** | `msm_admin register --name <name> --path <path> --description <desc> --category mech|semi-mech` |
| **激活条件** | MSM 已注册到 `mech-registry.json`。 |
| **拥有者** | Skill 持有者（用户）。MSM : Skill = N:1。 |
| **安全机制** | 所有路径参数自动校验目录逃逸（path-escape guard）。所有调用自动记录到会话日志。 |
| **示例** | `compass-tool validate/judge`（semi-mech，属于 compass skill）、`cc-fs`（mech）、`ssh-connect`（mech） |

#### 实体 E — Session（工作会话）

| 属性 | 值 |
|------|-----|
| **定义** | 一次多步工作的全周期记录。包含目标、关键决策、进度、产出物和未解决问题。 |
| **类型** | 目录（位于 `AGENT_SESSIONS/<YYYY-MM-DD--<desc>>/`），包含 `SESSION.md` |
| **创建方式** | Agent 通过 `session create` 工具自动创建。每次开始多步工作前应创建会话。 |
| **生命周期** | active（进行中）→ closed（已完成）→ archived（归档） |
| **标识符** | 自动分配 S### ID（如 S001、S002） |
| **拥有者** | Agent 按 `session` 工具规范记录。用户阅读和审查。 |
| **依赖** | 依赖 CCC 存在。Session : CCC = N:1。 |

### 1.2 实体关系图

```
ACC (1) ──声明──> CCC (N)
  │                   │
  │                   ├── 包含 Skill (N) ──持有──> MSM (N)
  │                   │
  │                   ├── 包含 Session (N)
  │                   │
  │                   └── 约束 Agent (1)
  │
  └── 提供工具 ──> cc-fs, cc-git, msm_list/exec/admin, session, cc-ck, eap, neat
```

| 关系 | 方向 | 基数 | 依赖 |
|------|------|------|------|
| ACC 声明 CCC | ACC → CCC | 1:N | CCC 必须先安装 ACC |
| CCC 包含 Skill | CCC → Skill | 1:N | Skill 必须先有 CCC 目录 |
| Skill 持有 MSM | Skill → MSM | 1:N | MSM 必须先有 skill 目录 |
| CCC 包含 Session | CCC → Session | 1:N | Session 必须先有 CCC |
| ACC 约束 Agent | ACC → Agent | 1:N | Agent 运行在 CCC 内时受约束 |

---

## 2. 激活模型

### 2.1 激活判定

```
OpenCode 启动
  │
  ├── 当前目录有 .serenity？
  │     ├── 是 → CCC 完全激活
  │     │       ├── Hook: Path Isolation (P3) 激活
  │     │       ├── Hook: Bash Toggle (D19) 激活
  │     │       ├── Hook: Subagent Inheritance 激活
  │     │       ├── Hook: System Prompt Injection 激活
  │     │       ├── 所有工具变为活跃（可操作）
  │     │       └── 技能 SKILL.md 注入 Agent 系统提示
  │     │
  │     └── 否 → 插件静默
  │               ├── Hook: 全部不激活
  │               ├── 工具: 已注册但惰性（调用时返回"无 CCC 上下文"）
  │               └── 对 OpenCode 原生行为零修改
```

### 2.2 Hook 激活矩阵

| Hook | 触发时机 | CCC 内有 .serenity | CCC 外 |
|------|---------|-------------------|--------|
| **Path Isolation (P3)** | 每次 Agent 调用文件工具前 | 读写限定在 `.serenity` 所在目录 | 不激活 |
| **Bash Toggle (D19)** | 每次 Agent 调 bash 时 | `msm_exec` 优先。通过 `/serenity-bash-off`/`/serenity-bash-on` 控制 | 不激活 |
| **Subagent Inheritance** | 每次启动 subagent 时 | Subagent 自动继承路径/bash/SSH 约束 | 不激活 |
| **System Prompt Injection** | 每次对话开始 | 注入"你在一个 CCC 中"上下文 | 不激活 |

---

## 3. 工具系统

### 3.1 工具清单

共 **9 个工具**。安装后 Agent 可直接使用，无需写代码。

| 工具 | 分类 | 子命令 | 用途 |
|------|------|--------|------|
| `msm_list` | 查询 | — | 查询当前 CCC 有哪些可执行 MSM（含描述、flag schema） |
| `msm_exec` | 执行 | — | 安全执行注册 MSM。路径逃逸自动阻断。**替代裸 bash** |
| `msm_admin` | 管理 | `register`、`deregister`、`guide`、`check` | MSM 注册/注销、开发手册、MSM 品质检查。自动 git commit |
| `cc-fs` | 文件 | `root`、`resolve`、`exists`、`list`、`tree`、`relative`、`mkdir`、`rm`、`mv`、`cp`、`touch`、`append` | 12 种文件操作，全部限定在 CCC 根目录内。路径逃逸自动阻断 |
| `cc-git` | Git | `status`、`commit`、`push`、`log`、`pull` | Git 高频操作。push 被 non-fast-forward 拒绝时自动输出建议。冲突解决走 bash |
| `session` | 会话 | `list`、`show`、`create`、`use`、`close`、`health`、`qa`、`archive`、`summary` | 会话全生命周期管理。自动分配 S### ID、stale 检测、事实核对 |
| `cc-ck` | 健康 | 无参数 | CCC 三原则健康检查：P1（.serenity 存在）、P2（git 管理）、P3（opencode.json 存在）。返回 pass/fail 报告 |
| `eap` | 认知质量 | 无参数 | EAP 理论框架渐进式披露。定义认知质量标准（E↑ / R↓ / S↑），指导 Agent 的思考结构 |
| `neat` | 协作 | 无参数 | Neat 设计协作协议方法论。小步对齐、显式决策、文档驱动 |

### 3.2 工具的 CCC 依赖

所有 9 个工具遵循同一规则：
- **CCC 内调用**：正常执行，全部能力可用。
- **CCC 外调用**：工具已注册但调用时返回"当前不在 CCC 上下文中，工具不生效"。

---

## 4. 预装技能

Phase 1 骨架创建时自动安装 3 个标准技能，每个包含可执行 MSM：

| 技能 | 目录 | 存在理由 | MSM 工具 |
|------|------|---------|---------|
| **compass** | `.opencode/skills/compass/` | 方向判断——3 通道快速评估新任务是否具备推进条件。防止在不可行任务上浪费认知资源。 | `compass-tool validate`（验证信号报告）、`compass-tool judge`（综合判断） |
| **session** | `.opencode/skills/session/` | 会话追踪——补充 ACC 内置 session 工具的容器级操作。为历史会话补充 S### ID 索引。 | `session-tool reindex`（为缺少 ID 的历史会话目录分配 S### ID） |
| **sqc** | `.opencode/skills/sqc/` | 品质循环——按 DC（设计检查）规则扫描所有 skill 的质量。防止信息熵增（引用断裂、孤儿技能、模板合规）。 | `sqc-tool check`、`sqc-tool report`、`sqc-tool pipeline`、`msm_admin check`（MSM 品质检查） |

---

## 5. 双阶段初始化（D1）

### 5.1 Phase 1 — 骨架创建

**输入**：用户提供容器名（如 `my-project`）、可选描述。

**输出**：以下目录结构在指定路径自动生成。

```
my-project-serenity/
├── .serenity                    ← 文件类型：容器标记。存在即声明"此目录是 CCC 边界"。
├── .gitignore
├── opencode.json                ← 文件类型：OpenCode Agent 配置。声明干净 primary agent。
├── AGENT_SESSIONS/              ← 目录类型：工作会话存储。每个多步工作自动生成 SESSION.md。
├── docs/                        ← 目录类型：设计方案文档存储。
└── .opencode/
    ├── skills/
    │   ├── my-project-serenity/ ← 根技能。Phase 2 由 Agent 驱动访谈后完善其 SKILL.md。
    │   ├── compass/             ← 预装技能（见第 4 节）
    │   ├── session/             ← 预装技能
    │   └── sqc/                 ← 预装技能
    └── references/
```

**自动操作**：Git `init → commit → push`（如用户提供 remote URL）。

### 5.2 Phase 2 — Agent 驱动访谈

**触发条件**：Phase 1 完成后，用户首次在 CCC 目录中启动 OpenCode 并输入任何消息。

**流程**：Agent 拦截首条消息，不直接回答。进入 EAP 协作访谈模式，依次覆盖以下话题：

| 话题 | 问题 | Agent 输出 |
|------|------|-----------|
| 1 — Purpose | 这个容器管理什么？一句话目的。团队规模（solo/team）。 | 记录 purpose 和 scope 到根 SKILL.md |
| 2 — Git remote | 是否设置 Git remote？ | 如提供 URL，调用 `cc-git` 设置 remote |
| 3 — Work items | 容器追踪哪些具体工作项？ | 记录 work item 清单到知识库 |
| 4 — Collaboration style | 协作风格（casual/structured）？ | 配置 Agent 的回应风格 |
| 5 — External services | 需要哪些外部服务或领域技能？ | 记录集成需求到根 skill |

**完成条件**：Agent 写出完整根 `SKILL.md`，commit，push。CCC 完全就绪。

**失败处理**：用户在任何话题说"不确定"，Agent 使用合理默认值继续，将未完成项记录到 `docs/phase2-interview-record.md`。

---

## 6. CCC 生命周期与最佳实践

### 6.1 飞轮模型

```
具体工作产出决策、约束、领域经验
  → 自动沉淀在 SESSION.md（零操作成本）
  → 用户决定：哪些 know-how 值得提炼为 Skill？
     （提示：工作完成后问 Agent "哪些值得提炼为 skill？"）
  → 提炼为 SKILL.md 后，下次 Agent 自动加载
  → 上下文更完整 → 效率更高 → 更多时间做新工作
  → 飞轮加速
```

### 6.2 知识分层

| 层 | 名称 | 写入者 | 读取者 | 积累成本 |
|----|------|--------|--------|---------|
| **L1 — SESSION** | 默认沉淀层 | Agent（`session create`） | 用户、Agent（追溯时） | 零（自动） |
| **L2 — SKILL.md** | 选择性提炼层 | 用户要求 Agent 写入 | Agent（每次启动自动加载） | 用户判断决定 |
| **L3 — MSM** | 操作封装层 | 用户注册 | Agent（通过 `msm_exec` 调用） | 用户注册决定 |

### 6.3 熵控制

**问题**：知识积累自然带来信息熵增——旧知识过时、新知识重复、约束冲突。

**对策**：SQC（品质循环）按 DC 规则定期扫描所有 skill 质量：

- 自动修复可自动化的问题（引用断裂）
- 标记需人工判断的项（约束冲突、孤儿技能）
- 推荐节奏：**每周一次 `sqc-tool pipeline`**

### 6.4 Skill 提炼示例

| Skill | 封装内容 | 提炼理由 |
|-------|---------|---------|
| **deployment** | CI 命令、环境变量配置、回滚步骤、常见失败原因与修复 | 每次部署重复询问，不如写进 skill 直接可用 |
| **frontend-patterns** | 团队状态管理库选择、API 调用层组织、错误反馈 UI 标准 | Agent 直接生成符合团队风格的代码，无需逐次纠正 |
| **code-review** | 数据库迁移兼容性要求、组件边界规则、安全审查清单 | Agent 提交前自我审查，将低级问题扼杀在 commit 前 |

### 6.5 MSM 操作封装示例

| 操作 | MSM 名 | 理由 | 效果 |
|------|--------|------|------|
| 部署 | `deploy` | 步骤固定（build → test → tag → push → rollout），手动易出错 | Agent 一行命令完成安全部署，错误自动拦截 |
| API 测试 | `api-test` | 冒烟测试、契约测试需重复执行 | Agent 随时执行，结果结构化返回 |
| 代码提交 | `commit` | 特殊 commit 规范（scope 格式、co-author、issue 链接） | Agent 自动遵守规范 |
| 迁移检查 | `migrate-check` | 上线前必须检查迁移脚本向下兼容性 | Agent 自动分析，标记破坏性变更 |

---

## 7. 为什么叫 Serenity

电影 *Serenity* 里有一艘飞船。不大，不新，但可靠。它在宇宙里飞，不可能知道所有星球，但它有自己的船舱和航道。船员不知道每个货舱装了什么，但需要的时候总能拿到。

CCC 就是这样工作的：不是追求全知，是追求可达。信息堆在那，一直在变，没有人能全部掌握——但船不需要掌握全宇宙，在自己的航线上飞好就够了。

---

## 8. 内在哲学：ACC/CCC 模型

如果把 Serenity 比作操作系统：

- **ACC 是内核**——声明"认知容器应该有什么"（工具、hook、验证规则）。在不同容器间共享。
- **CCC 是用户态工作区**——包含具体项目的技能、MSM 注册表、会话记录、项目文件。每个 CCC 独立。

升级插件（`npm update` + `install`），所有 CCC 自动获得新工具和新 guard——因为 ACC 是共享蓝图，CCC 是独立实例。

这套模型的理论基础是 **EAP**（Explicit Abstraction Principle）——"The functional value of a thought is proportional to its external reconstructability."（思维的功能价值与其外部可重建性成正比。）Serenity 的每一个设计决策都从这句话推导而来。

完整 EAP 理论见：<https://github.com/tellmewhattodo/theory-eap>

---

## 9. 快速开始

### 9.1 安装

```bash
npm install @shgroup/opencode-serenity-plugin
npx opencode-serenity-plugin install
```

### 9.2 创建 CCC

在任意目录启动 OpenCode，输入 `/serenity-init`。TUI 询问容器名和描述，自动创建完整容器骨架。

或使用 CLI：

```bash
opencode-serenity-plugin init /path/to/my-project \
  --prefix my-project \
  --description "Manages my startup's code, docs, and dev workflow"
```

### 9.3 完成初始化

重启 OpenCode，输入任何消息。Agent 自动进入 Phase 2 访谈。访谈完成后 CCC 完全就绪。

---

## 10. 多容器管理

一个插件管理所有容器。每个 CCC 在独立目录中，互不干扰：

```
~/projects/
├── saas-app/          ← CCC: SaaS 开发
├── ops-tools/         ← CCC: 运维工具
└── ai-lab/            ← CCC: AI 实验
```

同一 OpenCode 会话中，Agent 只能访问当前工作目录所在 CCC 的文件。

---

## 11. 开发

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

## 12. 使用场景

Serenity 不绑定任何领域。容器的**形状**取决于注册什么 MSM、写什么 SKILL.md：

| 场景 | 容器就是 | 典型 MSM |
|------|---------|---------|
| 开发软件项目（需求 → 设计 → 代码 → 测试） | 受控开发环境 | `deploy`、`api-test`、`commit`、`migrate-check` |
| 管理服务器、网络、NAS、智能家居 | 运维中枢 | `ssh-connect`、`health-check`、`backup` |
| AI 实验（跑模型、记录结果、对比） | 可复现实验舱 | `train`、`evaluate`、`compare` |
| 处理媒体文件、写文档、做翻译 | 内容工作台 | `transcribe`、`translate`、`publish` |

---

> **版本**: v0.4.13 &nbsp;|&nbsp; **许可**: MIT &nbsp;|&nbsp; **前置**: Node ≥ 20, OpenCode ≥ 1.16
>
> **平台要求**: Serenity 在 OpenCode CLI（终端版）、Linux 桌面和 macOS 上完成测试验证。**Windows 未经测试，不保证正常使用。**
>
> **EAP 理论完整版**: <https://github.com/tellmewhattodo/theory-eap>
