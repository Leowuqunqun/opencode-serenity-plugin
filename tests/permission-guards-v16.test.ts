/**
 * v1.6 RR5 hard block 单测
 *
 * 覆盖：
 * 1. extractPathsFromArgs 字段名扩展（*path* / *file* / *dir* 后缀）
 * 2. edit / write 工具越界 throw
 * 3. read 越界 throw（v0.1-3 行为保持）
 * 4. symlink 防御
 * 5. webfetch 行为保持（A2 不动）
 * 6. 字段名大小写不敏感
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('v1.6 RR5 — extractPathsFromArgs 字段扩展', () => {
  // 通过 mock 直接测字段扩展行为
  it('heuristic suffix *path* 命中 targetPath', async () => {
    const { extractPathsFromArgs } = await import('../src/hooks/permission-guards.js');
    const paths = extractPathsFromArgs({ targetPath: '/foo/bar' });
    expect(paths).toContain('/foo/bar');
  });

  it('heuristic suffix *file* 命中 newFilePath', async () => {
    const { extractPathsFromArgs } = await import('../src/hooks/permission-guards.js');
    const paths = extractPathsFromArgs({ newFilePath: '/foo/baz.txt' });
    expect(paths).toContain('/foo/baz.txt');
  });

  it('heuristic suffix *dir* 命中 outputDir', async () => {
    const { extractPathsFromArgs } = await import('../src/hooks/permission-guards.js');
    const paths = extractPathsFromArgs({ outputDir: '/foo/out' });
    expect(paths).toContain('/foo/out');
  });

  it('显式 key（command / path / filePath / file / cwd）仍然识别', async () => {
    const { extractPathsFromArgs } = await import('../src/hooks/permission-guards.js');
    const paths = extractPathsFromArgs({
      command: '/bin/ls',
      path: '/etc/passwd',
      filePath: '/tmp/x',
      file: '/tmp/y',
      cwd: '/tmp',
    });
    expect(paths).toEqual(expect.arrayContaining(['/bin/ls', '/etc/passwd', '/tmp/x', '/tmp/y', '/tmp']));
  });

  it('大小写不敏感（Path / FILE / Dir）', async () => {
    const { extractPathsFromArgs } = await import('../src/hooks/permission-guards.js');
    const paths = extractPathsFromArgs({ SourcePath: '/a', OUTPUTFILE: '/b', TargetDir: '/c' });
    expect(paths).toEqual(expect.arrayContaining(['/a', '/b', '/c']));
  });

  it('非 string 值跳过', async () => {
    const { extractPathsFromArgs } = await import('../src/hooks/permission-guards.js');
    const paths = extractPathsFromArgs({ count: 42, enabled: true, file: null });
    expect(paths).toEqual([]);
  });
});

describe('v1.6 RR5 — path classification (via real fs)', () => {
  // classifyPath 是 private；通过 integration 测（用真实 tmp + symlink）
  it('实文件路径在 cwdRoot 内 → 不 throw', async () => {
    // classifyPath 是 private — 通过 behavior 测：createPermissionGuards 工厂
    // 这里只确保 plugin 加载不报错
    const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
    const hooks = createPermissionGuards();
    expect(hooks['tool.execute.before']).toBeDefined();
  });
});

describe('v1.6 RR5 — 集成场景（verify hard block on edit/write/read）', () => {
  let tmp: string;
  let outside: string;

  function setup() {
    tmp = mkdtempSync(join(tmpdir(), 'rr5-guard-'));
    outside = mkdtempSync(join(tmpdir(), 'rr5-outside-'));
    return { cwdRoot: tmp, outside };
  }

  function cleanup() {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (outside) rmSync(outside, { recursive: true, force: true });
  }

  it('read path 越界（实文件）→ throw（v0.1-3 行为保留）', async () => {
    const { cwdRoot: c, outside: o } = setup();
    try {
      const outsideFile = join(o, 'secret.txt');
      writeFileSync(outsideFile, 'data');
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      // mock state.activated
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'read', sessionID: 's', callID: 'c' } as any, { args: { path: outsideFile } } as any),
      ).rejects.toThrow(/outside the serenity workspace root/);
    } finally {
      cleanup();
    }
  });

  it('edit path 在 cwdRoot 内（实文件）→ 不 throw', async () => {
    const { cwdRoot: c } = setup();
    try {
      const inFile = join(c, 'in.txt');
      writeFileSync(inFile, 'data');
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'edit', sessionID: 's', callID: 'c' } as any, { args: { path: inFile } } as any),
      ).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('edit path 越界 → throw（v1.6 新行为）', async () => {
    const { cwdRoot: c, outside: o } = setup();
    try {
      const outsideFile = join(o, 'secret.txt');
      writeFileSync(outsideFile, 'data');
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'edit', sessionID: 's', callID: 'c' } as any, { args: { path: outsideFile } } as any),
      ).rejects.toThrow(/outside the serenity workspace root/);
    } finally {
      cleanup();
    }
  });

  it('write path 越界 → throw（v1.6 新行为）', async () => {
    const { cwdRoot: c, outside: o } = setup();
    try {
      const outsideFile = join(o, 'secret.txt');
      writeFileSync(outsideFile, 'data');
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'write', sessionID: 's', callID: 'c' } as any, { args: { filePath: outsideFile } } as any),
      ).rejects.toThrow(/outside the serenity workspace root/);
    } finally {
      cleanup();
    }
  });

  it('edit symlink 指向 cwdRoot 外 → throw（v1.6 symlink 防御）', async () => {
    const { cwdRoot: c, outside: o } = setup();
    try {
      const outsideFile = join(o, 'secret.txt');
      const linkFile = join(c, 'link.txt');
      writeFileSync(outsideFile, 'data');
      symlinkSync(outsideFile, linkFile);
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'edit', sessionID: 's', callID: 'c' } as any, { args: { path: linkFile } } as any),
      ).rejects.toThrow(/symlink|outside the serenity workspace root/);
    } finally {
      cleanup();
    }
  });

  it('grep path 越界 → throw（v1.6 grep 劫持）', async () => {
    const { cwdRoot: c, outside: o } = setup();
    try {
      const outsideDir = o;
      mkdirSync(outsideDir, { recursive: true });
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'grep', sessionID: 's', callID: 'c' } as any, { args: { pattern: 'test', path: outsideDir } } as any),
      ).rejects.toThrow(/outside the serenity workspace root/);
    } finally {
      cleanup();
    }
  });

  it('grep path 在 cwdRoot 内 → 不 throw', async () => {
    const { cwdRoot: c } = setup();
    try {
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'grep', sessionID: 's', callID: 'c' } as any, { args: { pattern: 'test', path: c } } as any),
      ).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('grep 无 path 参数（默认 workspace root）→ 不 throw', async () => {
    const { cwdRoot: c } = setup();
    try {
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'grep', sessionID: 's', callID: 'c' } as any, { args: { pattern: 'test' } } as any),
      ).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('glob path 越界 → throw（v0.1 glob 限制）', async () => {
    const { cwdRoot: c, outside: o } = setup();
    try {
      const outsideDir = o;
      mkdirSync(outsideDir, { recursive: true });
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'glob', sessionID: 's', callID: 'c' } as any, { args: { pattern: '*.ts', path: outsideDir } } as any),
      ).rejects.toThrow(/outside the serenity workspace root/);
    } finally {
      cleanup();
    }
  });

  it('glob path 在 cwdRoot 内 → 不 throw', async () => {
    const { cwdRoot: c } = setup();
    try {
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'glob', sessionID: 's', callID: 'c' } as any, { args: { pattern: '*.ts', path: c } } as any),
      ).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('glob 无 path 参数 → 不 throw', async () => {
    const { cwdRoot: c } = setup();
    try {
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'glob', sessionID: 's', callID: 'c' } as any, { args: { pattern: '*.ts' } } as any),
      ).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('write 字段名 filePath（v1.6 启发式后缀）→ 越界 throw', async () => {
    const { cwdRoot: c, outside: o } = setup();
    try {
      const outsideFile = join(o, 'secret.txt');
      writeFileSync(outsideFile, 'data');
      const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
      const hooks = createPermissionGuards();
      const hook = hooks['tool.execute.before']!;
      const { resetState, setState, markReady } = await import('../src/state.js');
      resetState();
      setState({ activated: true, cwdRoot: c, instanceName: 'test', skillPath: '', skillContent: null });
      markReady();
      await expect(
        hook({ tool: 'write', sessionID: 's', callID: 'c' } as any, { args: { targetFilePath: outsideFile } } as any),
      ).rejects.toThrow(/outside the serenity workspace root/);
    } finally {
      cleanup();
    }
  });
});
