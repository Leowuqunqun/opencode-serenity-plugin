/**
 * msm-schema 单测（v0.1-2）
 *
 * 覆盖：
 * 1. getPathArgNames 识别约定 type 为路径型
 * 2. validatePathArgs 在 cwdRoot 内通过
 * 3. validatePathArgs 越界 throw MsmPathEscapeError
 * 4. validatePathArgs 跳过非 path-arg / 非 string
 */

import { describe, it, expect } from 'vitest';
import { getPathArgNames, validatePathArgs } from '../src/msm-schema.js';
import { MsmPathEscapeError } from '../src/errors.js';

const fakeEntry = {
  name: 'fake-msm',
  path: 'scripts/fake.ts',
  skill: 'home-serenity',
  category: 'mech' as const,
  description: 'fake',
  usage: 'fake --file <p>',
  flags: [
    { name: 'file', type: 'path' },
    { name: 'dir', type: 'directory' },
    { name: 'name', type: 'string' },
    { name: 'count', type: 'number' },
  ],
};

const cwdRoot = '/home/yh/project';

describe('msm-schema', () => {
  it('getPathArgNames 识别约定 type 为 path / directory', () => {
    const names = getPathArgNames(fakeEntry);
    expect(names).toEqual(['file', 'dir']);
  });

  it('validatePathArgs 通过当 path-arg 在 cwdRoot 内', () => {
    expect(() =>
      validatePathArgs({ file: '/home/yh/project/data.txt' }, fakeEntry, cwdRoot),
    ).not.toThrow();
  });

  it('validatePathArgs throw MsmPathEscapeError 当 path-arg 越界', () => {
    expect(() =>
      validatePathArgs({ file: '/etc/passwd' }, fakeEntry, cwdRoot),
    ).toThrow(MsmPathEscapeError);
  });

  it('validatePathArgs 跳过非 path-arg（string / number）', () => {
    expect(() =>
      validatePathArgs({ name: 'anything', count: 999 }, fakeEntry, cwdRoot),
    ).not.toThrow();
  });
});
