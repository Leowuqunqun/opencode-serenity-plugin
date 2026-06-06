/**
 * 集中日志工具
 *
 * 统一前缀 `[serenity-plugin][tag]` 便于 grep
 * 默认输出到 stderr（避免污染 opencode 的 stdout / tool output stream）
 *
 * 环境变量：
 *  - OPENCODE_SERENITY_DEBUG=1     启用 debug 级日志
 *  - OPENCODE_SERENITY_LOG_FILE=/path/to/file   镜像所有日志到文件
 *                                          （append + 立即 flush，方便事后 read）
 *
 * 用法：
 *   import { log } from './util/log.js';
 *   log.info('msm', 'calling msm_exec', { name: 'resolve-path' });
 *   log.warn('phase2', 'RR1 failed: ...');
 *   log.error('permission', 'blocked bash');
 *   log.debug('event', 'RAW EVENT', { type, props });
 */

import { appendFileSync, writeFileSync } from 'node:fs';

type Level = 'info' | 'warn' | 'error' | 'debug';

/** 解析 LOG_FILE 路径（可能在每次 emit 时变，便于运行时切换） */
function getLogFile(): string | null {
  const p = process.env['OPENCODE_SERENITY_LOG_FILE'];
  return p && p.length > 0 ? p : null;
}

/** 是否首次写文件（创建空文件 + 写入 header） */
let headerWritten = false;

function writeToFile(line: string): void {
  const file = getLogFile();
  if (!file) return;
  try {
    if (!headerWritten) {
      // 首次：创建/截断文件 + 写 header
      writeFileSync(file, `# serenity-plugin log started ${new Date().toISOString()}\n`, 'utf8');
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

  // 写文件（始终写，不受 debug 限制；LOG_FILE 是显式 opt-in）
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
