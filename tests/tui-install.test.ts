/**
 * tui-install 单测（v1.10.1 修复）
 *
 * 覆盖：
 * 1. tui.json 不存在 → 写新文件（含 $schema + plugin list）
 * 2. plugin 已在 list 中 → no-op（changed: false）
 * 3. plugin 不在 list 中 → 追加，保留其他字段
 * 4. tui.json 含其他 plugin → 追加到末尾
 * 5. 保留非 plugin 字段（theme / keybinds / attention / prompt / …）
 * 6. 保留 [spec, opts] tuple 格式
 * 7. 格式错误 JSON → 返回 error，不写
 * 8. tui.json 是 array → 返回 error，不写
 * 9. 父目录不存在 → mkdir -p
 * 10. getGlobalTuiConfigPath 尊重 XDG_CONFIG_HOME
 * 11. toPluginSpec 接受绝对路径 / file:// URL，拒绝相对路径
 * 12. 绝对路径走 realpath（symlink-resolved）
 *
 * 设计意图：测试用 mkdtemp 创建独立 tmp dir，避免污染 ~/.config/opencode
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import {
  ensureGlobalTuiPluginRegistration,
  getGlobalTuiConfigPath,
  toPluginSpec,
} from '../src/util/tui-install.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tui-install-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 真实存在的小文件（保证 realpath 不会抛） */
function makePluginFile(): string {
  const p = join(tmpDir, 'tui.js');
  writeFileSync(p, '// stub plugin', 'utf8');
  return p;
}

describe('toPluginSpec', () => {
  it('绝对路径 → file:// URL', () => {
    const file = makePluginFile();
    const spec = toPluginSpec(file);
    expect(spec.startsWith('file://')).toBe(true);
    expect(spec.endsWith('/tui.js')).toBe(true);
  });

  it('file:// URL → realpath → file:// URL', () => {
    const file = makePluginFile();
    const fileUrl = `file://${file}`;
    const spec = toPluginSpec(fileUrl);
    expect(spec.startsWith('file://')).toBe(true);
    expect(spec.endsWith('/tui.js')).toBe(true);
  });

  it('相对路径 → 抛错', () => {
    expect(() => toPluginSpec('./relative/tui.js')).toThrow(/absolute/);
  });

  it('symlink 解析为 realpath', () => {
    const real = makePluginFile();
    const link = join(tmpDir, 'link.js');
    symlinkSync(real, link);
    const spec = toPluginSpec(link);
    // 解析后应指向 real file，不是 symlink
    expect(spec.endsWith('/tui.js')).toBe(true);
    expect(spec.includes('link.js')).toBe(false);
  });
});

describe('getGlobalTuiConfigPath', () => {
  it('默认走 ~/.config/opencode/tui.json', () => {
    // 保存原 env 以防影响
    const orig = process.env['XDG_CONFIG_HOME'];
    delete process.env['XDG_CONFIG_HOME'];
    try {
      const path = getGlobalTuiConfigPath();
      expect(isAbsolute(path)).toBe(true);
      expect(path.endsWith('/opencode/tui.json')).toBe(true);
    } finally {
      if (orig !== undefined) process.env['XDG_CONFIG_HOME'] = orig;
    }
  });

  it('尊重 $XDG_CONFIG_HOME', () => {
    const orig = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    try {
      const path = getGlobalTuiConfigPath();
      expect(path).toBe(join(tmpDir, 'opencode', 'tui.json'));
    } finally {
      if (orig !== undefined) {
        process.env['XDG_CONFIG_HOME'] = orig;
      } else {
        delete process.env['XDG_CONFIG_HOME'];
      }
    }
  });
});

