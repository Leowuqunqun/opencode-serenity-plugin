/**
 * activation 流程单测
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tryActivate } from '../src/activation.js';
import { isActive, resetState } from '../src/state.js';
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

describe('activation.tryActivate', () => {
  beforeEach(() => {
    resetState();
  });

  it('成功路径：git repo + /.serenity + SKILL.md 存在', () => {
    const tmp = makeSerenityRepo('home-serenity');
    const result = tryActivate(fakeInput(tmp));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.instanceName).toBe('home-serenity');
      expect(result.state.cwdRoot).toBe(tmp);
      expect(result.state.activated).toBe(true);
      expect(isActive()).toBe(true);
    }
    rmSync(tmp, { recursive: true });
  });

  it('失败：非 git 目录', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-nogit-'));
    const result = tryActivate(fakeInput(tmp));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/RR6/);
    }
    expect(isActive()).toBe(false);
    rmSync(tmp, { recursive: true });
  });

  it('失败：git repo 但缺 /.serenity', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-noserenity-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
    const result = tryActivate(fakeInput(tmp));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/RR1/);
    }
    rmSync(tmp, { recursive: true });
  });

  it('失败：/.serenity 内容为空', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-empty-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
    writeFileSync(join(tmp, '.serenity'), '   \n');
    const result = tryActivate(fakeInput(tmp));
    expect(result.ok).toBe(false);
    rmSync(tmp, { recursive: true });
  });

  it('失败：/.serenity 存在但 SKILL.md 缺失', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-noskill-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
    writeFileSync(join(tmp, '.serenity'), 'home-serenity');
    const result = tryActivate(fakeInput(tmp));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/RR2/);
    }
    rmSync(tmp, { recursive: true });
  });
});
