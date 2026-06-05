/**
 * msm-schema 单测（v0.1-2 + v1-1 增强）
 *
 * 覆盖：
 * - v0.1-2: getPathArgNames 识别约定 type / 越界 throw / 跳过非 path-arg
 * - v1-1: symlink 防御（realpath 解析 + symlink → MsmSymlinkError）
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPathArgNames, validatePathArgs } from '../src/msm-schema.js';
import { MsmPathEscapeError, MsmSymlinkError } from '../src/errors.js';

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

describe('msm-schema (v0.1-2)', () => {
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

describe('msm-schema (v1-1 symlink guard)', () => {
  let tmpRoot: string;
  let outsideRoot: string;

  // 每个 test 独立临时目录
  function setup() {
    tmpRoot = mkdtempSync(join(tmpdir(), 'msm-schema-test-'));
    outsideRoot = mkdtempSync(join(tmpdir(), 'msm-schema-outside-'));
    return { cwdRoot: tmpRoot, outside: outsideRoot };
  }

  function cleanup() {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    if (outsideRoot) rmSync(outsideRoot, { recursive: true, force: true });
  }

  it('文件存在且不是 symlink → 通过', () => {
    const { cwdRoot: c } = setup();
    try {
      const realFile = join(c, 'data.txt');
      writeFileSync(realFile, 'hello');
      expect(() =>
        validatePathArgs({ file: realFile }, fakeEntry, c),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('文件存在但是 symlink 指向 cwdRoot 内 → throw MsmSymlinkError', () => {
    const { cwdRoot: c } = setup();
    try {
      const realFile = join(c, 'real.txt');
      const linkFile = join(c, 'link.txt');
      writeFileSync(realFile, 'data');
      symlinkSync(realFile, linkFile);
      expect(() =>
        validatePathArgs({ file: linkFile }, fakeEntry, c),
      ).toThrow(MsmSymlinkError);
    } finally {
      cleanup();
    }
  });

  it('文件存在但是 symlink 指向 cwdRoot 外 → throw MsmSymlinkError', () => {
    const { cwdRoot: c, outside: o } = setup();
    try {
      const outsideFile = join(o, 'secret.txt');
      const linkFile = join(c, 'link.txt');
      writeFileSync(outsideFile, 'secret');
      symlinkSync(outsideFile, linkFile);
      expect(() =>
        validatePathArgs({ file: linkFile }, fakeEntry, c),
      ).toThrow(MsmSymlinkError);
    } finally {
      cleanup();
    }
  });

  it('文件不存在（输出场景）→ 通过', () => {
    const { cwdRoot: c } = setup();
    try {
      const outFile = join(c, 'output.json');
      // 文件不存在，validatePathArgs 应不抛错（写文件是合理场景）
      expect(() =>
        validatePathArgs({ file: outFile }, fakeEntry, c),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('目录是 symlink 指向 cwdRoot 外 → throw MsmSymlinkError', () => {
    const { cwdRoot: c, outside: o } = setup();
    try {
      const linkDir = join(c, 'linkdir');
      symlinkSync(o, linkDir);
      expect(() =>
        validatePathArgs({ dir: linkDir }, fakeEntry, c),
      ).toThrow(MsmSymlinkError);
    } finally {
      cleanup();
    }
  });

  it('目录是真实目录（不是 symlink）→ 通过', () => {
    const { cwdRoot: c } = setup();
    try {
      const realDir = join(c, 'realdir');
      mkdirSync(realDir);
      expect(() =>
        validatePathArgs({ dir: realDir }, fakeEntry, c),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });
});