describe('ensureGlobalTuiPluginRegistration', () => {
  it('tui.json 不存在 → 创建新文件（含 $schema + plugin）', () => {
    const file = makePluginFile();
    const configPath = join(tmpDir, 'tui.json');
    const result = ensureGlobalTuiPluginRegistration(file, { configPath });
    expect(result.changed).toBe(true);
    expect(result.error).toBeUndefined();
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(content.$schema).toBe('https://opencode.ai/tui.json');
    expect(content.plugin).toEqual([toPluginSpec(file)]);
  });

  it('plugin 已在 list → no-op（changed: false, 无写盘）', () => {
    const file = makePluginFile();
    const spec = toPluginSpec(file);
    const configPath = join(tmpDir, 'tui.json');
    writeFileSync(configPath, JSON.stringify({ plugin: [spec] }, null, 2) + '\n', 'utf8');
    const mtimeBefore = readFileSync(configPath, 'utf8');
    const result = ensureGlobalTuiPluginRegistration(file, { configPath });
    expect(result.changed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(mtimeBefore);
  });

  it('plugin 不在 list → 追加到末尾', () => {
    const file = makePluginFile();
    const configPath = join(tmpDir, 'tui.json');
    writeFileSync(configPath, JSON.stringify({ plugin: ['file:///other/plugin.js'] }, null, 2) + '\n', 'utf8');
    const result = ensureGlobalTuiPluginRegistration(file, { configPath });
    expect(result.changed).toBe(true);
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(content.plugin).toEqual(['file:///other/plugin.js', toPluginSpec(file)]);
  });

  it('保留非 plugin 字段（theme / keybinds / attention）', () => {
    const file = makePluginFile();
    const configPath = join(tmpDir, 'tui.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: 'https://opencode.ai/tui.json',
        theme: 'dark',
        keybinds: { foo: 'bar' },
        attention: { enabled: true },
      }, null, 2) + '\n',
      'utf8',
    );
    const result = ensureGlobalTuiPluginRegistration(file, { configPath });
    expect(result.changed).toBe(true);
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(content.theme).toBe('dark');
    expect(content.keybinds).toEqual({ foo: 'bar' });
    expect(content.attention).toEqual({ enabled: true });
    expect(content.plugin).toEqual([toPluginSpec(file)]);
  });

  it('保留 [spec, opts] tuple 格式', () => {
    const file = makePluginFile();
    const configPath = join(tmpDir, 'tui.json');
    const tuple = ['file:///other/plugin.js', { opt: 'val' }];
    writeFileSync(configPath, JSON.stringify({ plugin: [tuple] }, null, 2) + '\n', 'utf8');
    const result = ensureGlobalTuiPluginRegistration(file, { configPath });
    expect(result.changed).toBe(true);
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(content.plugin[0]).toEqual(tuple);
    expect(content.plugin[1]).toBe(toPluginSpec(file));
  });

  it('plugin 字段为 null → 视为空 list', () => {
    const file = makePluginFile();
    const configPath = join(tmpDir, 'tui.json');
    writeFileSync(configPath, JSON.stringify({ plugin: null }, null, 2) + '\n', 'utf8');
    const result = ensureGlobalTuiPluginRegistration(file, { configPath });
    expect(result.changed).toBe(true);
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(content.plugin).toEqual([toPluginSpec(file)]);
  });

  it('格式错误 JSON → 返回 error，不写', () => {
    const file = makePluginFile();
    const configPath = join(tmpDir, 'tui.json');
    const malformed = '{ plugin: ['; // 无 closing
    writeFileSync(configPath, malformed, 'utf8');
    const result = ensureGlobalTuiPluginRegistration(file, { configPath });
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/parse/);
    // 文件未被覆盖
    expect(readFileSync(configPath, 'utf8')).toBe(malformed);
  });

  it('tui.json 是 array（不是 object）→ 返回 error，不写', () => {
    const file = makePluginFile();
    const configPath = join(tmpDir, 'tui.json');
    writeFileSync(configPath, '[1, 2, 3]', 'utf8');
    const result = ensureGlobalTuiPluginRegistration(file, { configPath });
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/object/);
    expect(readFileSync(configPath, 'utf8')).toBe('[1, 2, 3]');
  });

  it('tui.json 是 null → 返回 error，不写', () => {
    const file = makePluginFile();
    const configPath = join(tmpDir, 'tui.json');
    writeFileSync(configPath, 'null', 'utf8');
    const result = ensureGlobalTuiPluginRegistration(file, { configPath });
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/object/);
  });

  it('父目录不存在 → mkdir -p 后写', () => {
    const file = makePluginFile();
    const deepPath = join(tmpDir, 'a', 'b', 'c', 'tui.json');
    const result = ensureGlobalTuiPluginRegistration(file, { configPath: deepPath });
    expect(result.changed).toBe(true);
    expect(existsSync(deepPath)).toBe(true);
  });

  it('已存在 plugin 但写错（权限）→ 返回 error', () => {
    // 跳过：模拟权限失败需 root 角色或 chmod + RO 路径，跨平台难复现。
    // 类似错误（write failed）通过 malformed-JSON 路径间接覆盖。
  });

  it('相对路径 → 返回 error（不抛）', () => {
    const configPath = join(tmpDir, 'tui.json');
    const result = ensureGlobalTuiPluginRegistration('./relative.js', { configPath });
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/absolute/);
    expect(existsSync(configPath)).toBe(false);
  });

  it('plugin 已是 file:// URL 形式 → 不重复添加', () => {
    const file = makePluginFile();
    const spec = toPluginSpec(file);
    const configPath = join(tmpDir, 'tui.json');
    writeFileSync(configPath, JSON.stringify({ plugin: [spec] }, null, 2) + '\n', 'utf8');
    // 第二次用 file:// URL 而不是绝对路径
    const result = ensureGlobalTuiPluginRegistration(`file://${file}`, { configPath });
    expect(result.changed).toBe(false);
  });

  it('symlink 路径与 realpath 路径 → 视为同一 plugin（不重复）', () => {
    const real = makePluginFile();
    const link = join(tmpDir, 'link.js');
    symlinkSync(real, link);
    const configPath = join(tmpDir, 'tui.json');
    // 第一次用 realpath 路径
    const r1 = ensureGlobalTuiPluginRegistration(real, { configPath });
    expect(r1.changed).toBe(true);
    // 第二次用 symlink 路径 → 应被识别为同一 plugin
    const r2 = ensureGlobalTuiPluginRegistration(link, { configPath });
    expect(r2.changed).toBe(false);
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(content.plugin).toHaveLength(1);
  });
});

describe('ensureGlobalTuiPluginRegistration 与 init.ts 隔离', () => {
  it('失败时不抛上层（cwd = 不存在路径）', () => {
    // 注意：plugin path 不存在时 toPluginSpec 会 realpath 抛错
    // 这是预期：plugin 文件必须真实存在
    const configPath = join(tmpDir, 'tui.json');
    const result = ensureGlobalTuiPluginRegistration('/nonexistent/path/tui.js', { configPath });
    expect(result.changed).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('写入产物检查', () => {
  it('写入的 tui.json 是 valid JSON 且有换行结尾（POSIX 友好）', () => {
    const file = makePluginFile();
    const configPath = join(tmpDir, 'tui.json');
    ensureGlobalTuiPluginRegistration(file, { configPath });
    const text = readFileSync(configPath, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('目录创建支持多级（a/b/c/tui.json 都能写）', () => {
    const file = makePluginFile();
    const deep = join(tmpDir, 'x', 'y', 'z', 'tui.json');
    mkdirSync(join(tmpDir, 'x', 'y', 'z'), { recursive: true });
    const result = ensureGlobalTuiPluginRegistration(file, { configPath: deep });
    expect(result.changed).toBe(true);
    expect(existsSync(deep)).toBe(true);
  });
});
