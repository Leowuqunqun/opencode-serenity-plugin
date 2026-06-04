/**
 * tool.execute.before hook — 双层防御（RR3）
 *
 * 第一层：opencode.json permission.bash = "deny"（静态配置）
 * 第二层：本 hook 拦截所有 tool 调用，如果是 bash 抛 BashDisabledError
 *
 * L3 验证：单 hook 抛错会中断整条 Effect 链（plugin/index.ts:286-299），
 * 所以**不要**让抛错传播到 plugin 顶层——必须在 hook 内 try/catch
 *
 * 实际上**不需要**额外拦截 builtin bash，因为：
 * 1. 同名 `bash` tool（bash-override.ts）已经覆盖
 * 2. permission.bash = "deny" 已经静态拦截
 *
 * 本文件提供**额外**路径检查：所有 tool 的 args.command / args.path 都不应
 * 指向 cwdRoot 外（RR5 强化）
 */

import type { Hooks } from '@opencode-ai/plugin';
import { resolve as pathResolve } from 'node:path';
import { isPathInside } from './util/git.js';
import { getState, ensureReady } from './state.js';
import { BashDisabledError } from './errors.js';

type ToolArgs = Record<string, unknown>;

function extractPathsFromArgs(args: ToolArgs): string[] {
  // 启发式：从常见 path / command 字段中提取路径
  const candidates: string[] = [];
  for (const key of ['command', 'path', 'filePath', 'file', 'cwd']) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) {
      candidates.push(v);
    }
  }
  return candidates;
}

function pathAppearsOutsideRoot(value: string, cwdRoot: string): boolean {
  // 如果是绝对路径且不在 cwdRoot 内 → 违规
  if (value.startsWith('/') || /^[a-zA-Z]:[\\\/]/.test(value)) {
    try {
      const abs = pathResolve(value);
      return !isPathInside(cwdRoot, abs);
    } catch {
      return false;
    }
  }
  // 相对路径：无法精确判定（运行时才知道 cwd），放行
  return false;
}

export const toolExecuteBeforeHook: NonNullable<Hooks['tool.execute.before']> = async (input, _output) => {
  // v0.1: 阻塞等待 Phase 2 完成（失败时：放行所有 = plugin 不工作 = "就像没装一样"）
  try {
    await ensureReady();
  } catch {
    return;
  }

  const state = getState();
  const args = (input as unknown as { args: ToolArgs }).args ?? {};
  const paths = extractPathsFromArgs(args);

  // 防止 LLM 用 webfetch / read 抓 cwdRoot 外的内容（RR5 强化）
  // 注：v0 仅对 read / webfetch 工具强制
  if (input.tool === 'read' || input.tool === 'webfetch') {
    for (const p of paths) {
      if (pathAppearsOutsideRoot(p, state.cwdRoot)) {
        throw new Error(
          `[serenity] ${input.tool} path "${p}" is outside the serenity workspace root "${state.cwdRoot}" (RR5). serenity plugin enforces no access outside the instance.`,
        );
      }
    }
  }

  // 防御性：万一 bash 没被 override，hook 拦截
  if (input.tool === 'bash') {
    throw new BashDisabledError();
  }
};
