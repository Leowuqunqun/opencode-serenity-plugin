/**
 * msm-schema 单测（v1.2 重写 + v0.1-2 + v1-1 增强）
 *
 * 覆盖：
 * - v1.2: normalizeFlag / normalizeFlags（兼容 v0 + v1 schema）
 * - v1.2: tokenizeArgs（CLI tokenize，支持引号 + 转义）
 * - v1.2: validatePathArgsFromTokens（启发式 path-arg 校验 + symlink 防御）
 * - v1.2: v1 schema flag 字符串解析（--name / --name <hint> / --name=<hint>）
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeFlag,
  normalizeFlags,
  tokenizeArgs,
  validatePathArgsFromTokens,
} from '../src/msm-schema.js';
import { MsmPathEscapeError, MsmSymlinkError } from '../src/errors.js';

describe('msm-schema (v1.2 normalizeFlag)', () => {
  it('v0 schema：name + type → NormalizedFlag', () => {
    const f = normalizeFlag({ name: 'file', type: 'path', description: 'x' });
    expect(f).toEqual({
      name: 'file',
      hasValue: true,
      valueHint: undefined,
      isPath: true,
      type: 'path',
      required: false,
    });
  });

  it('v0 schema：type=boolean → hasValue=false', () => {
    const f = normalizeFlag({ name: 'verbose', type: 'boolean' });
    expect(f?.hasValue).toBe(false);
    expect(f?.isPath).toBe(false);
  });

  it('v1 schema：--root → name=root, hasValue=false, isPath=false', () => {
    const f = normalizeFlag({ flag: '--root', description: 'x' });
    expect(f).toEqual({
      name: 'root',
      hasValue: false,
      valueHint: undefined,
      isPath: false,
      type: undefined,
      required: false,
    });
  });

  it('v1 schema：--check <路径> → name=check, isPath=true (值含"路径")', () => {
    const f = normalizeFlag({ flag: '--check <路径>', description: 'x' });
    expect(f).toEqual({
      name: 'check',
      hasValue: true,
      valueHint: '路径',
      isPath: true,
      type: undefined,
      required: false,
    });
  });

  it('v1 schema：--file <file> → isPath=true (值含 "file")', () => {
    const f = normalizeFlag({ flag: '--file <file>' });
    expect(f?.isPath).toBe(true);
  });

  it('v1 schema：--category=<mech|semi-mech> → hasValue=true, isPath=false (值不含路径关键词)', () => {
    const f = normalizeFlag({ flag: '--category=<mech|semi-mech>' });
    expect(f?.hasValue).toBe(true);
    expect(f?.isPath).toBe(false);
    expect(f?.valueHint).toBe('mech|semi-mech');
  });

  it('无效 flag 字段（既无 name 也无 flag）→ null', () => {
    expect(normalizeFlag({})).toBeNull();
    expect(normalizeFlag({ description: 'x' })).toBeNull();
  });

  it('normalizeFlags 批量 + 过滤 null', () => {
    const flags = normalizeFlags([
      { name: 'a', type: 'string' },
      { flag: '--check <路径>' },
      {},
      { flag: '--root' },
    ]);
    expect(flags).toHaveLength(3);
    expect(flags.map((f) => f.name)).toEqual(['a', 'check', 'root']);
    expect(flags.map((f) => f.isPath)).toEqual([false, true, false]);
  });
});

describe('msm-schema (v1.2 tokenizeArgs)', () => {
  it('简单空格分隔', () => {
    expect(tokenizeArgs('--root')).toEqual(['--root']);
    expect(tokenizeArgs('--host ubuntu --exec whoami')).toEqual([
      '--host',
      'ubuntu',
      '--exec',
      'whoami',
    ]);
  });

  it('空字符串 → []', () => {
    expect(tokenizeArgs('')).toEqual([]);
    expect(tokenizeArgs('   ')).toEqual([]);
  });

  it('双引号保留空格', () => {
    expect(tokenizeArgs('--name "hello world"')).toEqual(['--name', 'hello world']);
  });

  it('单引号保留空格', () => {
    expect(tokenizeArgs("--name 'hello world'")).toEqual(['--name', 'hello world']);
  });

  it('反斜杠转义', () => {
    expect(tokenizeArgs('--path .opencode/skills\\ home/x.ts')).toEqual([
      '--path',
      '.opencode/skills home/x.ts',
    ]);
  });

  it('混合引号', () => {
    expect(tokenizeArgs(`--name "John's phone"`)).toEqual(['--name', "John's phone"]);
  });
});

describe('msm-schema (v1.2 path-arg guard via tokens)', () => {
  // v1 schema: --check <路径> → path-arg
  const v1Flags = [{ flag: '--check <路径>', description: 'check path' }];
  const v1Normalized = normalizeFlags(v1Flags);

  // v0 schema: --file path
  const v0Flags = [{ name: 'file', type: 'path', description: 'file' }];
  const v0Normalized = normalizeFlags(v0Flags);

  function setup() {
    const tmp = mkdtempSync(join(tmpdir(), 'msm-schema-test-'));
    return { cwdRoot: tmp };
  }

  function cleanup(tmp: string) {
    rmSync(tmp, { recursive: true, force: true });
  }

  it('v1 schema：合法路径 → 通过', () => {
    const { cwdRoot } = setup();
    try {
      const realFile = join(cwdRoot, 'data.txt');
      writeFileSync(realFile, 'x');
      const tokens = tokenizeArgs(`--check ${realFile}`);
      expect(() => validatePathArgsFromTokens(tokens, v1Normalized, cwdRoot)).not.toThrow();
    } finally {
      cleanup(cwdRoot);
    }
  });

  it('v1 schema：路径越界 → throw MsmPathEscapeError', () => {
    const { cwdRoot } = setup();
    try {
      const tokens = tokenizeArgs('--check /etc/passwd');
      expect(() => validatePathArgsFromTokens(tokens, v1Normalized, cwdRoot)).toThrow(
        MsmPathEscapeError,
      );
    } finally {
      cleanup(cwdRoot);
    }
  });

  it('v1 schema：path 形式（含 --check）token 配对正确', () => {
    const { cwdRoot } = setup();
    try {
      const tokens = tokenizeArgs('--root --check ./relative.txt');
      // --root 不是 path-arg，跳过；--check 是 path-arg，检查 relative.txt
      expect(() => validatePathArgsFromTokens(tokens, v1Normalized, cwdRoot)).not.toThrow();
    } finally {
      cleanup(cwdRoot);
    }
  });

  it('v1 schema：path 是 symlink → throw MsmSymlinkError', () => {
    const { cwdRoot } = setup();
    try {
      const real = join(cwdRoot, 'real.txt');
      const link = join(cwdRoot, 'link.txt');
      writeFileSync(real, 'x');
      symlinkSync(real, link);
      const tokens = tokenizeArgs(`--check ${link}`);
      expect(() => validatePathArgsFromTokens(tokens, v1Normalized, cwdRoot)).toThrow(
        MsmSymlinkError,
      );
    } finally {
      cleanup(cwdRoot);
    }
  });

  it('v0 schema：合法路径 → 通过', () => {
    const { cwdRoot } = setup();
    try {
      const realFile = join(cwdRoot, 'data.txt');
      writeFileSync(realFile, 'x');
      const tokens = tokenizeArgs(`--file ${realFile}`);
      expect(() => validatePathArgsFromTokens(tokens, v0Normalized, cwdRoot)).not.toThrow();
    } finally {
      cleanup(cwdRoot);
    }
  });

  it('v0 schema：越界 → throw MsmPathEscapeError', () => {
    const { cwdRoot } = setup();
    try {
      const tokens = tokenizeArgs('--file /etc/passwd');
      expect(() => validatePathArgsFromTokens(tokens, v0Normalized, cwdRoot)).toThrow(
        MsmPathEscapeError,
      );
    } finally {
      cleanup(cwdRoot);
    }
  });

  it('目录是真实目录（不是 symlink）→ 通过', () => {
    const { cwdRoot } = setup();
    try {
      const realDir = join(cwdRoot, 'realdir');
      mkdirSync(realDir);
      const tokens = tokenizeArgs(`--check ${realDir}`);
      expect(() => validatePathArgsFromTokens(tokens, v1Normalized, cwdRoot)).not.toThrow();
    } finally {
      cleanup(cwdRoot);
    }
  });

  it('目录是 symlink 指向 cwdRoot 外 → throw MsmSymlinkError', () => {
    const { cwdRoot } = setup();
    const outside = mkdtempSync(join(tmpdir(), 'msm-schema-outside-'));
    try {
      const linkDir = join(cwdRoot, 'linkdir');
      symlinkSync(outside, linkDir);
      const tokens = tokenizeArgs(`--check ${linkDir}`);
      expect(() => validatePathArgsFromTokens(tokens, v1Normalized, cwdRoot)).toThrow(
        MsmSymlinkError,
      );
    } finally {
      cleanup(cwdRoot);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
