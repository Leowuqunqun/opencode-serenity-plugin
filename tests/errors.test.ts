/**
 * 错误类单测
 */

import { describe, it, expect } from 'vitest';
import {
  InitGitCommitError,
  InvalidCccNameError,
  MsmExecutionError,
  MsmNotRegisteredError,
  MsmTimeoutError,
  NotInGitRepoError,
  SerenityError,
  SerenityFileEmptyError,
  SerenityFileNotFoundError,
  SkillNotFoundError,
} from '../src/errors.js';

describe('errors', () => {
  it('all extend SerenityError', () => {
    const errs = [
      new NotInGitRepoError('/x'),
      new SerenityFileNotFoundError('/x'),
      new SerenityFileEmptyError('/x'),
      new SkillNotFoundError('/x', 'home-serenity'),
      new MsmNotRegisteredError('foo'),
      new MsmTimeoutError('foo', 1000),
      new MsmExecutionError('foo', 1, 'out', 'err'),
      new InitGitCommitError('reason'),
      new InvalidCccNameError('MyProject'),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(SerenityError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toMatch(/Error$/);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  it('InvalidCccNameError 名字 + 信息', () => {
    const e = new InvalidCccNameError('MyProject');
    expect(e.name).toBe('InvalidCccNameError');
    expect(e).toBeInstanceOf(SerenityError);
    expect(e.message).toContain('MyProject');
    expect(e.message.toLowerCase()).toContain('kebab-case');
  });
});
