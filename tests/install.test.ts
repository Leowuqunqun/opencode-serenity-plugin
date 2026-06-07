/**
 * install 单测（v1.11 bin install CLI lib）
 *
 * 覆盖:
 * 1. detectGlobalConfigHome 尊重 XDG_CONFIG_HOME
 * 2. detectGlobalConfigHome 默认走 ~/.config/opencode
 * 3. getGlobalConfigPath 拼接 opencode.json / tui.json
 * 4. resolvePluginEntries 返回正确 abs 路径
 * 5. resolvePluginEntries 解析 symlink (realpath)
 * 6. resolvePluginEntries 拒绝相对路径
 * 7. resolveInstallPathFromBin 从 bin/ 反推 package 根
 * 8. readJsonConfig 缺失 / 空 / 畸形 / 非 object 根节点
 * 9. writeJsonConfig 原子写 (写 .tmp + rename)
 * 10. writeJsonConfig 创建父目录
 * 11. isAlreadyInstalled 通过 id 检测
 * 12. isAlreadyInstalled 通过 abs path 检测
 * 13. writePluginEntry 幂等: 跑两次不重复
 * 14. writePluginEntry 保留其他字段 (theme / keybinds / 其他 plugin)
 * 15. writePluginEntry 写 _plugin_origins
 * 16. writePluginEntry 创建新文件 (含 $schema)
 * 17. writePluginEntry 处理 plugin 字段为 null / array / 标量
 * 18. writePluginEntry 处理 [string, opts] tuple 形式
 * 19. real-world: 全新 opencode.json → 创建,只含 plugin entry
 * 20. real-world: 已有 opencode.json (含其他 plugin + 字段) → 只加 plugin,其他保留
 * 21. real-world: 已有 tui.json (含 theme 等) → 保留 theme,加 plugin
 * 22. real-world: 已有 _plugin_origins (其他 plugin 装的) → 保留,追加我们的
 * 23. 原子写: 写过程中 .tmp 文件存在,写完后消失
 * 24. 错误路径: writePluginEntry 不会破坏已有 config 文件 (即使 entries 重复)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLUGIN_ID,
  detectGlobalConfigHome,
  getGlobalConfigPath,
  resolvePluginEntries,
  resolveInstallPathFromBin,
  readJsonConfig,
  writeJsonConfig,
  isAlreadyInstalled,
  writePluginEntry,
} from '../src/install.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'install-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 构造一个虚拟 plugin 包根目录 (含 dist/index.js + dist/tui.js) */
function makeFakePluginPackage(parentDir: string): string {
  const pkgRoot = join(parentDir, 'fake-plugin');
  mkdirSync(join(pkgRoot, 'dist'), { recursive: true });
  writeFileSync(join(pkgRoot, 'dist', 'index.js'), '// server stub', 'utf8');
  writeFileSync(join(pkgRoot, 'dist', 'tui.js'), '// tui stub', 'utf8');
  return pkgRoot;
}

/** 真实存在的 dist 文件 (保证 realpath 不抛) */
function makePluginFile(parentDir: string, name: string): string {
  const p = join(parentDir, name);
  writeFileSync(p, '// stub', 'utf8');
  return p;
}

// ── detectGlobalConfigHome ──

describe('detectGlobalConfigHome', () => {
  it('XDG_CONFIG_HOME 已设置 → 返回 $XDG_CONFIG_HOME/opencode', () => {
    const orig = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    try {
      expect(detectGlobalConfigHome()).toBe(join(tmpDir, 'opencode'));
    } finally {
      if (orig !== undefined) process.env['XDG_CONFIG_HOME'] = orig;
      else delete process.env['XDG_CONFIG_HOME'];
    }
  });

  it('XDG_CONFIG_HOME 是空字符串 → 走默认 (不当作已设置)', () => {
    const orig = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = '   ';
    try {
      const result = detectGlobalConfigHome();
      // 默认走 ~/.config/opencode (Linux/macOS)
      expect(result.endsWith(`${sep}.config${sep}opencode`)).toBe(true);
    } finally {
      if (orig !== undefined) process.env['XDG_CONFIG_HOME'] = orig;
      else delete process.env['XDG_CONFIG_HOME'];
    }
  });

  it('XDG_CONFIG_HOME 未设置 → 走 ~/.config/opencode (Linux/macOS)', () => {
    const orig = process.env['XDG_CONFIG_HOME'];
    delete process.env['XDG_CONFIG_HOME'];
    try {
      const result = detectGlobalConfigHome();
      expect(isAbsolute(result)).toBe(true);
      expect(result.endsWith(join('.config', 'opencode'))).toBe(true);
    } finally {
      if (orig !== undefined) process.env['XDG_CONFIG_HOME'] = orig;
    }
  });
});

