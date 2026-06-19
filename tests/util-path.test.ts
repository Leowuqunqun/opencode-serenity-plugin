/**
 * 路径工具单测
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSkillPath,
  isValidCccName,
  validateSkillExists,
} from '../src/util/path.js';
import { SkillNotFoundError } from '../src/errors.js';

describe('util/path', () => {
  it('buildSkillPath 拼出绝对路径', () => {
    const p = buildSkillPath('/root', 'home-serenity');
    expect(p).toBe('/root/.opencode/skills/home-serenity/SKILL.md');
  });

  it('validateSkillExists 抛错当 SKILL.md 不存在', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-test-'));
    expect(() => validateSkillExists(join(tmp, 'missing'), tmp, 'home-serenity')).toThrow(SkillNotFoundError);
  });

  it('validateSkillExists 不抛错当存在', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-test-'));
    const p = join(tmp, 'SKILL.md');
    writeFileSync(p, '# test');
    expect(() => validateSkillExists(p, tmp, 'home-serenity')).not.toThrow();
  });

  it('isValidCccName 校验 kebab-case', () => {
    expect(isValidCccName('home-serenity')).toBe(true);
    expect(isValidCccName('a-b-c-d')).toBe(true);
    expect(isValidCccName('a1b2')).toBe(true);
    expect(isValidCccName('Home-Serenity')).toBe(false);
    expect(isValidCccName('-home')).toBe(false);
    expect(isValidCccName('home-')).toBe(false);
    expect(isValidCccName('home_serenity')).toBe(false);
    expect(isValidCccName('')).toBe(false);
  });

  it('建实例工程：完整 /.opencode/skills/<N>/SKILL.md', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-test-'));
    const skillDir = join(tmp, '.opencode', 'skills', 'home-serenity');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# home-serenity skill');
    const p = buildSkillPath(tmp, 'home-serenity');
    expect(() => validateSkillExists(p, tmp, 'home-serenity')).not.toThrow();
  });
});
