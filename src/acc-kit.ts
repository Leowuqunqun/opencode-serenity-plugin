/**
 * acc-kit.ts — ACC Kit tool (v0.8 M0)
 *
 * ACC 通用能力工具包。由 v0.3 ccc-status.ts 升级而来，语义简洁，供任何 agent 使用。
 * 不绑定 resident，不单独新增 tool（用户决策：通用能力整合承载）。
 *
 * actions:
 *   health — CCC 三原则检查（P1 rooted / P2 git-managed / P3 binary permissions）
 *   time   — 当前时间（now_iso / now_local / epoch_ms）
 *   wait   — 等待指定秒数
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { findSerenityRoot } from './fs/resolve-path.js';
import { getState, ensureReady } from './state.js';
import pkg from '../package.json' with { type: 'json' };

const VERSION = pkg.version;

/** 内部：CCC 三原则健康检查（原 ccc-status.ts P1/P2/P3 逻辑迁移） */
function cccHealthCheck(directory: string): string {
  const state = getState();

  const root = findSerenityRoot(directory);

  // P1: .serenity marker exists (文件形态 或 目录形态含 ccc-name)
  const serenityPath = resolve(root, '.serenity');
  const p1Pass = existsSync(serenityPath)
    ? statSync(serenityPath).isFile()
      ? true
      : statSync(serenityPath).isDirectory()
        ? existsSync(resolve(serenityPath, 'ccc-name'))
        : false
    : false;

  // P2: git-managed — state.activated implies git check passed (RR6)
  const p2Pass = state.activated;

  // P3: opencode.json with plugin config
  const opencodeJsonPath = resolve(root, 'opencode.json');
  let p3Pass = false;
  let p3Detail = '';
  if (existsSync(opencodeJsonPath)) {
    p3Pass = true;
    p3Detail = 'opencode.json found';
  } else {
    p3Detail = 'opencode.json not found at CCC root';
  }

  const allPass = p1Pass && p2Pass && p3Pass;

  const report = {
    ccc: state.cccName,
    root,
    version: VERSION,
    status: allPass ? 'healthy' : 'degraded',
    principles: {
      P1_rooted: {
        pass: p1Pass,
        detail: p1Pass ? '.serenity marker found' : '.serenity marker missing',
      },
      P2_git_managed: {
        pass: p2Pass,
        detail: p2Pass ? 'git repository verified' : 'not in a git repository',
      },
      P3_binary_permissions: {
        pass: p3Pass,
        detail: p3Detail,
      },
    },
  };

  return JSON.stringify(report, null, 2);
}

export const accKitTool: ToolDefinition = tool({
  description:
    `ACC Kit tool (v${VERSION}) — ACC 通用能力工具包。语义简洁，供任何 agent 使用。` +
    'actions: health（CCC 三原则检查）/ time（当前时间）/ wait（等待 N 秒）。',
  args: {
    action: z
      .enum(['health', 'time', 'wait'])
      .describe('操作：health / time / wait'),
    seconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('wait action: 等待秒数'),
  },
  execute: async (input, ctx) => {
    await ensureReady();
    switch (input.action) {
      case 'health':
        return cccHealthCheck(ctx.directory);
      case 'time': {
        const now = new Date();
        return JSON.stringify(
          {
            now_iso: now.toISOString(),
            now_local: now.toString(),
            epoch_ms: now.getTime(),
          },
          null,
          2,
        );
      }
      case 'wait': {
        const seconds = input.seconds ?? 1;
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return `waited ${seconds}s`;
      }
    }
  },
});
