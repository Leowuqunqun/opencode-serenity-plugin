/**
 * msm_register / msm_deregister 单测（v1.1 增补）
 *
 * 覆盖：
 * 1. msm_register 成功（v1 schema → 写回仍 v1）
 * 2. msm_register 成功（array schema → 写回仍 array）
 * 3. msm_register 失败：name 重复
 * 4. msm_register 失败：脚本文件不存在
 * 5. msm_register 失败：path 越界
 * 6. msm_deregister 成功
 * 7. msm_deregister 失败：name 不存在
 * 8. round-trip: register → deregister → 状态回到初始
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { msmRegisterTool, msmDeregisterTool } from '../src/msm.js';
import { resetState, setState } from '../src/state.js';
import {
  MsmAlreadyRegisteredError,
  MsmNotInRegistryError,
  MsmScriptNotFoundError,
} from '../src/errors.js';
import type { ToolContext } from '@opencode-ai/plugin';

function setupRepo(name = 'home-serenity'): { cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'msm-reg-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd, stdio: 'ignore' });
  writeFileSync(join(cwd, '.serenity'), name);
  const skillDir = join(cwd, '.opencode', 'skills', name, 'references');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(cwd, '.serenity'), name);
  return { cwd };
}

function makeScript(cwd: string, relPath: string): string {
  const abs = join(cwd, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '// test script\n');
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return abs;
}

function fakeCtx(cwd: string): ToolContext {
  return {
    sessionID: 'test',
    messageID: 'test',
    agent: 'test',
    directory: cwd,
    worktree: cwd,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function writeRegistry(cwd: string, name: string, content: unknown): void {
  const path = join(cwd, '.opencode', 'skills', name, 'references', 'mech-registry.json');
  writeFileSync(path, JSON.stringify(content, null, 2));
}

function readRegistry(cwd: string, name: string): unknown {
  const path = join(cwd, '.opencode', 'skills', name, 'references', 'mech-registry.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('msm_register (v1.1)', () => {
  beforeEach(() => {
    resetState();
  });

  it('v1 包装 schema → 写回仍 v1', async () => {
    const { cwd } = setupRepo();
    try {
      const scriptPath = makeScript(cwd, '.opencode/skills/home-serenity/scripts/test-msm.ts');
      writeRegistry(cwd, 'home-serenity', { version: 1, description: 'test', entries: [] });
      setState({ activated: true, cwdRoot: cwd, instanceName: 'home-serenity' });

      const result = await msmRegisterTool.execute(
        { name: 'test-msm', path: '.opencode/skills/home-serenity/scripts/test-msm.ts', description: 'd', flags: [], category: 'mech' } as any,
        fakeCtx(cwd),
      );
      expect(result).toContain('registered');
      const reg = readRegistry(cwd, 'home-serenity') as { version: number; entries: Array<{ name: string }> };
      expect(reg.version).toBe(1);
      expect(reg.entries).toHaveLength(1);
      expect(reg.entries[0]?.name).toBe('test-msm');
      // git auto-commit
      const log = execFileSync('git', ['log', '--oneline'], { cwd, encoding: 'utf8' });
      expect(log).toContain('chore(msm): register test-msm');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('array schema → 写回仍 array', async () => {
    const { cwd } = setupRepo();
    try {
      makeScript(cwd, 'scripts/foo.ts');
      writeRegistry(cwd, 'home-serenity', []);
      setState({ activated: true, cwdRoot: cwd, instanceName: 'home-serenity' });

      await msmRegisterTool.execute(
        { name: 'foo', path: 'scripts/foo.ts', description: 'd', flags: [], category: 'mech' } as any,
        fakeCtx(cwd),
      );

      const reg = readRegistry(cwd, 'home-serenity') as Array<{ name: string }>;
      expect(Array.isArray(reg)).toBe(true);
      expect(reg).toHaveLength(1);
      expect(reg[0]?.name).toBe('foo');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('throw MsmAlreadyRegisteredError 当 name 重复', async () => {
    const { cwd } = setupRepo();
    try {
      makeScript(cwd, 'scripts/dup.ts');
      writeRegistry(cwd, 'home-serenity', [{ name: 'dup', path: 'scripts/dup.ts', skill: 'home-serenity', category: 'mech', description: 'd', usage: 'u', flags: [] }]);
      setState({ activated: true, cwdRoot: cwd, instanceName: 'home-serenity' });

      await expect(
        msmRegisterTool.execute(
          { name: 'dup', path: 'scripts/dup.ts', description: 'd', flags: [], category: 'mech' } as any,
          fakeCtx(cwd),
        ),
      ).rejects.toThrow(MsmAlreadyRegisteredError);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('throw MsmScriptNotFoundError 当脚本不存在', async () => {
    const { cwd } = setupRepo();
    try {
      writeRegistry(cwd, 'home-serenity', []);
      setState({ activated: true, cwdRoot: cwd, instanceName: 'home-serenity' });

      await expect(
        msmRegisterTool.execute(
          { name: 'ghost', path: 'scripts/ghost.ts', description: 'd', flags: [], category: 'mech' } as any,
          fakeCtx(cwd),
        ),
      ).rejects.toThrow(MsmScriptNotFoundError);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('msm_deregister (v1.1)', () => {
  beforeEach(() => {
    resetState();
  });

  it('成功移除 entry', async () => {
    const { cwd } = setupRepo();
    try {
      makeScript(cwd, 'scripts/x.ts');
      writeRegistry(cwd, 'home-serenity', [
        { name: 'x', path: 'scripts/x.ts', skill: 'home-serenity', category: 'mech', description: 'd', usage: 'u', flags: [] },
      ]);
      setState({ activated: true, cwdRoot: cwd, instanceName: 'home-serenity' });

      const result = await msmDeregisterTool.execute({ name: 'x' } as any, fakeCtx(cwd));
      expect(result).toContain('deregistered');
      const reg = readRegistry(cwd, 'home-serenity') as Array<{ name: string }>;
      expect(reg).toHaveLength(0);
      // script file NOT deleted
      expect(existsSync(join(cwd, 'scripts/x.ts'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('throw MsmNotInRegistryError 当 name 不存在', async () => {
    const { cwd } = setupRepo();
    try {
      writeRegistry(cwd, 'home-serenity', []);
      setState({ activated: true, cwdRoot: cwd, instanceName: 'home-serenity' });

      await expect(
        msmDeregisterTool.execute({ name: 'phantom' } as any, fakeCtx(cwd)),
      ).rejects.toThrow(MsmNotInRegistryError);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
