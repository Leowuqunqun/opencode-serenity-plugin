---
name: {{prefix}}-sqc
description: SQC 品质循环 — 定期扫描所有 skill，DC-M1~M4 走 msm_admin check
---

# Skill: {{prefix}}-sqc — 品质循环

> 定期扫描所有 skill，自动发现并修复可自动化的问题。

## 用途

SQC（Serenity Quality Cycle）品质循环维护认知容器 (CCC) 的认知基础设施质量。

## 检查维度

| 维度 | 检查项 | 检查方式 |
|------|--------|---------|
| **DC-1** | 所有技能目录是否存在对应的 SKILL.md | 手动 |
| **DC-2** | SKILL.md 中是否包含 name 和 description | 手动 |
| **DC-3** | Skill frontmatter 中的 name 与技能目录名是否一致 | 手动 |
| **DC-4** | {{ccc_name}} SKILL.md 的"相关技能"表是否包含所有已安装技能 | 手动 |
| **DC-M1** | [MSM] 每个 MSM 脚本是否有对应的 `.test.ts` 测试文件 | msm_admin check |
| **DC-M2** | [MSM] 每个 MSM 脚本是否有 main() CLI 守卫 | msm_admin check |
| **DC-M3** | [MSM] 每个 MSM 脚本是否已在 mech-registry.json 注册 | msm_admin check |
| **DC-M4** | [MSM] 路径参数 flag 是否标记为 type:"path" | msm_admin check |
| **GP-4** | SKILL.md 是否符合模板格式要求 | 手动 |

## 使用方式

1. 定期间隔（建议每周）运行 MSM 品质检查：`msm_admin check`（由 ACC 提供，检查 DC-M1~M4）
2. 手动检查 DC-1~4 + GP-4
3. 对需要人工判断的问题打开 AGENT_SESSION

## 注意

- SQC 不做语义层面的质量评估（那是 EAP 的职责）
- SQC 只检查结构完整性
- DC-M1~M4 MSM 品质检查由 ACC 的 `msm_admin check` 统一执行
- 修复建议由检查报告给出，需人工确认后执行
