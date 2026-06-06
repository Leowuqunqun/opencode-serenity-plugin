/**
 * 10 步启动协议 — v0.1 两阶段 init
 *
 * 旧 v0：one-phase sync（tryActivate 一次 await 完所有 IO）
 * 新 v0.1：two-phase
 *   Phase 1 同步（plugin 入口立即返回）：
 *     - RR6 检查 cwd 是否在 git repo → 失败：mark disabled，返回
 *     - 成功：启动 Phase 2 fire-and-forget
 *   Phase 2 异步（后台 IO）：
 *     - RR1 读 /.serenity → 失败：state.error
 *     - RR2 验证 SKILL.md 存在 → 失败：state.error
 *     - 成功：setState + mark ready
 *
 * 关键设计：tools/hooks 通过 `ensureReady()` 阻塞等待 Phase 2 完成。
 *
 * 不抛错——所有失败路径通过 state/console.warn 表达。
 */

import { findGitRoot } from './util/git.js';
import { readSerenityFile } from './util/serenity-file.js';
import { buildSkillPath, validateSkillExists } from './util/path.js';
import { readFileSync } from 'node:fs';
import type { SerenityState } from './types/index.js';
import { setState, markReady, markDisabled, getReadyMachine } from './state.js';
import type { PluginInput } from '@opencode-ai/plugin';
import { log } from './util/log.js';

export type SyncResult =
  | { ok: true; cwdRoot: string }
  | { ok: false; reason: string };

/**
 * Phase 1：同步检查 RR6（git repo）。
 * - 失败：mark disabled + console.warn
 * - 成功：启动 Phase 2 fire-and-forget + 立即返回 ok
 *
 * 注：调用方不需 await Phase 2 任何 IO；后续 tools/hooks 会自己 ensureReady()
 */
export function tryActivateSync(input: PluginInput): SyncResult {
  const cwd = input.directory;
  log.info('phase1', 'start sync activation', { cwd });

  // Phase 1 — RR6 同步检查
  let cwdRoot: string;
  try {
    cwdRoot = findGitRoot(cwd);
    log.info('phase1', 'RR6 ok: cwd in git repo', { cwdRoot });
  } catch (err) {
    const reason = errMsg(err, 'RR6: cwd not in git repo');
    log.warn('phase1', 'RR6 failed', { reason, cwd });
    markDisabled(reason);
    return { ok: false, reason };
  }

  // Phase 2 — fire-and-forget（不 await）
  const machine = getReadyMachine();
  void machine.start(async () => {
    log.debug('phase2', 'starting async activation', { cwdRoot });
    await activateAsync(cwdRoot);  // throws on RR1/RR2 failure → machine.markError()
    log.info('phase2', 'activation complete', { cwdRoot });
  });

  return { ok: true, cwdRoot };
}

/**
 * Phase 2：异步激活。
 * 内部 try/catch 所有失败 → machine 自然 catch 并推 error 状态。
 */
async function activateAsync(cwdRoot: string): Promise<void> {
  // RR1 — 读 /.serenity
  let instanceName: string;
  try {
    instanceName = readSerenityFile(cwdRoot);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`RR1: ${detail}`);
  }

  // RR2 — 验证 SKILL.md
  let skillPath: string;
  try {
    skillPath = buildSkillPath(cwdRoot, instanceName);
    validateSkillExists(skillPath, cwdRoot, instanceName);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`RR2: ${detail}`);
  }

  // RR2.5 — 读 SKILL.md 全文（用于 system.transform 注入）
  // 失败：降级为 null（plugin 仍工作，只是不注 SKILL.md）
  let skillContent: string | null = null;
  try {
    skillContent = readFileSync(skillPath, 'utf8');
    log.debug('phase2', 'SKILL.md loaded', { bytes: skillContent.length, skillPath });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('phase2', 'SKILL.md read failed; will skip system.transform injection', { detail, skillPath });
  }

  // 成功 — 写 state + mark ready
  const state: SerenityState = Object.freeze({
    activated: true,
    cwdRoot,
    instanceName,
    skillPath,
    skillContent,
  });
  setState(state);
  markReady();
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
