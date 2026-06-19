# Skill: {{prefix}}-git — Git 操作指南

> 仓库管理、克隆/拉取/推送/分支约定。

## 用途

管理认知容器 (CCC) 关联的 git 仓库群，提供：
- 仓库清单和远程 URL
- 批量操作脚本（clone/pull/push）
- 分支命名约定
- 常见问题处理

## Git 配置参考

项目使用的 Git 服务需要根据实例配置填写。本技能不预设特定的 GitLab/GitHub 地址。

## 分支约定（建议）

| 分支 | 用途 |
|------|------|
| `main` / `master` | 稳定版本 |
| `develop` | 开发主线 |
| `feature/<name>` | 新功能 |
| `fix/<name>` | 修复 |
| `hotfix/<name>` | 紧急修复 |

## 批量操作

可使用 `file-system` 工具获取项目根目录，然后在根目录执行批量 git 操作。

## 注意

- 所有批量操作前确认 git 状态（git status）
- 推送前 review diff
- 避免 force push
