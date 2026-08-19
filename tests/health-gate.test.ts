/**
 * Health Gate 注入测试 — 硬门禁逻辑
 *
 * 场景：
 *  1. 无任何未清零项 → 返回 null（不注入，避免噪音）
 *  2. 有 checkpoint 残留 → 返回门禁块且包含该问题
 *  3. 有 auto-fix 待处理 → 返回门禁块
 *  4. 新 checkpoint（<30 分钟）不触发门禁
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHealthGateBlock } from '../src/hooks/compacting.js';

describe('buildHealthGateBlock', () => {
  let fakeSessions: string;

  beforeEach(() => {
    fakeSessions = mkdtempSync(join(tmpdir(), 'health-gate-'));
    mkdirSync(join(fakeSessions, 'checkpoints'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeSessions, { recursive: true, force: true });
    try { rmSync('/tmp/pigha-auto-fix-result.txt', { force: true }); } catch { /* ignore */ }
  });

  it('无未清零项 → 返回 null（不注入噪音）', () => {
    expect(buildHealthGateBlock(fakeSessions)).toBeNull();
  });

  it('有 checkpoint 残留（30+ 分钟）→ 返回门禁块', () => {
    const cpPath = join(fakeSessions, 'checkpoints', 'old-session.md');
    writeFileSync(cpPath, '# Checkpoint');
    const past = new Date(Date.now() - 40 * 60 * 1000);
    utimesSync(cpPath, past, past);

    const block = buildHealthGateBlock(fakeSessions);
    expect(block).not.toBeNull();
    expect(block).toContain('Serenity Health Gate');
    expect(block).toContain('old-session.md');
  });

  it('有 auto-fix 待处理 → 返回门禁块', () => {
    // 用独立标记文件验证（隔离并发污染）
    const tmpAutoFix = join(fakeSessions, '..', 'tmp-auto-fix-result.txt');
    // 通过 override 指向的目录无法注入 tmp，这里直接构造：临时把函数读取路径隔离
    // 实际测试：写一个真实 /tmp 文件但只在单测内清理
    writeFileSync('/tmp/pigha-auto-fix-result.txt', '待 LLM 处理: 有\n');
    const block = buildHealthGateBlock(fakeSessions);
    expect(block).not.toBeNull();
    expect(block).toContain('auto-fix');
  });

  it('新 checkpoint（<30 分钟）不触发门禁', () => {
    writeFileSync(join(fakeSessions, 'checkpoints', 'fresh.md'), '# Checkpoint');
    expect(buildHealthGateBlock(fakeSessions)).toBeNull();
  });

  it('有 resident 标记 → 返回门禁块', () => {
    writeFileSync(join(fakeSessions, '.resident-need-attention'), '2026-08-19');
    const block = buildHealthGateBlock(fakeSessions);
    expect(block).not.toBeNull();
    expect(block).toContain('resident');
  });
});