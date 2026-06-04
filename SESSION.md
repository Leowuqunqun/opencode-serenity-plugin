# SESSION: opencode-serenity-plugin

> **项目即会话模式**（home-session 定义）—— 本仓是独立 git 项目；日常演进通过 git commit 记录，本文件只追踪**当前焦点 + 未决问题**。

---

## 当前焦点

**WIP — 决策对账表待用户核对**（详见 `README.md` §1）

> 2026-06-04：仓库骨架已搭，需求 v0 已锁定（5 条 R1-R5）。
> 用户明确"先核对再写实现代码"。等用户回复 D1-D12 决策后，进入下一轮。

---

## 未决问题

1. **D1-D12 决策对账**：仓库元信息（名字/位置/包管理/TS 版本等）待用户核对
2. **plugin 入口契约**：D9 决定后写 `package.json#opencode` 字段（hook 列表 + tool 描述）
3. **msm_list / msm_exec 详细签名**：R2 验收 F1-F5 具体输入输出格式待敲定
4. **HOME_SERENITY_ROOT 传递方式**：D12 决定后写实现
5. **opencode.json 集成**：R1/R3/R4 涉及的 opencode.json 改动**不在本仓**——单独开一个主仓 SESSION

---

## 关键决策

| # | 决策 | 理由 | 状态 |
|---|------|------|------|
| 1 | 仓库放 `AI_LAB/opencode-serenity-plugin/` | 类比 `Claud Code Investigation` 同样为 agent 平台调研性质 | ✅（待用户核对 D1-D2）|
| 2 | v0 范围收窄到 5 条 R1-R5 | L5 可行性分析确认 GO；其余需求推 v1 | ✅ |
| 3 | 1+1 msm 设计（R2）替代 31 tool 化 | 消除 L4 §7.2 LLM 注意力分散风险 | ✅ |
| 4 | 作用域门控（R5）默认开启 | DR7-DR9 决策 | ✅ |
| 5 | v0 不解决完整权限拦截 | `permission.ask` hook 是死声明（L3 验证）| ✅（明确不可行）|
| 6 | 仓库骨架阶段不写实现 | 用户明确"需求未完全确定，先核对" | ✅ |

---

## 最近变更

- 2026-06-04 — 仓库骨架创建（4 文件 + 2 目录），未 git init
- 2026-06-04 — README 决策对账表 + docs/requirements-v0-summary.md 引用
- 2026-06-04 — SESSION.md 创建（本文件）

---

## 产出物（当前）

- `README.md` — 仓库说明 + 决策对账表
- `SESSION.md` — 本文件
- `.gitignore` — Node + TS 标准
- `package.json` — 占位（待 D6-D8 决定后完善）
- `docs/requirements-v0-summary.md` — v0 5 条需求引用
- `src/.gitkeep` — 空目录占位