// ── getGlobalConfigPath ──

describe('getGlobalConfigPath', () => {
  it('opencode.json 拼接正确', () => {
    const orig = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    try {
      expect(getGlobalConfigPath('opencode.json')).toBe(join(tmpDir, 'opencode', 'opencode.json'));
    } finally {
      if (orig !== undefined) process.env['XDG_CONFIG_HOME'] = orig;
      else delete process.env['XDG_CONFIG_HOME'];
    }
  });

  it('tui.json 拼接正确', () => {
    const orig = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    try {
      expect(getGlobalConfigPath('tui.json')).toBe(join(tmpDir, 'opencode', 'tui.json'));
    } finally {
      if (orig !== undefined) process.env['XDG_CONFIG_HOME'] = orig;
      else delete process.env['XDG_CONFIG_HOME'];
    }
  });
});

// ── resolvePluginEntries ──

describe('resolvePluginEntries', () => {
  it('返回 server + tui 两个 entry + id', () => {
    const pkgRoot = makeFakePluginPackage(tmpDir);
    const result = resolvePluginEntries(pkgRoot);
    expect(result.id).toBe(PLUGIN_ID);
    expect(result.server.id).toBe(PLUGIN_ID);
    expect(result.tui.id).toBe(PLUGIN_ID);
    expect(result.server.absPath).toBe(join(pkgRoot, 'dist', 'index.js'));
    expect(result.tui.absPath).toBe(join(pkgRoot, 'dist', 'tui.js'));
    expect(result.server.path.startsWith('file://')).toBe(true);
    expect(result.tui.path.startsWith('file://')).toBe(true);
  });

  it('symlink 解析为 realpath', () => {
    const realPkg = makeFakePluginPackage(tmpDir);
    const linkPkg = join(tmpDir, 'link-pkg');
    symlinkSync(realPkg, linkPkg);
    const result = resolvePluginEntries(linkPkg);
    // server.absPath 应指向 real pkg,不是 symlink
    expect(result.server.absPath).toBe(join(realPkg, 'dist', 'index.js'));
    expect(result.server.absPath.includes('link-pkg')).toBe(false);
  });

  it('相对路径 → 抛错', () => {
    expect(() => resolvePluginEntries('./relative')).toThrow(/absolute/);
  });
});

// ── resolveInstallPathFromBin ──

describe('resolveInstallPathFromBin', () => {
  it('从 <pkg>/bin/<name>.js 反推 <pkg>', () => {
    const pkgRoot = makeFakePluginPackage(tmpDir);
    const binFile = join(pkgRoot, 'bin', 'cli.js');
    mkdirSync(join(pkgRoot, 'bin'), { recursive: true });
    writeFileSync(binFile, '#!/usr/bin/env node', 'utf8');
    const installPath = resolveInstallPathFromBin(binFile);
    expect(installPath).toBe(pkgRoot);
  });

  it('symlink bin → 解析到真实 pkg', () => {
    const realPkg = makeFakePluginPackage(tmpDir);
    const realBin = join(realPkg, 'bin', 'cli.js');
    mkdirSync(join(realPkg, 'bin'), { recursive: true });
    writeFileSync(realBin, '#!/usr/bin/env node', 'utf8');
    const globalBinLink = join(tmpDir, 'global-bin-link');
    symlinkSync(realBin, globalBinLink);
    const installPath = resolveInstallPathFromBin(globalBinLink);
    expect(installPath).toBe(realPkg);
  });

  it('相对路径 → 抛错', () => {
    expect(() => resolveInstallPathFromBin('./bin/cli')).toThrow(/absolute/);
  });
});

// ── readJsonConfig ──

