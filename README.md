# opencode-serenity-plugin

> **v0.1.0** (2026-06-15) — Serenity 认知基础设施的 [OpenCode](https://github.com/open-code-ai/opencode) 平台插件层。
>
> 提供 MSM 工具调用框架（`msm_list` / `msm_exec` / `msm_admin`）、
> 安全文件系统操作（`file_system`）、会话管理（`session_tool`），
> 以及 TUI slash command（`/serenity-init`、bash 开关）。
>
> 远程仓库：[github.com/tellmewhattodo/opencode-serenity-plugin](https://github.com/tellmewhattodo/opencode-serenity-plugin)

---

## 安装

### 前置条件

| 条件 | 要求 |
|------|------|
| Node.js | >= 20 |
| 包管理器 | pnpm |
| OpenCode 版本 | >= 1.16 |

### 标准安装流程（推荐）

```bash
# 场景 A：从零克隆
git clone git@github.com:tellmewhattodo/opencode-serenity-plugin.git
cd opencode-serenity-plugin

# 场景 B：宁静号工作空间内（已位于 AI_LAB/ 下）
# cd AI_LAB/opencode-serenity-plugin
# 选择上述任一场景后继续：

pnpm install                # 安装依赖
pnpm build                  # 编译 TypeScript → dist/
npx opencode-serenity-plugin install   # 自动写入项目 + 全局配置
```

`install` 命令的结果：

| 配置目标 | 写入位置 | 作用 |
|---------|----------|------|
| 项目级 | 当前目录 `opencode.json` | 注册 5 个自定义工具（`msm_list` / `msm_exec` / `msm_admin` / `file_system` / `session_tool`） |
| 全局级 | `~/.config/opencode/tui.json` | 注册 slash command（`/serenity-init`、`/serenity-bash-on/off/status`） |

### 手动配置

当 `install` 命令不可用或不适用时，手动编辑：

```jsonc
// opencode.json（项目根）
{
  "plugin": [
    "file:///absolute/path/to/opencode-serenity-plugin/dist/index.js"
  ]
}

// ~/.config/opencode/tui.json（全局，slash command 可见性）
{
  "plugin": [
    "file:///absolute/path/to/opencode-serenity-plugin/dist/tui.js"
  ]
}
```

### 快速验证

插件加载后在 opencode 中查询：

```
msm_list
```

期待输出包含以下注册项：

| 名称 | 技能 | 类别 | 描述 |
|------|------|------|------|
| `msm_list` | serenity-plugin | mech | List all available MSM |
| `msm_exec` | serenity-plugin | mech | Execute a registered MSM |
| `msm_admin` | serenity-plugin | mech | Register or deregister an MSM |
| `file_system` | serenity-plugin | mech | Serenity file-system utility |
| `session_tool` | serenity-plugin | semi-mech | Session lifecycle management |

### 开发期快速迭代

修改源码后不需要重复 clone：

```bash
pnpm build                    # 仅编译
npx opencode-serenity-plugin install   # 重新写入配置
# 或使用 serenity-plugin-develop-kit MSM 自动执行 typecheck → test → build → install
```

---

## 功能清单

### 5 个 OpenCode 自定义工具

| 工具名 | 类别 | 职责 |
|--------|------|------|
| `msm_list` | mech | 查询 `mech-registry.json`，列出所有已注册 MSM 及其描述。`msm_exec` 的前置查询步骤。 |
| `msm_exec` | mech | 执行已注册 MSM。参数 `msm_name` + `args: string[]`。替代裸 bash 的安全命令入口。 |
| `msm_admin` | mech | 注册/注销 MSM。单 tool + `action` enum（`register` / `deregister`）。注册表变更自动 git commit。 |
| `file_system` | mech | 安全文件系统操作。10 个子命令：`root` / `resolve` / `exists` / `list` / `relative` / `mkdir` / `rm` / `mv` / `cp` / `touch`。所有写操作限制在 `.serenity` 根目录内，保护 `.serenity` 标记文件和根目录自身不被删除。 |
| `session_tool` | semi-mech | 会话生命周期管理。7 个子命令：`list` / `show` / `create` / `health` / `archive` / `summary` / `qa`。管理 `AGENT_SESSIONS/` 目录下的会话记录。 |

### 系统 Hook

| Hook 名 | 执行时机 | 职责 |
|---------|----------|------|
| `tool.execute.before` | 每个工具调用前 | 路径守卫：`read`/`edit`/`write`/`grep`/`glob`/`webfetch` 的 `path` 参数强制在 `cwdRoot` 内（含 symlink 防御）。bash 静默拒绝开关：被禁用时 AI 收到 `"bash is disabled by user, use msm instead"`。 |
| `experimental.chat.system.transform` | 新 session 首次激活 | 注入 `/.opencode/skills/<实例名>/SKILL.md` 全文到 system prompt 末尾。 |
| `experimental.session.compacting` | 压缩事件 | 注入 serenity 关键状态（实例名、路径、激活状态）。 |
| `experimental.tool.definition` | 工具定义阶段 | 向 `task` 工具描述注入精简 serenity context（使 subagent 也能感知 serenity 环境）。 |
| `shell.env` | shell 执行前 | 注入环境变量 `HOME_SERENITY_ROOT`（实例根路径）、`SERENITY_INSTANCE`（实例名）。 |
| `event: permission.asked` | 权限弹窗触发时 | cwdRoot 内文件操作自动回复 `always`。 |

### TUI Slash Command

| 命令 | 作用 |
|------|------|
| `/serenity-init` | 将当前 git 仓库初始化为 serenity 实例：创建 `/.serenity` + `git commit -m "chore: initialize serenity (instance: <name>)"`。 |
| `/serenity-bash-on` | 启用 bash 工具。 |
| `/serenity-bash-off` | 禁用 bash 工具。AI 对 bash 的任何调用收到 `"bash is disabled by user, use msm instead"` 错误。 |
| `/serenity-bash-status` | 显示当前 bash 启用/禁用状态。 |

---

## 开发指南

### 标准开发循环

```bash
pnpm typecheck             # 编译检查，零 LLM 推理
pnpm test                  # 执行全部 382 个测试（vitest）
pnpm build                 # 编译到 dist/
pnpm opencode-serenity-plugin install   # 安装到当前 project
```

推荐使用 `serenity-plugin-develop-kit` MSM 工具自动执行上述 4 步（typecheck → test → build → install），遇非零即停，提供完整审计可追溯性。

### 测试架构

```bash
pnpm test                          # 全部 382 个测试
pnpm test -- --watch               # 监视模式
pnpm test tests/msm.test.ts        # 单文件测试
```

测试文件按模块分组于 `tests/`：

| 文件 | 用例数 | 覆盖范围 |
|------|--------|---------|
| `tests/msm.test.ts` | — | MSM 工具（list/exec/admin） |
| `tests/fs-file-system-tool.test.ts` | 40 | 全部 10 个文件系统子命令 + 安全边界 |
| `tests/util-*.test.ts` | — | 各 util 函数（init / serenity-file / log 等） |
| `tests/session-*.test.ts` | — | 会话管理各子命令 |
| `tests/hooks/*.test.ts` | — | Hook 行为（permission-guards / compacting / 
tool-definition / auto-reply） |
| `tests/tui*.test.ts` | — | TUI slash command |
| `tests/errors.test.ts` | — | 错误类层级 |

---

## 架构模型：Template-Instance

```
opencode-serenity-plugin     ← template（持久源，source of truth）
         ↓ build + install
serenity 实例目录（如 home-serenity/） ← instance（可重建的下游 artifact）
```

| 角色 | 特征 |
|------|------|
| **template**（plugin 仓） | durable，不可替代，GitHub 发布源 |
| **instance**（serenity 目录） | replicable，可删除后重新 build + install |
| **关系** | 单向模板→实例。不存在"双真源防漂移"。修改 plugin 后必须重新 build + install。 |

---

## 关联文档

| 主题 | 文档路径 |
|------|---------|
| 范围层（RR1-RR7，终版） | [`docs/requirements-v0-scope.md`](docs/requirements-v0-scope.md) |
| 架构设计（两阶段 init + 模块分解） | [`docs/architecture-v0.md`](docs/architecture-v0.md) |
| 接口契约（6 契约 + 13 错误类） | [`docs/contract-v0.md`](docs/contract-v0.md) |
| RR7 Init 实施记录 | [`docs/rr7-init-design.md`](docs/rr7-init-design.md) |
| 重构方向（v1.11-v1.17） | [`docs/refactor-direction-v1.11.md`](docs/refactor-direction-v1.11.md) |
| v0.1 候选实施（3/3 实施） | [`docs/v0.1-candidates.md`](docs/v0.1-candidates.md) |
| MSM 自包含 RFC（S028） | [`docs/plugin-self-contained-msm-v1.md`](docs/plugin-self-contained-msm-v1.md) |
| 设计方案索引（S031） | `AGENT_SESSIONS/2026-05-17--S031--plugin-next-round-requirements/SESSION.md` |

---

> **版本**: v0.1.0 (2026-06-15)
> **作者**: yh + 宁静号 Agent
