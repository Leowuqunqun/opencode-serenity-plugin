/**
 * Permission Guards Hook 工厂
 *
 * 包含：tool.execute.before hook
 * 职责（RR3 + RR5）：
 * 1. 防御性拦截 bash（同名 tool 已覆盖，permission.bash=deny 已静态拦截 —— 这是第三层）
 * 2. read / webfetch 工具的 path 字段强制在 cwdRoot 内（RR5 强化）
 *
 * L3 验证：单 hook 抛错会中断整条 Effect 链（plugin/index.ts:286-299），
 * 所以抛错已被 safeHook 包装为 silent（util.ts）
 */

import type { Hooks } from '@opencode-ai/plugin';
import { resolve as pathResolve } from 'node:path';
import { isPathInside } from '../util/git.js';
import { getState, ensureReady } from '../state.js';
import { BashDisabledError } from '../errors.js';
import { isHookEnabled, safeHook, type HookConfig } from './util.js';

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
  if (value.startsWith('/') || /^[a-zA-Z]:[\\\/]/.test(value)) {
    try {
      const abs = pathResolve(value);
      return !isPathInside(cwdRoot, abs);
    } catch {
      return false;
    }
  }
  return false;
}

const toolExecuteBeforeImpl: NonNullable<Hooks['tool.execute.before']> = async (input, _output) => {
  // v0.1: 阻塞等待 Phase 2 完成（失败时：放行所有 = plugin 不工作）
  try {
    await ensureReady();
  } catch {
    return;
  }

  const state = getState();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args = (input as any).args ?? {};
  const paths = extractPathsFromArgs(args);

  if (input.tool === 'read' || input.tool === 'webfetch') {
    for (const p of paths) {
      if (pathAppearsOutsideRoot(p, state.cwdRoot)) {
        throw new Error(
          `[serenity] ${input.tool} path "${p}" is outside the serenity workspace root "${state.cwdRoot}" (RR5).`,
        );
      }
    }
  }

  if (input.tool === 'bash') {
    throw new BashDisabledError();
  }

  // v1-2: edit 工具被 hashline_edit 替代（hashline 防止文件变更后误编辑）
  if (input.tool === 'edit') {
    throw new Error(
      'edit tool is disabled by serenity policy (v1-2 hashline edit). ' +
        'Use `hashline_edit` with a pos like "11#VK" (visible in read output) instead. ' +
        'The hash prevents editing the wrong line after the file changes.',
    );
  }
};

/** 工厂：返回 permission guards 相关的 hooks 集合 */
export function createPermissionGuards(config?: HookConfig): Partial<Hooks> {
  const hooks: Partial<Hooks> = {};
  if (isHookEnabled('tool.execute.before', config)) {
    const wrapped = safeHook('tool.execute.before', toolExecuteBeforeImpl, config);
    if (wrapped) hooks['tool.execute.before'] = wrapped;
  }
  return hooks;
}
