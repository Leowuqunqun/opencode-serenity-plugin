---
name: {{prefix}}-write-interceptor
description: WIP (Write Interceptor Protocol) — intercept write/edit operations with custom validation logic
---

# Skill: {{prefix}}-write-interceptor — Write Interceptor

> CCC-level write interception for content validation and structural enforcement

## 用途

在 ACC 的 `tool.execute.before` 中拦截 `write` 和 `edit` 操作，允许 CCC 在**路径安全检查之后**、**实际写入之前**注入自定义校验逻辑。

## 注册

```bash
msm_admin register write-interceptor \
  --path .opencode/skills/{{ccc_name}}/scripts/write-interceptor.ts \
  --category mech \
  --description "WIP: intercept write/edit for content validation (exit 0=allow, exit 1=block)" \
  --flags '[
    {"name":"tool","type":"string","description":"write|edit","required":true},
    {"name":"paths","type":"string","description":"comma-separated absolute paths","required":true}
  ]'
```

## 退出码

| Code | 含义 | ACC 行为 |
|------|------|----------|
| `0` | ALLOW | 写入继续 |
| `1` | BLOCK | 写入被拒绝，stderr 显示原因 |
| other | ERROR | Fail-safe：写入放行，日志记录警告 |

## 实现指南

1. 修改 `checkWrite()` 函数实现你的拦截逻辑
2. `exit(0)` = 允许写入；`exit(1)` = 拒绝写入
3. 拒绝时用 `console.error()` 输出原因到 stderr
4. 异常/非 0/1 退出码会被 ACC 捕获并视为允许（fail-safe）
