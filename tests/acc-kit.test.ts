/**
 * acc-kit.test.ts (v0.8 M0)
 *
 * 覆盖:
 * 1. health - CCC 三原则检查（P1/P2/P3 字段存在）
 * 2. time - 输出含 now_iso / now_local / epoch_ms 字段
 * 3. wait - 等待指定秒数
 *
 * 注意：vitest worker 不支持 process.chdir()，用 setState 注入 CCC 状态。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { accKitTool } from '../src/acc-kit.js';
import { resetState, setState } from '../src/state.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpRoot = '';

beforeEach(() => {
  resetState();
  tmpRoot = mkdtempSync(join(tmpdir(), 'acc-kit-test-'));
  mkdirSync(join(tmpRoot, '.serenity-meta'), { recursive: true });
  writeFileSync(join(tmpRoot, '.serenity'), 'test-ccc\n');
  writeFileSync(join(tmpRoot, 'opencode.json'), '{}');
  setState({
    activated: true,
    cwdRoot: tmpRoot,
    cccName: 'test-ccc',
    skillPath: null,
    skillContent: null,
    needsPhase2: false,
    phase2Prompt: null,
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  resetState();
});

const ctx = () => ({ directory: tmpRoot });

describe('acc_kit health', () => {
  it('输出 CCC 三原则字段 P1/P2/P3', async () => {
    const out = await accKitTool.execute!({ action: 'health' }, ctx() as any);
    const report = JSON.parse(out as string);
    expect(report.status).toBeDefined();
    expect(report.principles).toBeDefined();
    expect(report.principles.P1_rooted).toBeDefined();
    expect(report.principles.P2_git_managed).toBeDefined();
    expect(report.principles.P3_binary_permissions).toBeDefined();
  });

  it('P1/P3 pass（.serenity 和 opencode.json 存在），P2 依赖 activated', async () => {
    const out = await accKitTool.execute!({ action: 'health' }, ctx() as any);
    const report = JSON.parse(out as string);
    expect(report.principles.P1_rooted.pass).toBe(true);
    expect(report.principles.P3_binary_permissions.pass).toBe(true);
    expect(report.principles.P2_git_managed.pass).toBe(true); // setState activated
  });
});

describe('acc_kit time', () => {
  it('输出 now_iso / now_local / epoch_ms', async () => {
    const out = await accKitTool.execute!({ action: 'time' }, ctx() as any);
    const data = JSON.parse(out as string);
    expect(data.now_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.now_local).toBeTruthy();
    expect(typeof data.epoch_ms).toBe('number');
    expect(Math.abs(data.epoch_ms - Date.now())).toBeLessThan(5000);
  });
});

describe('acc_kit wait', () => {
  it('等待指定秒数', async () => {
    const t0 = Date.now();
    const out = await accKitTool.execute!({ action: 'wait', seconds: 1 }, ctx() as any);
    const elapsed = Date.now() - t0;
    expect(out).toContain('waited 1s');
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });
});
