/**
 * bash-toggle.ts — Bash 开关状态管理（文件 IPC）
 *
 * 架构：
 *   TUI entry（slash command） ──写入──→  /tmp/serenity-bash-state
 *   Server entry（hook）       ──读取──→  /tmp/serenity-bash-state
 *
 * 因为 TUI 和 Server 是两个独立的 Node.js 进程，模块级变量不共享。
 * 用 /tmp 文件作为 IPC 通道。/tmp 重启即清，符合"不保留"要求。
 *
 * 默认值：bash 启用（bashDisabled = false）。文件不存在时视为启用。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from './util/log.js';

const STATE_FILE = join(tmpdir(), 'serenity-bash-state');

/** bash 是否被禁用（默认 false = 启用） */
export function isBashDisabled(): boolean {
  try {
    if (!existsSync(STATE_FILE)) return false;
    const content = readFileSync(STATE_FILE, 'utf8').trim();
    return content === 'true';
  } catch {
    return false;
  }
}

/** 设置 bash 禁用状态 */
export function setBashDisabled(v: boolean): void {
  try {
    writeFileSync(STATE_FILE, v ? 'true' : 'false', 'utf8');
    log.info('bash-toggle', `bash ${v ? 'disabled' : 'enabled'}`);
  } catch (err) {
    log.warn('bash-toggle', 'failed to write state file', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
