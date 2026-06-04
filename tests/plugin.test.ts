/**
 * plugin 入口单测 — smoke test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import plugin from '../src/index.js';
import { resetState } from '../src/state.js';
import type { PluginInput } from '@opencode-ai/plugin';

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

function makeSerenityRepo(name = 'home-serenity'): string {
  const tmp = mkdtempSync(join(tmpdir(), 'serenity-repob-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
  writeFileSync(join(tmp, '.serenity'), name);
  const skillDir = join(tmp, '.opencode', 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# skill');
  return tmp;
}

describe('plugin entry', () => {
  beforeEach(() => {
    resetState();
  });

  it('plugin 是默认 export 的 async function', () => {
    expect(typeof plugin).toBe('function');
  });

  it('不激活时返回空 Hooks', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-inactive-'));
    const hooks = await plugin(fakeInput(tmp));
    expect(hooks).toEqual({});
    rmSync(tmp, { recursive: true });
  });

  it('激活时返回带 tool/hook 的 Hooks', async () => {
    const tmp = makeSerenityRepo('home-serenity');
    const hooks = await plugin(fakeInput(tmp));
    expect(hooks.tool).toBeDefined();
    if (hooks.tool) {
      expect(hooks.tool['bash']).toBeDefined();
      expect(hooks.tool['msm_list']).toBeDefined();
      expect(hooks.tool['msm_exec']).toBeDefined();
    }
    expect(hooks['tool.execute.before']).toBeDefined();
    expect(hooks['experimental.chat.system.transform']).toBeDefined();
    rmSync(tmp, { recursive: true });
  });
});
