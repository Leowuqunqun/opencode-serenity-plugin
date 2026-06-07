## Plugin Refactor Direction — 2026-06-07 对齐结论

> 起源:用户对 v1.10 / v1.10.1 后 plugin 体验满意,提了两个问题:
> 1. 安装需要装两个 plugin (server + TUI),能否简化?
> 2. 现有功能是否有更好的实现方法?
>
> 调研参考:omo (github.com/code-yeongyu/oh-my-openagent @ 2e22f4f) 源码分析,报告 `AGENT_SESSIONS/2026-06-07--S021--omo-plugin-investigation/REPORT-v2.md`
>
> 关键拐点:用户 m0107 强调"先结合宁静号自身的定位"——不能照搬 omo,必须从宁静号价值反推。

### 宁静号 plugin 的双重价值 (第一性原理)

| 价值 | 含义 | 实现保障 |
|------|------|---------|
| **V1: 自由初始化** | 用户能在任何目录把项目升级为 serenity | `/serenity-init` slash command 必须在非 serenity 目录可见 (v1.10.1 已实现) |
| **V2: 非侵入** | 非 serenity 目录,opencode 行为和没装 plugin 一样 | 0 MCP、0 hook、0 permission patch、0 输出 |

V1 + V2 同时满足 = 两 entry 架构:
- **Server entry 仅 project-level 加载** (`opencode.json` 的 `plugin` 数组) —— 只在 serenity 目录被 opencode 加载 → V2 ✓
- **TUI entry 全局加载** (`tui.json` 的 `plugin` 数组) —— 只注册 `/serenity-init` 一个 slash command,不修改任何 host 行为 → V2 ✓ + V1 ✓
- v1.10.1 修复让 TUI plugin 自安装到 global `~/.config/opencode/tui.json` → V1 加强

### omo 模式反思

omo 假设"装了我就在每个目录活跃"——13 MCP / 56 hook / 5 agent 默认全开,**没有"非激活态"概念**。

omo 的两个层面:
| 层面 | omo 实现 | 我们的选择 |
|------|---------|----------|
| **架构层** (单 entry) | `string[]` 形式,1 个 server entry,config mutation 注入所有 UI/MCP/agent | ❌ 不抄。合并 entry 会破坏 V2:plugin 必须全局加载 → 必须每个 hook 加 `isSerenity` 守卫 → "激活判断"从宿主层下沉到 plugin 内部 → 失去硬隔离 |
| **代码层** (hook 保护、zod-first、bin install) | `isHookEnabled` + `safeCreateHook`、zod schema、`bin install` CLI | ✅ 该抄。这些是代码质量改进,跟 V1/V2 无关 |

### 锁定的实施方向

**保留两 entry 架构**。改进 3 件事:

| 版本 | 任务 | 价值 | 工作量 | 风险 |
|------|------|------|--------|------|
| **v1.11** | `bin install` CLI:一次写两 entry (project opencode.json + global tui.json) | V1 安装体验 | 6-8h | 低 (仅添加,不改架构) |
| **v1.12** | `isHookEnabled` + `safeCreateHook` 工具 (仿 omo safeHook 模式) | V2 健壮性 | 2-3h | 低 |
| **v1.13** | plugin config 改 zod-first schema | 代码质量 | 3h | 低 |

总计 11-14h,分 3-5 个 commit 落地。

### v1.11 `bin install` 设计草案

**入口**:`npx opencode-serenity-plugin install [flags]`

**行为**:
1. 解析 `dist/index.js` + `dist/tui.js` 绝对路径 (用 `realpathSync` 解析 symlink)
2. 写两处 (不合并 entry):
   - `<cwd>/opencode.json#plugin` append `dist/index.js` (idempotent)
   - `~/.config/opencode/tui.json#plugin` append `dist/tui.js` (idempotent)
3. 尊重 `$XDG_CONFIG_HOME` (跨平台)
4. 不破坏用户现有配置 (保留其他 plugin / 其他字段)
5. 静默幂等

**flags**:
- `--global`:跳过项目级,只装 TUI
- `--uninstall`:反向删除 entry (保留其他 plugin)
- `--dry-run`:打印将要做的修改,不实际写
- `--cwd <path>`:override 默认 cwd

**参考**:omo `src/cli/install.ts` + `tui-installer.ts` + `add-plugin-to-opencode-config.ts`

**不抄 omo**:
- ❌ postinstall 钩子 (omo 自己也没用,只做自检)
- ❌ `@clack/prompts` 交互式 TUI (v1 阶段不需要,CLI flag 已够用)
- ❌ telemetry / GitHub star 提示
- ❌ dual-publish / 多个 bin alias

### 决策记录

- **D23** (2026-06-07):保留两 entry 架构。理由:V2 非侵入要求 plugin 在非 serenity 目录完全无感;单 entry 必须每个 hook 加守卫,违反硬隔离原则。
- **D24** (2026-06-07):v1.11 实施 `bin install` CLI。理由:用户最痛点是安装体验,6-8h 解决。
- **D25** (2026-06-07):v1.12 实施 hook 保护。理由:1 个 hook 抛错杀整个 plugin 的脆弱性必须修。
- **D26** (2026-06-07):v1.13 实施 zod-first。理由:plugin config 还在手写 interface,zod 是 single source of truth。