describe('readJsonConfig', () => {
  it('文件不存在 → {}', () => {
    const result = readJsonConfig(join(tmpDir, 'nope.json'));
    expect(result).toEqual({});
  });

  it('文件为空 → {}', () => {
    const p = join(tmpDir, 'empty.json');
    writeFileSync(p, '', 'utf8');
    expect(readJsonConfig(p)).toEqual({});
  });

  it('畸形 JSON → 抛 parse error', () => {
    const p = join(tmpDir, 'malformed.json');
    writeFileSync(p, '{ plugin: [', 'utf8');
    expect(() => readJsonConfig(p)).toThrow(/parse error/);
  });

  it('根节点是 array → 抛 not object error', () => {
    const p = join(tmpDir, 'array.json');
    writeFileSync(p, '[1, 2, 3]', 'utf8');
    expect(() => readJsonConfig(p)).toThrow(/not an object/);
  });

  it('根节点是 null → 抛 null error', () => {
    const p = join(tmpDir, 'null.json');
    writeFileSync(p, 'null', 'utf8');
    expect(() => readJsonConfig(p)).toThrow(/null/);
  });

  it('合法 JSON object → 解析返回', () => {
    const p = join(tmpDir, 'ok.json');
    writeFileSync(p, JSON.stringify({ plugin: ['file:///x'], theme: 'dark' }), 'utf8');
    const result = readJsonConfig(p);
    expect(result['plugin']).toEqual(['file:///x']);
    expect(result['theme']).toBe('dark');
  });
});

// ── writeJsonConfig (原子写语义) ──

