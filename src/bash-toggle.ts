/**
 * bash-toggle.ts — Bash 开关状态管理（多源级联 + 自动检测）
 *
 * 架构（v3 — Server 自动检测）：
 *   优先级从高到低：
 *     1. SERENITY_BASH_DISABLED 环境变量（部署/容器，显式覆盖）
 *     2. CCC-root .serenity-bash-off 标记文件（持久，agent 可通过 cc-fs 管理）
 *     3. /tmp/serenity-bash-state（TUI 运行时，向后兼容）
 *     4. Server 自动检测（opencode web / serve → 默认关闭）
 *     5. 默认：启用
 *
 * 场景覆盖：
 *   - TUI 用户：/serenity-bash-off|on|status 斜杠命令
 *   - WebUI/Server 用户：自动检测 → bash 默认关闭；可通过 env var 覆盖
 *   - 容器/部署：SERENITY_BASH_DISABLED=true 环境变量
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { log } from './util/log.js';

const STATE_FILE = join(tmpdir(), 'serenity-bash-state');

const MARKER_FILENAME = '.serenity-bash-off';

/** 获取 CCC-root 标记文件路径（传入 cwdRoot 时启用） */
function getMarkerFile(cwdRoot?: string): string | null {
  return cwdRoot ? resolve(join(cwdRoot, MARKER_FILENAME)) : null;
}

/**
 * 检测是否运行在 server/WebUI 模式。
 *
 * opencode 启动进程的 argv 中包含 subcommand：
 *   - `opencode web`  → WebUI
 *   - `opencode serve` → Headless server
 *   - `opencode` (无 subcommand) → TUI
 *
 * 此检测在测试环境中不会误触发（vitest 的 argv 不含 web/serve）。
 */
function isServerMode(): boolean {
  return process.argv.some(a => a === 'web' || a === 'serve');
}

/**
 * bash 是否被禁用（多源级联）
 *
 * @param cwdRoot - CCC 根目录（传入后启用 CCC-root 标记文件检测）
 */
export function isBashDisabled(cwdRoot?: string): boolean {
  // 1. 环境变量（最高优先级 — 用户显式覆盖一切）
  const env = process.env.SERENITY_BASH_DISABLED;
  if (env === 'true') return true;
  if (env === 'false') return false;

  // 2. CCC-root 标记文件（持久 per-CCC）
  const marker = getMarkerFile(cwdRoot);
  if (marker && existsSync(marker)) return true;

  // 3. /tmp 运行时状态（TUI 斜杠命令）
  try {
    if (existsSync(STATE_FILE)) {
      const content = readFileSync(STATE_FILE, 'utf8').trim();
      return content === 'true';
    }
  } catch {
    // ignore
  }

  // 4. Server 自动检测：WebUI/Headless Server 无 TUI → 默认关闭
  //    用户可通 env var (SERENITY_BASH_DISABLED=false) 或标记文件覆盖
  if (isServerMode()) return true;

  // 5. 默认：启用（TUI 模式）
  return false;
}

/**
 * 设置 bash 禁用状态
 *
 * 写入 /tmp 运行时文件（TUI 向后兼容）。
 * 当 cwdRoot 传入时，同时写入/删除 CCC-root 标记文件实现持久化。
 */
export function setBashDisabled(v: boolean, cwdRoot?: string): void {
  // 写 /tmp 运行时
  try {
    writeFileSync(STATE_FILE, v ? 'true' : 'false', 'utf8');
  } catch (err) {
    log.warn('bash-toggle', 'failed to write /tmp state file', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 写/删 CCC-root 标记文件（持久化）
  const marker = getMarkerFile(cwdRoot);
  if (marker) {
    try {
      if (v) {
        writeFileSync(marker, '', 'utf8');
        log.info('bash-toggle', `created ${marker}`);
      } else {
        if (existsSync(marker)) {
          rmSync(marker, { force: true });
          log.info('bash-toggle', `removed ${marker}`);
        }
      }
    } catch (err) {
      log.warn('bash-toggle', 'failed to update CCC-root marker', {
        marker,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('bash-toggle', `bash ${v ? 'disabled' : 'enabled'}`);
}
