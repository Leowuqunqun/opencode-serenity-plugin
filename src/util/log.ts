/**
 * 集中日志工具（v0.0.1: 全部 no-op，release 静默）
 *
 * v0.0.1 设计: release 版本应**完全静默**。
 * 错误可见性走 SDK hook 的 throw（→ opencode error UI）或 permission prompt（→ 用户 UI）。
 *
 * 调试方式（任一）：
 *   1. 临时改本文件，把 noop 换成 console.error
 *   2. `pnpm test` 看 vitest 输出
 *   3. 在具体 call site 加 `throw new Error(...)` 临时透出问题
 *
 * 用法保持向后兼容（65 处 call site 不变）：
 *   import { log } from './util/log.js';
 *   log.info('msm', 'calling msm_exec');  // → no-op
 *   log.warn('phase2', 'RR1 failed');     // → no-op
 *   log.error('permission', 'blocked');   // → no-op
 *   log.debug('event', '...');            // → no-op
 */

type Level = 'info' | 'warn' | 'error' | 'debug';

function logFn(level: Level, tag: string, msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  console.error(`[serenity:${level}:${tag}] ${ts} ${msg}${dataStr}`);
}

export const log = {
  info: (tag: string, msg: string, data?: Record<string, unknown>) => logFn('info', tag, msg, data),
  warn: (tag: string, msg: string, data?: Record<string, unknown>) => logFn('warn', tag, msg, data),
  error: (tag: string, msg: string, data?: Record<string, unknown>) => logFn('error', tag, msg, data),
  debug: (tag: string, msg: string, data?: Record<string, unknown>) => logFn('debug', tag, msg, data),
};