describe('writeJsonConfig', () => {
  it('原子写: 写完后 .tmp 不残留', () => {
    const p = join(tmpDir, 'atomic.json');
    writeJsonConfig(p, { a: 1 });
    expect(existsSync(p)).toBe(true);
    expect(existsSync(p + '.tmp')).toBe(false);
  });

  it('父目录不存在 → mkdir -p 后写', () => {
    const deep = join(tmpDir, 'a', 'b', 'c', 'deep.json');
    writeJsonConfig(deep, { ok: true });
    expect(existsSync(deep)).toBe(true);
    const result = JSON.parse(readFileSync(deep, 'utf8'));
    expect(result.ok).toBe(true);
  });

  it('覆盖已有文件', () => {
    const p = join(tmpDir, 'overwrite.json');
    writeFileSync(p, JSON.stringify({ old: true }), 'utf8');
    writeJsonConfig(p, { new: true });
    const result = JSON.parse(readFileSync(p, 'utf8'));
    expect(result.old).toBeUndefined();
    expect(result.new).toBe(true);
  });

  it('以换行结尾 (POSIX 友好)', () => {
    const p = join(tmpDir, 'newline.json');
    writeJsonConfig(p, { x: 1 });
    const text = readFileSync(p, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
  });
});

// ── isAlreadyInstalled ──

describe('isAlreadyInstalled', () => {
  const fakeEntry = (pathSuffix = '/dist/index.js') => ({
    id: PLUGIN_ID,
    path: `file://${tmpDir}${pathSuffix}`,
    absPath: join(tmpDir, pathSuffix),
  });

  it('空 entries → true (no-op)', () => {
    expect(isAlreadyInstalled([], {})).toBe(true);
  });

  it('plugin 字段不存在 → false', () => {
    expect(isAlreadyInstalled([fakeEntry()], {})).toBe(false);
  });

  it('通过 abs path 检测 (string form)', () => {
    const entry = fakeEntry();
    expect(isAlreadyInstalled([entry], { plugin: [entry.path] })).toBe(true);
  });

  it('通过 abs path 检测 ([string, opts] tuple form)', () => {
    const entry = fakeEntry();
    expect(isAlreadyInstalled([entry], { plugin: [[entry.path, { opt: 'val' }]] })).toBe(true);
  });

  it('通过 _plugin_origins id 检测', () => {
    const entry = fakeEntry('/different/path.js');
    expect(isAlreadyInstalled([entry], {
      plugin: [],
      _plugin_origins: {
        [entry.path]: { id: PLUGIN_ID, installedAt: '2026-01-01', installPath: '/old' },
      },
    })).toBe(true);
  });

  it('不同 id + 不同 path → false', () => {
    const entry = fakeEntry();
    expect(isAlreadyInstalled([entry], { plugin: ['file:///other/plugin.js'] })).toBe(false);
  });

  it('origin 存在但 id 不同 → false (按 path 检查)', () => {
    const entry = fakeEntry();
    expect(isAlreadyInstalled([entry], {
      plugin: [],
      _plugin_origins: {
        'file:///other.js': { id: 'other-plugin', installedAt: '2026', installPath: '/x' },
      },
    })).toBe(false);
  });
});

// ── writePluginEntry: 核心行为 ──

describe('writePluginEntry', () => {
  it('文件不存在 → 创建,含 $schema + plugin + _plugin_origins', () => {
    const p = join(tmpDir, 'fresh.json');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    const result = writePluginEntry(p, [entry]);
    expect(result.changed).toBe(true);
    expect(result.error).toBeUndefined();
    const content = JSON.parse(readFileSync(p, 'utf8'));
    expect(content.$schema).toBe('https://opencode.ai/config.json');
    expect(content.plugin).toEqual([entry.path]);
    expect(content._plugin_origins[entry.path]).toEqual({
      id: PLUGIN_ID,
      installedAt: expect.any(String),
      installPath: tmpDir,
    });
  });

  it('tui.json 新文件 → $schema 是 tui.json 的 URL', () => {
    const p = join(tmpDir, 'fresh-tui.json');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'tui.js')).href,
      absPath: join(tmpDir, 'dist', 'tui.js'),
    };
    writePluginEntry(p, [entry]);
    const content = JSON.parse(readFileSync(p, 'utf8'));
    expect(content.$schema).toBe('https://opencode.ai/tui.json');
  });

  it('幂等: 跑两次不重复', () => {
    const p = join(tmpDir, 'idem.json');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    const r1 = writePluginEntry(p, [entry]);
    const text1 = readFileSync(p, 'utf8');
    const r2 = writePluginEntry(p, [entry]);
    const text2 = readFileSync(p, 'utf8');
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(false);
    // 文件内容不变 (skippedPaths 包含已存在的)
    expect(text2).toBe(text1);
    const content = JSON.parse(text2);
    expect(content.plugin).toHaveLength(1);
  });

  it('保留其他字段 (theme / keybinds)', () => {
    const p = join(tmpDir, 'with-other.json');
    writeFileSync(p, JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      theme: 'dark',
      keybinds: { foo: 'bar' },
      mcp_servers: { github: { type: 'remote' } },
    }, null, 2) + '\n', 'utf8');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    const result = writePluginEntry(p, [entry]);
    expect(result.changed).toBe(true);
    const content = JSON.parse(readFileSync(p, 'utf8'));
    expect(content.theme).toBe('dark');
    expect(content.keybinds).toEqual({ foo: 'bar' });
    expect(content.mcp_servers).toEqual({ github: { type: 'remote' } });
    expect(content.plugin).toEqual([entry.path]);
  });

  it('追加到已有 plugin list 末尾', () => {
    const p = join(tmpDir, 'append.json');
    const otherSpec = 'file:///other/plugin.js';
    writeFileSync(p, JSON.stringify({ plugin: [otherSpec] }, null, 2) + '\n', 'utf8');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    writePluginEntry(p, [entry]);
    const content = JSON.parse(readFileSync(p, 'utf8'));
    expect(content.plugin).toEqual([otherSpec, entry.path]);
  });

  it('plugin 字段为 null → 视为空 list,创建新数组', () => {
    const p = join(tmpDir, 'null-plugin.json');
    writeFileSync(p, JSON.stringify({ plugin: null }, null, 2) + '\n', 'utf8');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    const result = writePluginEntry(p, [entry]);
    expect(result.changed).toBe(true);
    const content = JSON.parse(readFileSync(p, 'utf8'));
    expect(content.plugin).toEqual([entry.path]);
  });

  it('空 entries → 返回 changed: false, 不写', () => {
    const p = join(tmpDir, 'empty-entries.json');
    const result = writePluginEntry(p, []);
    expect(result.changed).toBe(false);
    expect(existsSync(p)).toBe(false);
  });

  it('同一 plugin 多 entry → 一次写多 spec', () => {
    const p = join(tmpDir, 'multi.json');
    const server = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    const tui = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'tui.js')).href,
      absPath: join(tmpDir, 'dist', 'tui.js'),
    };
    const result = writePluginEntry(p, [server, tui]);
    expect(result.changed).toBe(true);
    const content = JSON.parse(readFileSync(p, 'utf8'));
    expect(content.plugin).toEqual([server.path, tui.path]);
    expect(content._plugin_origins[server.path].id).toBe(PLUGIN_ID);
    expect(content._plugin_origins[tui.path].id).toBe(PLUGIN_ID);
  });

  it('保留其他 plugin 装的 _plugin_origins (只追加我们的)', () => {
    const p = join(tmpDir, 'mixed-origins.json');
    const otherOrigin = {
      'file:///other/plugin.js': { id: 'other-plugin', installedAt: '2025', installPath: '/x' },
    };
    writeFileSync(p, JSON.stringify({
      plugin: ['file:///other/plugin.js'],
      _plugin_origins: otherOrigin,
    }, null, 2) + '\n', 'utf8');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    writePluginEntry(p, [entry]);
    const content = JSON.parse(readFileSync(p, 'utf8'));
    expect(content._plugin_origins['file:///other/plugin.js']).toEqual(otherOrigin['file:///other/plugin.js']);
    expect(content._plugin_origins[entry.path].id).toBe(PLUGIN_ID);
  });
});

