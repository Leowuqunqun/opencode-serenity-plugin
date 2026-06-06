/**
 * opencode.json 自动 patch 模块（v1.7）
 *
 * 目标：plugin 启动时自动修正主仓 opencode.json（让 cwdRoot 内 read/edit = allow）。
 * 与 v1.5 init-check 的关系：
 * - v1.5 只 warn 不 patch
 * - v1.7 **自动 patch**（用户 m0649 决定"全自动"）
 *
 * 行为：
 * - 幂等（已 "allow" 跳过）
 * - 缺 permission 字段自动补
 * - 自动 `git add + commit`
 * - 失败 log.warn（不阻断 plugin 启动）
 * - 改完调 TUI toast 通知用户
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import { gitAddAndCommit } from './git.js';

export type PatchField = 'read' | 'edit';

export type PatchResult = {
  changed: boolean;
  diff: Array<{ path: string; from: unknown; to: unknown }>;
  configPath: string;
  error?: string;
};

const SERENITY_MARKER_KEY = '$serenity_managed';

const TOAST_TITLE = 'serenity plugin';
const TOAST_DURATION_MS = 8000;

/**
 * 主仓 opencode.json 读 + 解析
 */
function readMainConfig(cwdRoot: string): { config: Record<string, unknown>; path: string } | null {
  const configPath = join(cwdRoot, 'opencode.json');
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const raw = readFileSync(configPath, 'utf8');
    return { config: JSON.parse(raw) as Record<string, unknown>, path: configPath };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('config-patch', 'opencode.json parse error', { path: configPath, err: reason });
    return null;
  }
}

/**
 * 主仓 opencode.json 写（格式化 2-space）
 */
function writeMainConfig(configPath: string, config: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Patch 主仓 opencode.json（idempotent + 自动 commit）
 *
 * 目标：permission.read 和 permission.edit 设为 "allow"
 * 已为 "allow" 跳过；缺 permission 字段自动建
 *
 * @param cwdRoot 主仓根路径
 * @param getClient SDK client 工厂（用于 tui toast 通知）—— 可选
 */
export async function patchMainRepoOpencodeJson(
  cwdRoot: string,
  getClient?: () => { tui?: { showToast: (opts: { body: { title?: string; message: string; variant?: 'info' | 'success' | 'warning' | 'error'; duration?: number } }) => Promise<unknown> } } | null,
): Promise<PatchResult> {
  const fields: PatchField[] = ['read', 'edit'];
  const read = readMainConfig(cwdRoot);
  if (!read) {
    return { changed: false, diff: [], configPath: join(cwdRoot, 'opencode.json'), error: 'opencode.json not found or parse error' };
  }
  const { config, path: configPath } = read;

  // 计算 diff
  const diff: PatchResult['diff'] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perm = (config['permission'] ?? {}) as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newPerm: Record<string, unknown> = { ...(perm as any) };

  for (const f of fields) {
    if (perm[f] === 'allow') continue;
    diff.push({ path: `permission.${f}`, from: perm[f] ?? null, to: 'allow' });
    newPerm[f] = 'allow';
  }

  if (diff.length === 0) {
    log.info('config-patch', 'no changes needed; already allowed', { configPath });
    return { changed: false, diff: [], configPath };
  }

  // 应用 patch
  config['permission'] = newPerm;
  // 加 marker（避免 v1.5 init-check 误报）
  if (!config[SERENITY_MARKER_KEY]) {
    config[SERENITY_MARKER_KEY] = true;
  }

  try {
    writeMainConfig(configPath, config);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('config-patch', 'write failed', { configPath, err: reason });
    return { changed: false, diff, configPath, error: `write failed: ${reason}` };
  }

  log.info('config-patch', 'patched opencode.json', { configPath, diff });

  // 自动 commit（不阻断）
  try {
    gitAddAndCommit(cwdRoot, 'opencode.json', 'chore(serenity): auto-grant read/edit permissions');
    log.info('config-patch', 'auto-committed', { configPath });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('config-patch', 'auto-commit failed; patch is on disk but uncommitted', { configPath, err: reason });
  }

  // TUI toast 通知用户
  const client = getClient?.();
  if (client?.tui?.showToast) {
    try {
      const fieldList = diff.map((d) => d.path.replace('permission.', '')).join(' + ');
      await client.tui.showToast({
        body: {
          title: TOAST_TITLE,
          message: `auto-granted ${fieldList} (restart opencode to apply)`,
          variant: 'info',
          duration: TOAST_DURATION_MS,
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('config-patch', 'tui toast failed (non-blocking)', { err: reason });
    }
  }

  return { changed: true, diff, configPath };
}
