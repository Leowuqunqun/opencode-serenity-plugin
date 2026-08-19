/**
 * activation 流程单测 — v0.1 两阶段 init
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tryActivateSync } from '../src/activation.js';
import { isActive, resetState, ensureReady, getState } from '../src/state.js';
import type { PluginInput } from '@opencode-ai/plugin';

/** 构造一个完整的"serenity 工作仓"：git repo + /.serenity + skill 目录 */
function makeSerenityRepo(name = 'home-serenity'): string {
  const tmp = mkdtempSync(join(tmpdir(), 'serenity-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
  writeFileSync(join(tmp, '.serenity'), name);
  const skillDir = join(tmp, '.opencode', 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# skill');
  return tmp;
}

/** 构造一个 fake PluginInput */
function fakeInput(directory: string): PluginInput {
  return {
    directory,
    worktree: directory,
    client: {} as PluginInput['client'],
    project: {} as PluginInput['project'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
    experimental_workspace: { register: () => {} },
  };
}

/** v0.1：fire-and-forget 后等待异步完成 */
async function waitForReady(): Promise<void> {
  await ensureReady();
}

describe('activation.tryActivateSync (v0.1 two-phase init)', () => {
  beforeEach(() => {
    resetState();
  });

  it('成功路径：git repo + /.serenity + SKILL.md 存在', async () => {
    const tmp = makeSerenityRepo('home-serenity');
    const result = tryActivateSync(fakeInput(tmp));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // macOS /var→/private/var：cwdRoot 是 git realpath，tmp 需归一化
      expect(result.cwdRoot).toBe(realpathSync(tmp));
      // Phase 1 同步完成后：state 仍 INACTIVE（Phase 2 后台跑）
      // Phase 2 完成后：state.activated = true
      await waitForReady();
      expect(isActive()).toBe(true);
    }
    rmSync(tmp, { recursive: true });
  });

  it('失败：非 git 目录（RR6 同步短路）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-nogit-'));
    const result = tryActivateSync(fakeInput(tmp));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/RR6/);
    }
    expect(isActive()).toBe(false);
    rmSync(tmp, { recursive: true });
  });

  it('失败：git repo 但缺 /.serenity（RR1 同步短路）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-noserenity-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
    const result = tryActivateSync(fakeInput(tmp));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/RR1/);
    }
    expect(isActive()).toBe(false);
    rmSync(tmp, { recursive: true });
  });

  it('失败：/.serenity 内容为空（RR1 Phase 2 失败）', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-empty-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
    writeFileSync(join(tmp, '.serenity'), '   \n');
    const result = tryActivateSync(fakeInput(tmp));
    expect(result.ok).toBe(true);
    await expect(waitForReady()).rejects.toThrow(/RR1/);
    rmSync(tmp, { recursive: true });
  });

  it('v0.4.1: SKILL.md 缺失 → 不阻断激活（RR2 降级为非致命）', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-noskill-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
    writeFileSync(join(tmp, '.serenity'), 'home-serenity');
    const result = tryActivateSync(fakeInput(tmp));
    expect(result.ok).toBe(true);
    await expect(waitForReady()).resolves.toBeUndefined();
    expect(getState().activated).toBe(true);
    expect(getState().skillPath).toBeNull();
    rmSync(tmp, { recursive: true });
  });
});
