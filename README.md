# opencode-serenity-plugin

> **v0.0.1** — 首个可用版本
> OpenCode 平台本地插件，承载「宁静号」7 条范围约束（RR1-RR7）。覆盖"拦截 + 行为"（server entry）+ "通知用户"（TUI entry）两条独立加载路径。

---

## 安装

主仓 `home-serenity` 已配好指向本仓本地路径的 plugin 引用：

```jsonc
// opencode.json (server entry)
"plugin": [
  "file:///.../AI_LAB/opencode-serenity-plugin/dist/index.js"
]

// tui.json (TUI entry)
"plugin": [
  "file:///.../AI_LAB/opencode-serenity-plugin/dist/tui.js"
]
```

首次使用：先 `pnpm install && pnpm build` 构建 `dist/`，再启动 opencode。

---

## 范围层（RR1-RR7）

| # | 规则 | 关键约束 |
|---|------|---------|
| **RR1** | cwd 内必须有 `/.serenity`，内容 = 实例名 | 文件是单一真相源 |
| **RR2** | 激活后首次加载 `.opencode/skills/<实例名>/SKILL.md` | 每次新 session 启动时 |
| **RR3** | 禁 bash；命令通过 MSM（已有/新写） | 同名 bash tool 抛错 + `permission.bash:deny` 双层 |
| **RR4** | cwd 内全部权限 | 默认 allow |
| **RR5** | cwd 外全部无权限 | deny/throw（含 symlink 防御）|
| **RR6** | cwd 必须在 git repo 内 | 否则 plugin 不工作 |
| **RR7** | plugin 应能"初始化 cwd 为 serenity" | 5 子点 |

完整范围层见 `docs/requirements-v0-scope.md`。

---

## 架构层

10 步启动协议 + 5 模块（activation / state / msm / hooks / config-patch）。

完整方案层见 `docs/architecture-v0.md`。

---

## 接口层

6 个 SDK 契约 + 13 个 SerenityError 子类。

完整接口层见 `docs/contract-v0.md`。

---

## 状态

| 项 | 状态 |
|----|:----:|
| 范围层 RR1-RR7 | ✅ |
| 方案层 10 步 + 5 模块 | ✅ |
| 接口层 6 契约 + 13 错误 | ✅ |
| 实现层 30 文件 / 125 tests | ✅ |
| typecheck + build green | ✅ |
| 主仓 `opencode.json` 集成 | ✅ |
| 主仓 `tui.json` 集成（v0.0.1 新增）| ✅ |
| 用户实测 toast 显示（v0.0.1）| ✅ |
| 永久 slot 状态指示器 | ⏸ v0.0.2（v1.10 plan）|

---

## 测试

```bash
pnpm test         # 125/125 pass
pnpm typecheck    # green
pnpm build        # 编译 dist/
```

---

## 调试日志

`src/util/log.ts` 提供 `[serenity-plugin][tag]` 前缀的 stderr 输出（默认）。文件输出完全 opt-in：

```bash
OPENCODE_SERENITY_LOG_FILE=/tmp/serenity-plugin.log opencode
OPENCODE_SERENITY_DEBUG=1 opencode  # 额外开 debug 级
```

---

## 远程

- 仓：`git@home.gitlab:yh/opencode-serenity-plugin.git`（id=32, private）
- Web：`http://home.gitlab/yh/opencode-serenity-plugin`
- 默认分支：`main`

---

## 关联文档

- 范围层：`docs/requirements-v0-scope.md`
- 方案层：`docs/architecture-v0.md`
- 接口层：`docs/contract-v0.md`
- 旧需求（R1-R5）：`docs/requirements-v0-summary.md`
- v0.1 候选分析：`docs/v0.1-candidates.md`
- 调研 SESSION：`AGENT_SESSIONS/2026-06-04--S015--opencode-plugin-investigation/`（主仓）
- TUI toast 调试报告：`AGENT_SESSIONS/2026-06-06--S019--tui-toast-investigation/docs/tui-toast-root-cause.md`

---

> **版本**：v0.0.1（2026-06-06 — 首个可用版本）
> **作者**：yh + 宁静号 Agent
