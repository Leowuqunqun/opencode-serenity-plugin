/**
 * 集中日志工具 — v1-3 验证期使用
 *
 * 统一前缀 `[serenity-plugin][tag]` 便于 grep
 * 输出到 stderr 避免污染 opencode 的 stdout（tool output stream）
 *
 * 用法：
 *   import { log } from './util/log.js';
 *   log.info('msm', 'calling msm_exec', { name: 'resolve-path' });
 *   log.warn('phase2', 'RR1 failed: ...');
 *   log.error('permission', 'blocked bash');
 */

type Level = 'info' | 'warn' | 'error' | 'debug';

function emit(level: Level, tag: string, msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const prefix = `[serenity-plugin][${tag}]`;
  const tail = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  const line = `${ts} ${prefix} ${msg}${tail}`;

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
      // 仅当 OPENCODE_SERENITY_DEBUG=1 时输出
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
