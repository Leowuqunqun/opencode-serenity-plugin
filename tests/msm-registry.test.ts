/**
 * msm registry loader 单测（v1.1 修复 mech-registry v1 schema）
 *
 * 覆盖：
 * 1. 数组格式：[...] → 直接返回
 * 2. v1 包装格式：{ version, description, entries: [...] } → 返回 entries
 * 3. 错误格式：顶层是对象但无 entries → 返回 []
 * 4. 错误格式：顶层既不是数组也不是对象 → 返回 []
 * 5. 文件不存在 → 返回 []
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMechRegistryFrom } from '../src/msm.js';

function setup(): string {
  return mkdtempSync(join(tmpdir(), 'msm-loader-test-'));
}

function cleanup(tmp: string) {
  rmSync(tmp, { recursive: true, force: true });
}

describe('loadMechRegistryFrom', () => {
  it('数组格式直接返回', () => {
    const tmp = setup();
    try {
      const skillDir = join(tmp, '.opencode', 'skills', 'home-serenity', 'references');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'mech-registry.json'),
        JSON.stringify([
          { name: 'ssh-connect', path: 'scripts/ssh.ts', skill: 'home-serenity', category: 'mech', description: 'ssh', usage: 'ssh', flags: [] },
          { name: 'resolve-path', path: 'scripts/rp.ts', skill: 'home-serenity', category: 'mech', description: 'rp', usage: 'rp', flags: [] },
        ]),
      );
      const entries = loadMechRegistryFrom(tmp, 'home-serenity');
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name)).toEqual(['ssh-connect', 'resolve-path']);
    } finally {
      cleanup(tmp);
    }
  });

  it('v1 包装格式（{version, entries}）→ 取 entries 数组', () => {
    const tmp = setup();
    try {
      const skillDir = join(tmp, '.opencode', 'skills', 'home-serenity', 'references');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'mech-registry.json'),
        JSON.stringify({
          version: 1,
          description: 'test',
          entries: [
            { name: 'mech-a', path: 'scripts/a.ts', skill: 'home-serenity', category: 'mech', description: 'a', usage: 'a', flags: [] },
          ],
        }),
      );
      const entries = loadMechRegistryFrom(tmp, 'home-serenity');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe('mech-a');
    } finally {
      cleanup(tmp);
    }
  });

  it('顶层是对象但无 entries → 返回 []', () => {
    const tmp = setup();
    try {
      const skillDir = join(tmp, '.opencode', 'skills', 'home-serenity', 'references');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'mech-registry.json'), JSON.stringify({ version: 1 }));
      const entries = loadMechRegistryFrom(tmp, 'home-serenity');
      expect(entries).toEqual([]);
    } finally {
      cleanup(tmp);
    }
  });

  it('顶层是 null 或字符串 → 返回 []', () => {
    const tmp = setup();
    try {
      const skillDir = join(tmp, '.opencode', 'skills', 'home-serenity', 'references');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'mech-registry.json'), JSON.stringify('not a registry'));
      const entries = loadMechRegistryFrom(tmp, 'home-serenity');
      expect(entries).toEqual([]);
    } finally {
      cleanup(tmp);
    }
  });

  it('文件不存在 → 返回 []', () => {
    const tmp = setup();
    try {
      const entries = loadMechRegistryFrom(tmp, 'home-serenity');
      expect(entries).toEqual([]);
    } finally {
      cleanup(tmp);
    }
  });
});
