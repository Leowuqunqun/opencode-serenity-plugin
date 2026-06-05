/**
 * Hashline Edit 集成（v1-2）
 *
 * 核心思路：
 * 1. read 工具的输出被 hashline-annotate（每行加 LINE#ID| 前缀）
 * 2. edit 工具被拦截（提示 LLM 改用 hashline_edit）
 * 3. hashline_edit 工具接受 pos + newContent，验证 pos 哈希匹配后替换
 *
 * 与 opencode 内置 edit 区别：
 * - 内置 edit：基于"oldString 精确匹配"（受 LLM 注意力 + 文件变更影响大）
 * - hashline_edit：基于"行号 + 内容哈希"（文件变更时哈希变 → 自动拒绝）
 *
 * 数据（oh-my-opencode README）：Grok Code Fast 1 从 6.7% → 68.3% edit 成功率
 *
 * 文件结构：
 * - util.ts — 核心算法（hashLine / annotate / parsePos / verifyPos）
 * - edit-tool.ts（本文件）— hashlineEdit tool + hooks 集成
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
  annotateLines,
  parsePos,
  verifyPos,
  HashlinePosFormatError,
  HashlineMismatchError,
} from './util.js';
import { isPathInside } from '../util/git.js';
import { getState, ensureReady } from '../state.js';
import { log } from '../util/log.js';

/* ===== hashline_edit tool ===== */

export const hashlineEditTool: ToolDefinition = tool({
  description:
    'Edit a single line in a file by hashline position. The pos format is "{lineNo}#{id}" ' +
    '(e.g. "11#VK"), as shown in the annotated read output (each line has prefix "{lineNo}#{id}|"). ' +
    'The id is a content hash; if the file changed since read, the hash will mismatch and the edit is rejected. ' +
    '**Direct `edit` is disabled by serenity policy (v1-2); use hashline_edit instead.**',
  args: {
    path: z.string().describe('absolute path to the file to edit (must be inside cwdRoot)'),
    pos: z.string().describe('line position in format "{lineNo}#{id}" (e.g. "11#VK")'),
    new_content: z.string().describe('new content for the line (the full replacement line)'),
  },
  execute: async (input) => {
    log.info('hashline', 'hashline_edit called', { path: input.path, pos: input.pos });
    await ensureReady();
    const state = getState();

    // 路径必须在 cwdRoot 内（RR5）
    const absPath = resolvePath(state.cwdRoot, input.path);
    if (!isPathInside(state.cwdRoot, absPath)) {
      log.warn('hashline', 'blocked: path outside cwdRoot', { path: input.path, absPath });
      throw new Error(`hashline_edit: path "${input.path}" is outside cwdRoot; serenity plugin blocks access`);
    }
    if (!existsSync(absPath)) {
      log.warn('hashline', 'blocked: file not found', { absPath });
      throw new Error(`hashline_edit: file not found: ${absPath}`);
    }

    // 解析 pos + 验证哈希
    const parsed = parsePos(input.pos);  // throws HashlinePosFormatError on bad format
    const content = readFileSync(absPath, 'utf8');
    verifyPos(parsed, content);  // throws HashlineMismatchError on hash mismatch

    // 替换该行
    const lines = content.split('\n');
    const lastIsEmpty = lines.length > 0 && lines[lines.length - 1] === '';
    if (lastIsEmpty) lines.pop();

    const idx = parsed.line - 1;
    if (idx < 0 || idx >= lines.length) {
      log.warn('hashline', 'pos out of range', { pos: input.pos, lineCount: lines.length });
      throw new Error(`hashline_edit: pos ${input.pos} out of range (file has ${lines.length} lines)`);
    }
    const oldContent = lines[idx];
    lines[idx] = input.new_content;
    const newContent = lines.join('\n') + (lastIsEmpty ? '\n' : '');
    writeFileSync(absPath, newContent, 'utf8');

    log.info('hashline', 'edit applied', { absPath, line: parsed.line, oldLen: oldContent?.length, newLen: input.new_content.length });
    return `edited ${absPath}: line ${parsed.line} replaced`;
  },
});

/* ===== read 后处理 hook ===== */

/**
 * tool.execute.after hook：read 工具的输出后处理
 * - 仅在 plugin 激活时生效
 * - 仅对 tool === 'read' 处理
 */
export function readAnnotatorHook(
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
): Promise<void> {
  return Promise.resolve().then(() => {
    if (input.tool !== 'read') return;
    const state = getState();
    if (!state.activated) {
      log.debug('read-hook', 'skip: not activated');
      return;
    }
    if (typeof output.output !== 'string') return;
    // 跳过已被注释过的输出（避免重复）
    if (/^\d+#\w{2}\|/m.test(output.output)) {
      log.debug('read-hook', 'skip: already annotated');
      return;
    }
    try {
      const before = output.output.length;
      output.output = annotateLines(output.output);
      log.info('read-hook', 'read output annotated', { before, after: output.output.length, lineCount: output.output.split('\n').length });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn('read-hook', 'annotate failed; passing through', { error: detail });
    }
  });
}

/* ===== edit 拦截 hook ===== */

const EDIT_BLOCKED_MSG =
  'edit tool is disabled by serenity policy (v1-2 hashline edit). ' +
  'Use `hashline_edit` with a pos like "11#VK" (visible in read output) instead. ' +
  'The hash prevents editing the wrong line after the file changes.';

/**
 * tool.execute.before hook：edit 工具拦截
 * - 抛错 = 中断整条 Effect 链（按 b1 块 L3 验证）
 * - 错误信息直接告诉 LLM 改用 hashline_edit
 */
export function editInterceptorHook(
  input: { tool: string; sessionID: string; callID: string; args: any },
  _output: { args: any },
): Promise<void> {
  return Promise.resolve().then(() => {
    if (input.tool !== 'edit') return;
    const state = getState();
    if (!state.activated) return;
    log.info('edit-hook', 'blocked edit tool; LLM should use hashline_edit', { args: input.args });
    throw new Error(EDIT_BLOCKED_MSG);
  });
}

/* ===== 错误再导出 ===== */
export { HashlinePosFormatError, HashlineMismatchError };
