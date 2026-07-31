# 开发规范

## 版本号规则

- **Patch（第三位）**：Agent 可自主决定。修复 bug、小功能迭代、文档更新。
- **Minor（第二位）**：必须先与 yh 确认。破坏性小变更、重大功能新增、API 变动。
- **Major（第一位）**：必须先与 yh 确认。架构级变更、不兼容升级。

## 发布流程

1. `npm test` 全部通过
2. `npm run build` 编译成功
3. `npm version patch --no-git-tag-version`（或 minor/major 需确认）
4. `npm publish --access public`
5. `node bin/opencode-serenity-plugin.js install` 本地安装
6. `git add -A && git commit -m "..." && git push origin main`

## 测试

- 单元测试：`npm test`
- 测试文件：`tests/*.test.ts`
- 覆盖率目标：保持 487+ 测试全部通过

## 代码审查

- 使用 `home-quality-review` skill 进行 MR review
- 用 `review-*` MSM 系列工具自动化检查