// ── real-world 场景 ──

describe('real-world 场景', () => {
  it('用户无 opencode.json → 创建,只含 plugin entry', () => {
    const gitRoot = join(tmpDir, 'my-project');
    mkdirSync(gitRoot, { recursive: true });
    const configPath = join(gitRoot, 'opencode.json');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    writePluginEntry(configPath, [entry]);
    expect(existsSync(configPath)).toBe(true);
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(content.plugin).toEqual([entry.path]);
    // 没有其他字段噪音
    expect(Object.keys(content).sort()).toEqual(['$schema', '_plugin_origins', 'plugin']);
  });

  it('用户已有 opencode.json (含其他 plugin + 字段) → 只加 plugin,其他保留', () => {
    const configPath = join(tmpDir, 'existing-opencode.json');
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      theme: 'light',
      mcp_servers: { gh: { type: 'remote' } },
      plugin: ['file:///other/plugin.js'],
      permission: { edit: 'allow', bash: 'deny' },
    };
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    const result = writePluginEntry(configPath, [entry]);
    expect(result.changed).toBe(true);
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(content.theme).toBe('light');
    expect(content.mcp_servers).toEqual(existing.mcp_servers);
    expect(content.permission).toEqual(existing.permission);
    expect(content.plugin).toEqual(['file:///other/plugin.js', entry.path]);
  });

  it('用户已有 tui.json (含 theme) → 保留 theme,加 tui entry', () => {
    const configPath = join(tmpDir, 'existing-tui.json');
    writeFileSync(configPath, JSON.stringify({
      $schema: 'https://opencode.ai/tui.json',
      theme: 'solarized',
    }, null, 2) + '\n', 'utf8');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'tui.js')).href,
      absPath: join(tmpDir, 'dist', 'tui.js'),
    };
    writePluginEntry(configPath, [entry]);
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(content.theme).toBe('solarized');
    expect(content.plugin).toEqual([entry.path]);
  });
});

// ── 写盘不变量 ──

describe('写盘不变量', () => {
  it('写完后文件 valid JSON', () => {
    const p = join(tmpDir, 'valid.json');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    writePluginEntry(p, [entry]);
    const text = readFileSync(p, 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('写完后 .tmp 残留已被 rename 清掉', () => {
    const p = join(tmpDir, 'no-tmp.json');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    writePluginEntry(p, [entry]);
    expect(existsSync(p + '.tmp')).toBe(false);
    expect(statSync(p).isFile()).toBe(true);
  });

  it('父目录递归创建 (3 层深)', () => {
    const deep = join(tmpDir, 'l1', 'l2', 'l3', 'config.json');
    const entry = {
      id: PLUGIN_ID,
      path: pathToFileURL(join(tmpDir, 'dist', 'index.js')).href,
      absPath: join(tmpDir, 'dist', 'index.js'),
    };
    writePluginEntry(deep, [entry]);
    expect(existsSync(deep)).toBe(true);
  });
});
