#!/usr/bin/env npx tsx
/**
 * write-interceptor.ts — CCC Write Interceptor Protocol 模板
 *
 * 由 ACC 在 tool.execute.before 中调用（write/edit 工具），
 * 在 RR5 路径安全检查通过后执行自定义校验逻辑。
 *
 * 完整 WIP 开发指南：msm_admin write-interceptor-guide
 *
 * 类别：Mech（无 LLM 决策，纯确定性校验）
 *
 * 退出码契约：
 *   0 — ALLOW（写入继续）
 *   1 — BLOCK（写入被拒绝；stdout 为返回给 LLM 的错误信息，ACC 不加前缀）
 *
 * 被 ACC 调用时参数：
 *   --tool=write|edit
 *   --paths=/abs/path1,/abs/path2
 *
 * 自定义步骤：
 *   1. 修改 checkWrite() 实现拦截逻辑
 *   2. console.log("返回给LLM的信息") + process.exit(1) = 拒绝
 *   3. 默认 process.exit(0) = 全部允许
 */

import { existsSync, readFileSync } from "node:fs";

// ── 参数解析 ──

function getFlagValue(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      return argv[i + 1] ?? null;
    }
    if (argv[i]!.startsWith(`${flag}=`)) {
      return argv[i]!.slice(flag.length + 1);
    }
  }
  return null;
}

// ── 校验逻辑（在此实现你的拦截规则）──

function checkWrite(tool: string, paths: string[]): void {
  for (const p of paths) {
    // === 示例 1：阻止修改关键配置文件 ===
    // if (p.includes('/secrets/') || p.endsWith('.serenity')) {
    //   console.error(`write-interceptor: blocked write to protected path: ${p}`);
    //   process.exit(1);
    // }

    // === 示例 2：校验 YAML frontmatter 完整性 ===
    // if (p.endsWith('.md') && existsSync(p)) {
    //   const content = readFileSync(p, 'utf-8');
    //   if (!content.startsWith('---')) {
    //     console.error(`write-interceptor: file "${p}" must start with YAML frontmatter`);
    //     process.exit(1);
    //   }
    // }

    // === 示例 3：阻止写入超过阈值的文件 ===
    // if (existsSync(p)) {
    //   const stat = readFileSync(p, 'utf-8');
    //   if (stat.length > 100_000) {
    //     console.error(`write-interceptor: file too large (${stat.length} bytes)`);
    //     process.exit(1);
    //   }
    // }
  }

  // 默认：允许写入
  process.exit(0);
}

// ── CLI 入口 ──

function main(): void {
  const args = process.argv.slice(2);

  const tool = getFlagValue(args, "--tool");
  const pathsRaw = getFlagValue(args, "--paths");

  if (!tool || !pathsRaw) {
    console.error("write-interceptor: missing --tool or --paths");
    process.exit(1);
  }

  if (tool !== "write" && tool !== "edit") {
    console.error(`write-interceptor: invalid tool "${tool}" (expected write or edit)`);
    process.exit(1);
  }

  // paths 以逗号分隔
  const paths = pathsRaw.split(",").map((s) => s.trim()).filter(Boolean);

  if (paths.length === 0) {
    console.error("write-interceptor: empty paths");
    process.exit(1);
  }

  checkWrite(tool, paths);
}

// ── CLI 守卫 ──

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main();
}
