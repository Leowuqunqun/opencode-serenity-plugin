/**
 * 错误类单测
 */

import { describe, it, expect } from 'vitest';
import {
  BashDisabledError,
  InitGitCommitError,
  MsmArgsParseError,
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
      new BashDisabledError(),
      new MsmNotRegisteredError('foo'),
      new MsmArgsParseError('{}', 'bad'),
      new MsmTimeoutError('foo', 1000),
      new MsmExecutionError('foo', 1, 'err'),
      new InitGitCommitError('reason'),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(SerenityError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toMatch(/Error$/);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});
