# Requirements v0 — Scope（范围层）

> **plugin**: opencode-serenity-plugin
> **版本**: v0 scope
> **日期**: 2026-06-04
> **状态**: ✅ 范围层关闭（RR1-RR7 + RR7 5 子点全部已定）
> **下一抽象层**: 方案/设计层（plugin 启动协议 + 整体架构）

---

## 1 顶层目的

> **将 opencode 变成 serenity 专属 agent。**

plugin 工作后：
- opencode 的默认通用能力被**强约束**（禁 bash、目录外无权限、强制 skill 加载）
- opencode 看到的是 **serenity 工作流**（MSM 工具集、SSO 凭证、领域 SKILL.md）
- 非 serenity 目录 = plugin **完全不工作**（"就像没装一样"）

---

## 2 RR1-RR7 完整规则（7 条产品行为约束）

| # | 规则 | 关键约束 |
|---|------|---------|
| **RR1** | cwd 内必须有 `/.serenity` 文件 | 文件内容 = 实例名 N（字符串）|
| **RR2** | plugin 激活后**首次**加载对应实例的 SKILL.md | 路径：`.opencode/skills/<N>/SKILL.md`；每次新 session 启动时加载 |
| **RR3** | **禁 bash** 工具 | 所有命令必须通过 MSM（已有或现场编写后注册）|
| **RR4** | cwd 内全部权限 | read/write/edit/delete/execute 默认 allow |
| **RR5** | cwd 外全部无权限 | deny / throw / no-op（具体形式待方案层定）|
| **RR6** | cwd 必须在 git repo 内 | 满足 `git rev-parse --is-inside-work-tree`；否则 plugin 不工作 |
| **RR7** | plugin 应能"将 cwd 初始化为 serenity 目录" | 详见 §3（5 子点）|

**统一不工作规则**：`/.serenity` 不存在 **或** 不在 git repo **或** `.opencode/skills/<N>/SKILL.md` 找不到 → plugin **完全不工作**（就像没装一样，无任何副作用）。

---

## 3 RR7 5 子点（产品行为细节）

| # | 决策 | 说明 |
|---|------|------|
| ① 触发方式 | slash command **`/serenity-init`** | 用户在 opencode TUI 中执行 |
| ② 实例名默认 | 目录名（kebab-case）| 例：`my-cool-project`；可显式覆盖 |
| ③ git 前置 | **不自动** init | 要求用户先自己 `git init`；plugin 失败时给出明确提示 |
| ④ commit 行为 | 创建后**自动** `git add + commit` | commit message 模板：`chore: initialize serenity (instance: <N>)` |
| ⑤ 初始化范围 | **仅**创建 `/.serenity` | 最小化原则；不创建 `.opencode/skills/<N>/`（用户自行准备）|

**slash command 失败处理**（行为细节，待方案层定）：
- 不在 git repo 内 → 提示"请先 `git init`"
- `/.serenity` 已存在 → 提示"已是 serenity 目录"，可选 no-op 或更新
- 实例名冲突（与已有 skill 不匹配）→ 提示用户处理

---

## 4 抽象层位置（5 层链）

```
需求/目标层    →  "将 opencode 变成 serenity 专属 agent"          ← 顶层目的（§1）
范围/边界层    →  RR1-RR7                                            ← 本文档
方案/设计层    →  Q4 plugin 启动协议、整体架构                      ← 下一层（待讨论）
接口/契约层    →  msm_exec 签名、permission schema、SKILL.md 接口   ← 方案层后再谈
实现/代码层    →  src/plugin.ts、TS 类型、单元测试                  ← 最后
```

---

## 5 范围层外不讨论（撤回记录）

以下问题在范围层讨论时被**撤回**，移到对应抽象层：

| 撤回项 | 原问方式 | 撤回原因 | 移到哪层 |
|--------|---------|---------|---------|
| msm_exec 签名 | `Q5` | 这是接口/契约层细节，需求层不该问 | 接口/契约层 |
| permission schema | `Q6` | 同上 | 接口/契约层 |
| plugin 仓"身份" | `Q8` | 废问题——plugin 仓就是 plugin 仓，无身份问题 | 删除 |
| `HOME_SERENITY_ROOT` env | `Q7-选项` | 已被"cwd 就是主仓"取代 | 删除 |

---

## 6 关联文档

| 文档 | 路径 | 关系 |
|------|------|------|
| plugin 仓 README | `README.md` | 总入口；引用本文档 |
| plugin 仓 SESSION | `SESSION.md` | 活跃跟进载体；记录所有变更历史 |
| **旧版需求**（R1-R5，已被 RR1-RR7 取代）| `docs/requirements-v0-summary.md` | 4.8KB 摘要；**已过时**，保留作为演进历史 |
| 主仓调研 SESSION | `../HOME-SERENITY/AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/` | 软引用（D11 决策）；含源码分析、扩展点定位 |
| 主仓 v0 锁定（中间态）| 调研 SESSION 内的 `requirements-locked-v0.md` | R1-R5 临时状态；本 RR1-RR7 是其正式演化结果 |

---

## 7 未决 / 待进入下一层

- 方案/设计层启动时机
- 方案层第一个讨论议题（推荐：Q4 plugin 启动协议）
- msm_exec 签名（接口/契约层）
- permission schema（接口/契约层）
- plugin 仓 README 是否要回写"产品需求"摘要链接

---

> **本文档是范围/边界层的最终收口。** 任何对 RR1-RR7 的修订都应改本文档 + 在 plugin 仓 SESSION.md 留 git 历史。
