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
    await ensureReady();
    const state = getState();

    // 路径必须在 cwdRoot 内（RR5）
    const absPath = resolvePath(state.cwdRoot, input.path);
    if (!isPathInside(state.cwdRoot, absPath)) {
      throw new Error(`hashline_edit: path "${input.path}" is outside cwdRoot; serenity plugin blocks access`);
    }
    if (!existsSync(absPath)) {
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
      throw new Error(`hashline_edit: pos ${input.pos} out of range (file has ${lines.length} lines)`);
    }
    lines[idx] = input.new_content;
    const newContent = lines.join('\n') + (lastIsEmpty ? '\n' : '');
    writeFileSync(absPath, newContent, 'utf8');

    return `edited ${absPath}: line ${parsed.line} replaced`;
  },
});

/* ===== read 后处理 hook ===== */

/**
 * tool.execute.after hook：read 工具的输出后处理
 * - 仅在 plugin 激活时生效
 * - 仅对 tool === 'read' 处理
 * - 仅对 cwdRoot 内的路径处理（read 工具可能读 cwdRoot 外，但 path 由 tool 内部处理；这里保守：所有 read 输出都加 hashline 注释，LLM 看到的统一是 hashline 格式）
 */
export function readAnnotatorHook(
  input: { tool: string; sessionID: string; callID: string; args: any },
  _output: { title: string; output: string; metadata: any },
): Promise<void> {
  return Promise.resolve().then(() => {
    if (input.tool !== 'read') return;
    const state = getState();
    if (!state.activated) return;
    if (typeof _output.output !== 'string') return;
    // 跳过已被注释过的输出（避免重复）
    if (/^\d+#\w{2}\|/m.test(_output.output)) return;
    try {
      _output.output = annotateLines(_output.output);
    } catch {
      // 注释失败不影响原输出
    }
  });
}

/* ===== 错误再导出 ===== */
export { HashlinePosFormatError, HashlineMismatchError };
