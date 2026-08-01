/**
 * config-schema.test.ts (v1.13)
 *
 * 覆盖:
 * 1. mechEntrySchema - 接受有效 MechEntry, 拒绝各种无效输入
 * 2. mechRegistryFileSchema - 顶层双 schema (数组 / v1 包装)
 * 3. hookConfigSchema - 接受任意 string key + boolean value
 * 4. pluginConfigSchema - 接受完整 PluginConfig, 拒绝多余字段
 * 5. parseConfig - 抛 zod.ZodError on 失败
 * 6. safeParseConfig - 返回 { success, data, error } Result
 * 7. parseMechEntry / parseMechRegistryFile / parseHookConfig - 工具函数
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  mechEntrySchema,
  mechRegistryFileSchema,
  hookConfigSchema,
  pluginConfigSchema,
  parseConfig,
  safeParseConfig,
  parseMechEntry,
  parseMechRegistryFile,
  parseHookConfig,
  residentConfigSchema,
  parseResidentConfig,
} from '../src/config-schema.js';

describe('mechEntrySchema (v1.13)', () => {
  it('接受完整有效 MechEntry', () => {
    const valid = {
      name: 'ssh-connect',
      path: '.opencode/skills/home-serenity/scripts/ssh-connect.ts',
      skill: 'home-serenity',
      category: 'mech' as const,
      description: 'SSH tool',
      usage: 'npx tsx ssh-connect.ts',
      flags: [],
    };
    const result = mechEntrySchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('接受 v0 schema flag (name/type)', () => {
    const entry = {
      name: 'foo',
      path: 'foo.ts',
      skill: 'bar',
      category: 'mech' as const,
      description: 'desc',
      usage: 'usage',
      flags: [{ name: '--check', type: 'path' }],
    };
    const result = mechEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('接受 v1 schema flag (flag/description)', () => {
    const entry = {
      name: 'foo',
      path: 'foo.ts',
      skill: 'bar',
      category: 'mech' as const,
      description: 'desc',
      usage: 'usage',
      flags: [{ flag: '--check <path>', description: 'check' }],
    };
    const result = mechEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('接受 subcommands + exit_codes + error_codes (v1 registry)', () => {
    const entry = {
      name: 'foo',
      path: 'foo.ts',
      skill: 'bar',
      category: 'mech' as const,
      description: 'desc',
      usage: 'usage',
      flags: [],
      subcommands: [
        { name: 'list', description: 'list' },
        { name: 'exec', description: 'exec', args: [{ name: 'cmd', type: 'string', required: true }] },
      ],
      exit_codes: { '0': 'success', '1': 'user error' },
      error_codes: ['PARAMETER_MISSING', 'INTERNAL_ERROR'],
    };
    const result = mechEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('拒绝空 name', () => {
    const result = mechEntrySchema.safeParse({
      name: '',
      path: 'foo.ts',
      skill: 'bar',
      category: 'mech',
      description: 'desc',
      usage: 'usage',
      flags: [],
    });
    expect(result.success).toBe(false);
  });

  it('拒绝无效 category', () => {
    const result = mechEntrySchema.safeParse({
      name: 'foo',
      path: 'foo.ts',
      skill: 'bar',
      category: 'invalid',
      description: 'desc',
      usage: 'usage',
      flags: [],
    });
    expect(result.success).toBe(false);
  });

  it('拒绝缺字段', () => {
    const result = mechEntrySchema.safeParse({
      name: 'foo',
      path: 'foo.ts',
      // skill 缺
      category: 'mech',
      description: 'desc',
      usage: 'usage',
      flags: [],
    });
    expect(result.success).toBe(false);
  });

  it('flags 缺省时自动 default []', () => {
    const result = mechEntrySchema.safeParse({
      name: 'foo',
      path: 'foo.ts',
      skill: 'bar',
      category: 'mech',
      description: 'desc',
      usage: 'usage',
      // flags 缺
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.flags).toEqual([]);
    }
  });
});

describe('mechRegistryFileSchema (v1.13) - 双 schema 兼容', () => {
  it('接受顶层数组 (旧 schema)', () => {
    const arrayForm = [
      { name: 'a', path: 'a.ts', skill: 's', category: 'mech', description: 'd', usage: 'u', flags: [] },
      { name: 'b', path: 'b.ts', skill: 's', category: 'semi-mech', description: 'd', usage: 'u', flags: [] },
    ];
    const result = mechRegistryFileSchema.safeParse(arrayForm);
    expect(result.success).toBe(true);
  });

  it('接受 v1 包装格式', () => {
    const v1 = {
      version: 1,
      description: 'serenity registry',
      entries: [
        { name: 'a', path: 'a.ts', skill: 's', category: 'mech', description: 'd', usage: 'u', flags: [] },
      ],
    };
    const result = mechRegistryFileSchema.safeParse(v1);
    expect(result.success).toBe(true);
  });

  it('拒绝非数组非对象', () => {
    expect(mechRegistryFileSchema.safeParse('string').success).toBe(false);
    expect(mechRegistryFileSchema.safeParse(42).success).toBe(false);
    expect(mechRegistryFileSchema.safeParse(null).success).toBe(false);
  });
});

describe('hookConfigSchema (v1.13)', () => {
  it('接受空对象', () => {
    expect(hookConfigSchema.safeParse({}).success).toBe(true);
  });

  it('接受任意 string key + boolean value', () => {
    const result = hookConfigSchema.safeParse({
      'shell.env': false,
      'tool.execute.before': true,
      'experimental.chat.system.transform': false,
    });
    expect(result.success).toBe(true);
  });

  it('拒绝非 boolean value', () => {
    expect(hookConfigSchema.safeParse({ 'shell.env': 'no' }).success).toBe(false);
    expect(hookConfigSchema.safeParse({ 'shell.env': 1 }).success).toBe(false);
  });
});

describe('pluginConfigSchema (v1.13)', () => {
  it('接受空对象 (所有字段 optional)', () => {
    expect(pluginConfigSchema.safeParse({}).success).toBe(true);
  });

  it('接受完整 PluginConfig', () => {
    const valid = {
      $schema: 'https://serenity.ai/config.json',
      disabled_hooks: ['shell.env', 'tool.execute.before'],
      disabled_tools: ['bash'],
      disabled_msms: ['some-msm'],
      msm_exec_format: 'json' as const,
      msm_exec_log: '/tmp/run.log',
      msm_exec_timeout_ms: 60000,
      blocked_msm_paths: ['/etc/passwd'],
    };
    const result = pluginConfigSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('拒绝 msm_exec_format 非法值', () => {
    const result = pluginConfigSchema.safeParse({
      msm_exec_format: 'xml',
    });
    expect(result.success).toBe(false);
  });

  it('拒绝 msm_exec_timeout_ms 非正整数', () => {
    expect(pluginConfigSchema.safeParse({ msm_exec_timeout_ms: 0 }).success).toBe(false);
    expect(pluginConfigSchema.safeParse({ msm_exec_timeout_ms: -1 }).success).toBe(false);
    expect(pluginConfigSchema.safeParse({ msm_exec_timeout_ms: 1.5 }).success).toBe(false);
  });

  it('拒绝 disabled_* 数组元素非 string', () => {
    expect(pluginConfigSchema.safeParse({ disabled_hooks: [1, 2] }).success).toBe(false);
  });
});

describe('parseConfig (v1.13)', () => {
  it('有效输入 → 返回 PluginConfig', () => {
    const config = parseConfig({ msm_exec_format: 'json' });
    expect(config.msm_exec_format).toBe('json');
  });

  it('无效输入 → 抛 zod.ZodError', () => {
    expect(() => parseConfig({ msm_exec_format: 'invalid' })).toThrow(z.ZodError);
  });

  it('非对象输入 → 抛 zod.ZodError', () => {
    expect(() => parseConfig('string')).toThrow(z.ZodError);
    expect(() => parseConfig(null)).toThrow(z.ZodError);
  });
});

describe('safeParseConfig (v1.13)', () => {
  it('有效输入 → success: true, data 是 PluginConfig', () => {
    const result = safeParseConfig({ msm_exec_format: 'json' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.msm_exec_format).toBe('json');
    }
  });

  it('无效输入 → success: false, error 是 ZodError', () => {
    const result = safeParseConfig({ msm_exec_format: 'xml' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(z.ZodError);
    }
  });

  it('ZodError 包含路径信息', () => {
    const result = safeParseConfig({ msm_exec_format: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues[0]?.path).toContain('msm_exec_format');
    }
  });
});

describe('parseMechEntry / parseMechRegistryFile / parseHookConfig (v1.13 工具)', () => {
  it('parseMechEntry 接受单条 entry', () => {
    const result = parseMechEntry({
      name: 'foo',
      path: 'foo.ts',
      skill: 's',
      category: 'mech',
      description: 'd',
      usage: 'u',
      flags: [],
    });
    expect(result.success).toBe(true);
  });

  it('parseMechEntry 拒绝无效', () => {
    expect(parseMechEntry({ name: '' }).success).toBe(false);
  });

  it('parseMechRegistryFile 接受双格式', () => {
    expect(parseMechRegistryFile([]).success).toBe(true);
    expect(parseMechRegistryFile({ entries: [] }).success).toBe(true);
  });

  it('parseHookConfig 接受 { k: bool }', () => {
    expect(parseHookConfig({ 'shell.env': false }).success).toBe(true);
    expect(parseHookConfig({ 'shell.env': 'no' }).success).toBe(false);
  });
});

describe('residentConfigSchema (v0.8 M0)', () => {
  const valid = {
    name: 'guardian',
    description: 'CCC resident',
    model: 'minimax-cn-coding-plan/MiniMax-M3',
    mind: { file: '.serenity-meta/mind.md' },
    cycle: {
      type: 'forever' as const,
      intervalMs: 3600000,
      timeoutMs: 7200000,
      lifetimeMs: 21600000,
    },
  };

  it('接受完整有效 ResidentConfig', () => {
    const result = residentConfigSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('缺少必要字段 → 拒绝', () => {
    expect(residentConfigSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(residentConfigSchema.safeParse({ ...valid, model: '' }).success).toBe(false);
    expect(residentConfigSchema.safeParse({ ...valid, mind: {} }).success).toBe(false);
  });

  it('model 必须 provider/model 格式', () => {
    expect(residentConfigSchema.safeParse({ ...valid, model: 'no-slash' }).success).toBe(false);
  });

  it('cycle.type 必须 forever', () => {
    expect(
      residentConfigSchema.safeParse({
        ...valid,
        cycle: { ...valid.cycle, type: 'once' },
      }).success,
    ).toBe(false);
  });

  it('关系校验：lifetimeMs > intervalMs，timeoutMs >= intervalMs', () => {
    expect(
      residentConfigSchema.safeParse({
        ...valid,
        cycle: { ...valid.cycle, lifetimeMs: 1000, intervalMs: 3600000 },
      }).success,
    ).toBe(false);
    expect(
      residentConfigSchema.safeParse({
        ...valid,
        cycle: { ...valid.cycle, timeoutMs: 500, intervalMs: 3600000 },
      }).success,
    ).toBe(false);
  });

  it('parseResidentConfig 返回 Result 风格', () => {
    expect(parseResidentConfig(valid).success).toBe(true);
    expect(parseResidentConfig({}).success).toBe(false);
  });
});
