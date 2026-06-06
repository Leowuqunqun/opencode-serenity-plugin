/**
 * v1.5 init-check 单测
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSerenityConfig } from '../src/util/init-check.js';

function setup(): string {
  return mkdtempSync(join(tmpdir(), 'init-check-test-'));
}

function cleanup(tmp: string) {
  rmSync(tmp, { recursive: true, force: true });
}

describe('checkSerenityConfig', () => {
  it('opencode.json 不存在 → ok=false', () => {
    const tmp = setup();
    try {
      const r = checkSerenityConfig(tmp, 'home-serenity');
      expect(r.ok).toBe(false);
      expect(r.warnings.some((w) => w.includes('opencode.json not found'))).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });

  it('opencode.json 缺 default_agent → warn', () => {
    const tmp = setup();
    try {
      writeFileSync(join(tmp, 'opencode.json'), JSON.stringify({ agent: {} }));
      const r = checkSerenityConfig(tmp, 'home-serenity');
      expect(r.warnings.some((w) => w.includes("missing 'default_agent'"))).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });

  it('default_agent 不匹配 → warn', () => {
    const tmp = setup();
    try {
      writeFileSync(join(tmp, 'opencode.json'), JSON.stringify({ default_agent: 'build', agent: {} }));
      const r = checkSerenityConfig(tmp, 'home-serenity');
      expect(r.warnings.some((w) => w.includes('expected "home-serenity"'))).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });

  it('agent 字典缺实例条目 → warn', () => {
    const tmp = setup();
    try {
      writeFileSync(
        join(tmp, 'opencode.json'),
        JSON.stringify({ default_agent: 'home-serenity', agent: { build: {} } }),
      );
      const r = checkSerenityConfig(tmp, 'home-serenity');
      expect(r.warnings.some((w) => w.includes('agent dictionary missing entry'))).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });

  it('plugin 数组不含 opencode-serenity-plugin → warn', () => {
    const tmp = setup();
    try {
      writeFileSync(
        join(tmp, 'opencode.json'),
        JSON.stringify({
          default_agent: 'home-serenity',
          agent: { 'home-serenity': {} },
          plugin: ['@some/other-plugin'],
        }),
      );
      const r = checkSerenityConfig(tmp, 'home-serenity');
      expect(r.warnings.some((w) => w.includes('does not include opencode-serenity-plugin'))).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });

  it('完整正确配置 → ok=true 无 warning', () => {
    const tmp = setup();
    try {
      writeFileSync(
        join(tmp, 'opencode.json'),
        JSON.stringify({
          default_agent: 'home-serenity',
          agent: { 'home-serenity': { mode: 'primary' } },
          plugin: ['/path/to/opencode-serenity-plugin'],
        }),
      );
      const r = checkSerenityConfig(tmp, 'home-serenity');
      expect(r.ok).toBe(true);
      expect(r.warnings).toEqual([]);
    } finally {
      cleanup(tmp);
    }
  });

  it('opencode.json 解析失败 → ok=false', () => {
    const tmp = setup();
    try {
      writeFileSync(join(tmp, 'opencode.json'), '{ not json }');
      const r = checkSerenityConfig(tmp, 'home-serenity');
      expect(r.ok).toBe(false);
      expect(r.warnings.some((w) => w.includes('parse error'))).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });
});
