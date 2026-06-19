# Skill: {{prefix}}-sqc — 品质循环

> 定期扫描所有 skill，自动发现并修复可自动化的问题。

## 用途

SQC（Serenity Quality Cycle）品质循环维护认知容器 (CCC) 的认知基础设施质量。

## 检查维度

| 维度 | 检查项 |
|------|--------|
| **DC-1** | 所有技能目录是否存在对应的 SKILL.md |
| **DC-2** | SKILL.md 中是否包含 name 和 description |
| **DC-3** | Skill frontmatter 中的 name 与技能目录名是否一致 |
| **DC-4** | home-serenity SKILL.md 的"相关技能"表是否包含所有已安装技能 |
| **GP-4** | SKILL.md 是否符合模板格式要求 |

## 使用方式

1. 定期间隔（建议每周）运行全量扫描
2. 检查报告中的警告和错误
3. 修复可自动化的问题（目录缺失、链接断裂）
4. 对需要人工判断的问题打开 AGENT_SESSION

## 注意

- SQC 不做语义层面的质量评估（那是 EAP 的职责）
- SQC 只检查结构完整性
- 修复建议由 MSM 工具给出，需人工确认后执行
