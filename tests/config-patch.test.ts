/**
 * config-patch 单测（v1.7）
 *
 * 覆盖：
 * 1. 已 allow → no-op
 * 2. ask → allow + 写文件 + commit + diff 正确
 * 3. 缺 permission 字段 → 补字段
 * 4. 文件不存在 → 失败不抛
 * 5. 加 marker `// serenity-managed`
 * 6. 调 getClient 时 TUI toast 失败不阻断
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { patchMainRepoOpencodeJson } from '../src/util/config-patch.js';

function makeRepo(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'config-patch-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

function writeOpencodeJson(cwd: string, content: object): void {
  writeFileSync(join(cwd, 'opencode.json'), JSON.stringify(content, null, 2) + '\n');
}

describe('config-patch (v1.7)', () => {
  it('no-op when read + edit 已经是 allow', async () => {
    const cwd = makeRepo();
    try {
      writeOpencodeJson(cwd, {
        permission: { bash: 'deny', read: 'allow', edit: 'allow' },
      });
      const result = await patchMainRepoOpencodeJson(cwd);
      expect(result.changed).toBe(false);
      expect(result.diff).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('ask → allow + 写文件 + diff 正确', async () => {
    const cwd = makeRepo();
    try {
      writeOpencodeJson(cwd, {
        permission: { bash: 'deny', read: 'ask', edit: 'ask' },
      });
      const result = await patchMainRepoOpencodeJson(cwd);
      expect(result.changed).toBe(true);
      expect(result.diff).toEqual([
        { path: 'permission.read', from: 'ask', to: 'allow' },
        { path: 'permission.edit', from: 'ask', to: 'allow' },
      ]);
      // 验证文件真的改了
      const after = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8'));
      expect(after.permission.read).toBe('allow');
      expect(after.permission.edit).toBe('allow');
      // 验证其他字段不动
      expect(after.permission.bash).toBe('deny');
      // 验证 marker
      expect(after['// serenity-managed']).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('缺 permission 字段 → 补', async () => {
    const cwd = makeRepo();
    try {
      writeOpencodeJson(cwd, { default_agent: 'test' });
      const result = await patchMainRepoOpencodeJson(cwd);
      expect(result.changed).toBe(true);
      const after = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8'));
      expect(after.permission.read).toBe('allow');
      expect(after.permission.edit).toBe('allow');
      expect(after.default_agent).toBe('test');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('文件不存在 → 失败返回 error 不抛', async () => {
    const cwd = makeRepo();
    try {
      // 不写 opencode.json
      const result = await patchMainRepoOpencodeJson(cwd);
      expect(result.changed).toBe(false);
      expect(result.error).toMatch(/not found|parse/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('getClient tui toast 失败不阻断', async () => {
    const cwd = makeRepo();
    try {
      writeOpencodeJson(cwd, { permission: { read: 'ask' } });
      const result = await patchMainRepoOpencodeJson(cwd, () => ({
        tui: {
          showToast: async () => {
            throw new Error('mock toast failure');
          },
        },
      }));
      // 仍应成功
      expect(result.changed).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('完整流程：read ask → allow + 自动 commit', async () => {
    const cwd = makeRepo();
    try {
      writeOpencodeJson(cwd, { permission: { read: 'ask' } });
      // 先 commit opencode.json（不然 git add + commit 失败）
      execFileSync('git', ['add', 'opencode.json'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init opencode.json'], { cwd, stdio: 'ignore' });
      const result = await patchMainRepoOpencodeJson(cwd);
      expect(result.changed).toBe(true);
      // 验证 git log 有新 commit
      const log = execFileSync('git', ['log', '--oneline'], { cwd, encoding: 'utf8' });
      expect(log).toMatch(/chore\(serenity\): auto-grant read\/edit permissions/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
