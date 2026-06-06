/**
 * 集中日志工具
 *
 * 统一前缀 `[serenity-plugin][tag]` 便于 grep
 * 默认输出到 stderr（避免污染 opencode 的 stdout / tool output stream）
 *
 * 环境变量：
 *  - OPENCODE_SERENITY_DEBUG=1     启用 debug 级日志（仅 stderr）
 *  - OPENCODE_SERENITY_LOG_FILE=/path/to/file   覆盖默认 log 文件路径
 *                                          （默认 = /tmp/serenity-plugin.log）
 *                                          （append + 立即 flush，方便事后 read）
 *
 * **file log 默认**写到 `/tmp/serenity-plugin.log`（无需 env var）——
 * 这是为了诊断 plugin 行为（看到真实 event payload、reply 真实 reply 状态）
 * 关闭方式：设 `OPENCODE_SERENITY_LOG_FILE=/dev/null`
 *
 * 用法：
 *   import { log } from './util/log.js';
 *   log.info('msm', 'calling msm_exec', { name: 'resolve-path' });
 *   log.warn('phase2', 'RR1 failed: ...');
 *   log.error('permission', 'blocked bash');
 *   log.debug('event', 'debug-only-msg', { type, props });
 */

import { appendFileSync, writeFileSync } from 'node:fs';

type Level = 'info' | 'warn' | 'error' | 'debug';

const DEFAULT_LOG_FILE = '/tmp/serenity-plugin.log';

/** 解析 LOG_FILE 路径（env 覆盖默认） */
function getLogFile(): string | null {
  const p = process.env['OPENCODE_SERENITY_LOG_FILE'];
  if (p === '/dev/null') return null;
  return p && p.length > 0 ? p : DEFAULT_LOG_FILE;
}

/** 是否首次写文件（创建空文件 + 写入 header） */
let headerWritten = false;

function writeToFile(line: string): void {
  const file = getLogFile();
  if (!file) return;
  try {
    if (!headerWritten) {
      // 首次：创建/截断文件 + 写 header
      writeFileSync(file, `# serenity-plugin log started ${new Date().toISOString()}\n# log file path: ${file}\n`, 'utf8');
      headerWritten = true;
    }
    appendFileSync(file, line + '\n', 'utf8');
  } catch {
    // 写文件失败不影响 stderr 行为
  }
}

function emit(level: Level, tag: string, msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const prefix = `[serenity-plugin][${tag}]`;
  const tail = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  const line = `${ts} ${prefix} ${msg}${tail}`;

  // 写文件（默认开，不受 debug 限制 —— info/warn/error/debug 全写）
  writeToFile(line);

  // 全部走 stderr（避免干扰 tool output stream）
  switch (level) {
    case 'error':
      // eslint-disable-next-line no-console
      console.error(line);
      break;
    case 'warn':
      // eslint-disable-next-line no-console
      console.warn(line);
      break;
    case 'debug':
      // 仅当 OPENCODE_SERENITY_DEBUG=1 时输出到 stderr
      if (process.env['OPENCODE_SERENITY_DEBUG'] === '1') {
        // eslint-disable-next-line no-console
        console.error(line);
      }
      break;
    case 'info':
    default:
      // eslint-disable-next-line no-console
      console.error(line);
      break;
  }
}

export const log = {
  info: (tag: string, msg: string, data?: Record<string, unknown>) => emit('info', tag, msg, data),
  warn: (tag: string, msg: string, data?: Record<string, unknown>) => emit('warn', tag, msg, data),
  error: (tag: string, msg: string, data?: Record<string, unknown>) => emit('error', tag, msg, data),
  debug: (tag: string, msg: string, data?: Record<string, unknown>) => emit('debug', tag, msg, data),
};
