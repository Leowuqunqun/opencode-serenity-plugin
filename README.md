# opencode-serenity-plugin

> **v0.0.2** (2026-06-07) — 宁静号 OpenCode 平台本地插件
>
> 承载 RR1-RR7 范围约束，提供 3 个 PRIMARY 工具 (`msm_list` / `msm_exec` / `msm_admin`) + `/serenity-init` 一键初始化。
> 覆盖"拦截 + 行为"（server entry）与"通知用户"（TUI entry）两条独立加载路径。
>
> 远程：[github.com/tellmewhattodo/opencode-serenity-plugin](https://github.com/tellmewhattodo/opencode-serenity-plugin)

---

## 安装

### 方式 1：`bin install`（推荐，v1.11+）

```bash
cd <你的项目根>
pnpm install && pnpm build                                  # 1) 构建 dist/
npx opencode-serenity-plugin install                        # 2) 写 project + global config
# 或只写 global（不在 git repo 时）：
npx opencode-serenity-plugin install --global
```

### 方式 2：手动配置

在 `opencode.json`（项目）和 `tui.json`（`~/.config/opencode/tui.json`）写入 plugin 引用：

```jsonc
// opencode.json (server entry)
"plugin": [
  "file:///.../AI_LAB/opencode-serenity-plugin/dist/index.js"
]

// tui.json (TUI entry — global for slash command visibility)
"plugin": [
  "file:///.../AI_LAB/opencode-serenity-plugin/dist/tui.js"
]
```

---

## 范围层（RR1-RR7）

| # | 规则 | 关键约束 |
|---|------|---------|
| **RR1** | cwd 内必须有 `/.serenity`，内容 = 实例名 | 文件是单一真相源 |
| **RR2** | 激活后首次加载 `.opencode/skills/<实例名>/SKILL.md` | 每次新 session 启动时 |
| **RR3** | 禁 bash；命令通过 MSM（已有/新写）| 同名 bash tool 抛错 + `permission.bash:deny` 双层 |
| **RR4** | cwd 内全部权限 | 默认 allow |
| **RR5** | cwd 外全部无权限 | deny/throw（含 symlink 防御，v1.6 RR5 hard block）|
| **RR6** | cwd 必须在 git repo 内 | 否则 plugin 不工作 |
| **RR7** | plugin 应能"初始化 cwd 为 serenity" | 5 子点（`/serenity-init` / 默认目录名 / 不自动 init / 自动 add+commit / 仅创建 /.serenity）|

完整范围层见 [`docs/requirements-v0-scope.md`](docs/requirements-v0-scope.md)。

---

## 架构层

**两阶段 init**（Phase 1 sync RR6 → Phase 2 async RR1+RR2+config-patch）+ **5 hook 工厂**（permission-guards / permission-auto-reply / compacting / shell-env / util）+ **10 util helper**。

完整方案层见 [`docs/architecture-v0.md`](docs/architecture-v0.md)。

---

## 接口层

**4 个 tool slot**：`bash` (override, RR3) + `msm_list` + `msm_exec` + `msm_admin`（v1.17 合并 register/deregister）。

**5 个 hook 事件**：`tool.execute.before` / `experimental.chat.system.transform` / `experimental.session.compacting` / `shell.env` / `event:permission.asked`。

**13 个 SerenityError 子类**：见 [`docs/contract-v0.md` 附录 B](docs/contract-v0.md)。

---

## 状态

| 项 | 状态 |
|----|:----:|
| 范围层 RR1-RR7 | ✅ |
| 方案层（两阶段 init + hooks/util）| ✅ |
| 接口层（4 tool + 13 错误）| ✅ |
| 实现层 12 src/ + 5 hooks/ + 10 util/ + types/ | ✅ |
| 测试 23 文件 / 320 cases | ✅ |
| typecheck + build green | ✅ |
| `bin install` CLI（v1.11+）| ✅ |
| msm_exec 协议层（S022 RFC 6 必含 flag）| ✅ |
| `msm-exec.ts` 单元测试（E2E only）| ⏳ v0.0.3 |
| PluginConfig 全链路 wiring | ⏳ v0.0.3 |
| 永久 slot 状态指示器 | ❌ v0.0.2 决定不做（JSX runtime 兼容性）|

---

## 测试

```bash
pnpm test         # 320/320 pass (vitest, 20s timeout)
pnpm typecheck    # tsc --noEmit, green
pnpm build        # tsc compile dist/
```

---

## 调试日志

**当前状态**：`src/util/log.ts` 是 **no-op wrapper**（65 sites 全部 noop），暂不输出到 stderr。
`OPENCODE_SERENITY_LOG_FILE` / `OPENCODE_SERENITY_DEBUG` env vars 暂未实现。开发期调试建议：

```bash
# 直接看 plugin 加载 / 错误信息
pnpm build && opencode            # 注意 toast 提示

# 跑单个测试看错误
pnpm test tests/activation.test.ts
```

> 注：v0.0.3+ 计划恢复 log.ts 实际功能（写 stderr 级别化 + 可选文件输出）。

---

## 远程

- 仓：`git@github.com:tellmewhattodo/opencode-serenity-plugin.git` (private)
- Web：https://github.com/tellmewhattodo/opencode-serenity-plugin
- 默认分支：`main`
- 迁移历史：2026-06-07 从 `git@home.gitlab:yh/opencode-serenity-plugin.git` 迁出

---

## Open Follow-ups (v0.0.3+)

- `msm-exec.ts` 单元测试（v1.14 deferred；目前仅 E2E 验证）
- PluginConfig 全链路 wiring
- `session-tool` resolve-path bug 修复（主仓侧）
- `msm_exec` 工具层 protocol flag prefix 解析（目前仅协议层解析）
- omo-style 5-layer hook composer 迁移（低优先级）
- `log.ts` 实际输出 + `OPENCODE_SERENITY_LOG_FILE` / `OPENCODE_SERENITY_DEBUG` 实现

---

## 关联文档

| 层 | 文档 |
|----|------|
| 范围 | [`docs/requirements-v0-scope.md`](docs/requirements-v0-scope.md) — RR1-RR7 终版 |
| 方案 | [`docs/architecture-v0.md`](docs/architecture-v0.md) — 两阶段 init + 模块 |
| 接口 | [`docs/contract-v0.md`](docs/contract-v0.md) — 6 契约 + 13 错误类 |
| 实施 | [`docs/rr7-init-design.md`](docs/rr7-init-design.md) — v1.10 / v1.10.1 RR7 init 实施记录 |
| 演进 | [`docs/refactor-direction-v1.11.md`](docs/refactor-direction-v1.11.md) — v1.11-v1.17 重构方向 |
| 候选 | [`docs/v0.1-candidates.md`](docs/v0.1-candidates.md) — v0.1 候选（3/3 已实施）|
| 旧需求 | [`docs/requirements-v0-summary.md`](docs/requirements-v0-summary.md) — ⚠️ R1-R5 旧版（保留演进史）|

---

> **版本**：v0.0.2 (2026-06-07)
> **作者**：yh + 宁静号 Agent
