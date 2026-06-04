/**
 * 同名 bash tool — RR3 核心实现
 *
 * 通过注册同名 `bash` tool 覆盖 opencode 内置 bash
 * execute 内部抛 BashDisabledError
 * L3 验证：同名 tool 后注册覆盖前注册（registry.ts:271 + tools.ts:83）
 */

import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { BashDisabledError } from './errors.js';

export const bashOverrideTool: ToolDefinition = tool({
  description:
    '[SERENITY OVERRIDE] The native `bash` tool is **disabled by serenity policy (RR3)**. ' +
    'Use `msm_list` to discover available MSMs, then `msm_exec` to invoke one. ' +
    'If you need a new shell operation, ask the user to register a new MSM in mech-registry.json first.',
  args: {
    command: z.string().describe('(disabled)'),
    description: z.string().optional().describe('(disabled)'),
  },
  execute: async () => {
    // 抛错：opencode 把错误返回给 LLM，让 LLM 看到为什么不能调 bash
    throw new BashDisabledError();
  },
});
