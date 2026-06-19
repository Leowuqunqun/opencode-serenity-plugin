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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SerenityState } from './types/index.js';
import { setState, markReady, markDisabled, getReadyMachine } from './state.js';
import type { PluginInput } from '@opencode-ai/plugin';
import { log } from './util/log.js';
import { checkSerenityConfig } from './util/init-check.js';
import {
  patchMainRepoOpencodeJson,
  type ToastClient,
} from './util/config-patch.js';

export type SyncResult =
  | { ok: true; cwdRoot: string }
  | { ok: false; reason: string };

/**
 * getClient 工厂：可注入，便于测试 mock + 隔离 v1/v2 client 类型
 *
 * 返回类型用 unknown，activation 内部按需 cast 成 ToastClient（v1.18 解耦）。
 */
export type GetClient = () => unknown | null;

/**
 * Phase 1：同步检查 RR6（git repo）。
 * - 失败：mark disabled + console.warn
 * - 成功：启动 Phase 2 fire-and-forget + 立即返回 ok
 *
 * 注：调用方不需 await Phase 2 任何 IO；后续 tools/hooks 会自己 ensureReady()
 */
export function tryActivateSync(input: PluginInput, getClient?: GetClient): SyncResult {
  const cwd = input.directory;
  log.info('phase1', 'start sync activation', { cwd });

  // Phase 1 — RR6 同步检查
  let cwdRoot: string;
  try {
    cwdRoot = findGitRoot(cwd);
    log.info('phase1', 'RR6 ok: cwd in git repo', { cwdRoot });
  } catch (err) {
    const reason = formatErrorMessage(err, 'RR6: cwd not in git repo');
    log.warn('phase1', 'RR6 failed', { reason, cwd });
    markDisabled(reason);
    return { ok: false, reason };
  }

  // Phase 2 — fire-and-forget（不 await）
  const machine = getReadyMachine();
  void machine.start(async () => {
    log.debug('phase2', 'starting async activation', { cwdRoot });
    await activateAsync(cwdRoot, getClient);  // throws on RR1/RR2 failure → machine.markError()
    log.info('phase2', 'activation complete', { cwdRoot });
  });

  return { ok: true, cwdRoot };
}

/**
 * Phase 2：异步激活。
 * 内部 try/catch 所有失败 → machine 自然 catch 并推 error 状态。
 */
async function activateAsync(cwdRoot: string, getClient?: GetClient): Promise<void> {
  // RR1 — 读 /.serenity
  let cccName: string;
  try {
    cccName = readSerenityFile(cwdRoot);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`RR1: ${detail}`);
  }

  // RR2 — 验证 SKILL.md
  let skillPath: string;
  try {
    skillPath = buildSkillPath(cwdRoot, cccName);
    validateSkillExists(skillPath, cwdRoot, cccName);
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

  // Phase 2 骨架检测 — SKILL.md 含骨架标记 → 需要 Agent 深度访谈
  let needsPhase2 = false;
  let phase2Prompt: string | null = null;
  if (skillContent && skillContent.includes('<!-- Phase 2 Agent:')) {
    const promptPath = join(cwdRoot, '.opencode', 'skills', cccName, 'scripts', 'generate-root-skill.prompt.md');
    if (existsSync(promptPath)) {
      try {
        phase2Prompt = readFileSync(promptPath, 'utf8');
        needsPhase2 = true;
        log.info('phase2', 'skeleton detected — Phase 2 interview pending', { promptPath });
      } catch (err) {
        log.warn('phase2', 'Phase 2 prompt read failed; skipping interview trigger', {
          promptPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log.warn('phase2', 'Phase 2 prompt file missing; skeleton detected but cannot trigger interview', { promptPath });
    }
  }

  // 成功 — 写 state + mark ready
  const state: SerenityState = Object.freeze({
    activated: true,
    cwdRoot,
    cccName,
    skillPath,
    skillContent,
    needsPhase2,
    phase2Prompt,
  });
  setState(state);
  markReady();

  // v1.5 init-check：plugin 启动时自检 opencode.json 关键配置
  // 只 warn，不 patch
  checkSerenityConfig(cwdRoot, cccName);

  // v1.7 config-patch：自动改主仓 opencode.json 让 cwdRoot 内 read/edit = allow
  // 用户 m0649 决定"全自动"——plugin 启动即生效（用户需重启 opencode 应用改动）
  if (getClient) {
    try {
      const result = await patchMainRepoOpencodeJson(cwdRoot, () => {
        try {
          return getClient() as ToastClient | null;
        } catch {
          return null;
        }
      });
      if (result.changed) {
        log.info('phase2', 'main-repo opencode.json auto-patched', {
          configPath: result.configPath,
          diff: result.diff,
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn('phase2', 'config-patch failed; plugin continues', { detail });
    }
  }
}

function formatErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
