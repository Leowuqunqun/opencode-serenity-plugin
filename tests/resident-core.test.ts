/**
 * resident-core.test.ts (v0.8 M0)
 *
 * 覆盖 resident-core.ts 全部纯函数：
 * 1. atomicWrite - 原子写（内容正确、无 .tmp 残留）
 * 2. extractMind - MIND 块提取（单个/多块/截断/无块/STOP 在 END 后）
 * 3. hasStopSignal - STOP 检测（token 精确匹配、必须位于 MIND 块之后）
 * 4. lifecycleRemaining - 生命周期剩余计算
 * 5. computePostTimeoutMs - 每轮超时计算（min/max/grace 逻辑）
 * 6. newStopToken - 随机 token（长度、唯一性）
 * 7. buildMessage - 模板构建（含身份/心智/倒计时/STOP 语义）
 * 8. isOpenCodeServeOnPort - 进程身份校验
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWrite,
  extractMind,
  hasStopSignal,
  lifecycleRemaining,
  computePostTimeoutMs,
  newStopToken,
  buildMessage,
  isOpenCodeServeOnPort,
  isResidentRunner,
  tryAcquireLock,
  readLockOwner,
  releaseLock,
} from '../src/tools/resident-core.js';
import type { ResidentConfig } from '../src/config-schema.js';

const validConfig: ResidentConfig = {
  name: 'guardian',
  description: 'CCC resident',
  model: 'minimax-cn-coding-plan/MiniMax-M3',
  mind: { file: '.serenity-meta/mind.md' },
  cycle: {
    type: 'forever',
    intervalMs: 3600000,
    timeoutMs: 7200000,
    lifetimeMs: 21600000,
  },
};

describe('atomicWrite', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atomic-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('写入内容正确且无 .tmp 残留', () => {
    const target = join(dir, 'mind.md');
    atomicWrite(target, '# mind\ncontent');
    expect(readFileSync(target, 'utf8')).toBe('# mind\ncontent');
    // renameSync 后 .tmp 文件已不存在（原子替换完成）
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('覆盖已存在文件', () => {
    const target = join(dir, 'mind.md');
    writeFileSync(target, 'old');
    atomicWrite(target, 'new content');
    expect(readFileSync(target, 'utf8')).toBe('new content');
  });
});

describe('extractMind', () => {
  it('提取单个完整块', () => {
    const resp = ['work...', '---MIND-BEGIN---', '# mind', '## goals', 'foo', '---MIND-END---'].join('\n');
    expect(extractMind(resp)).toContain('# mind');
    expect(extractMind(resp)).toContain('foo');
  });

  it('多个块 → 取最后一个完整块', () => {
    const resp = [
      '---MIND-BEGIN---', 'first', '---MIND-END---',
      'text',
      '---MIND-BEGIN---', 'second', '---MIND-END---',
    ].join('\n');
    expect(extractMind(resp)).toBe('second');
  });

  it('截断（有 BEGIN 无 END）→ null', () => {
    expect(extractMind('---MIND-BEGIN---\npartial')).toBeNull();
  });

  it('无 MIND 块 → null', () => {
    expect(extractMind('no mind here')).toBeNull();
  });

  it('MIND 块内容被 trim（去掉首尾空白）', () => {
    const resp = ['---MIND-BEGIN---', '\n  # mind  \n', '---MIND-END---'].join('\n');
    expect(extractMind(resp)).toBe('# mind');
  });
});

describe('hasStopSignal', () => {
  it('token 在 MIND 块之后 → true', () => {
    const resp = ['---MIND-BEGIN---', '# m', '---MIND-END---', '---STOP abc---'].join('\n');
    expect(hasStopSignal(resp, 'abc')).toBe(true);
  });

  it('token 不存在 → false', () => {
    const resp = 'no stop here';
    expect(hasStopSignal(resp, 'abc')).toBe(false);
  });

  it('token 在 MIND 块之前 → false（STOP 必须位于 MIND 后）', () => {
    const resp = ['---STOP abc---', '---MIND-BEGIN---', '# m', '---MIND-END---'].join('\n');
    expect(hasStopSignal(resp, 'abc')).toBe(false);
  });

  it('无 MIND 块时 token 出现 → true', () => {
    expect(hasStopSignal('just ---STOP abc---', 'abc')).toBe(true);
  });

  it('token 必须精确匹配（前缀不匹配）', () => {
    expect(hasStopSignal('---STOP abc---', 'ab')).toBe(false);
  });
});

describe('lifecycleRemaining', () => {
  it('剩余 = start + lifetime - now', () => {
    expect(lifecycleRemaining(1000, 5000, 2000)).toBe(4000);
  });

  it('生命周期已过 → 负值', () => {
    expect(lifecycleRemaining(1000, 5000, 7000)).toBe(-1000);
  });
});

describe('computePostTimeoutMs', () => {
  it('剩余充足 → timeoutMs', () => {
    expect(computePostTimeoutMs(7200000, 3600000, 10_000_000)).toBe(7200000);
  });

  it('剩余不足 → 剩余 + grace（< timeoutMs）', () => {
    // 剩余 30min + grace 1h = 1.5h < 2h
    expect(computePostTimeoutMs(7200000, 3600000, 1_800_000)).toBe(5_400_000);
  });

  it('剩余极小但 grace 大 → 给足收尾时间（剩余+grace）', () => {
    // 剩余 1s + grace 1h = 3601000 < timeout 2h
    expect(computePostTimeoutMs(7200000, 3600000, 1000)).toBe(3_601_000);
  });

  it('剩余+grace 低于 10s 兜底 → 10s', () => {
    // grace = interval = 1s，剩余 1s → 剩余+grace = 2s < 10s → 兜底 10s
    expect(computePostTimeoutMs(7200000, 1000, 1000)).toBe(10_000);
  });

  it('intervalMs 为 0 → grace 用默认 60s', () => {
    expect(computePostTimeoutMs(7200000, 0, 30_000)).toBe(90_000);
  });
});

describe('newStopToken', () => {
  it('32 hex 字符（128 bit）', () => {
    expect(newStopToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('两次调用不同', () => {
    expect(newStopToken()).not.toBe(newStopToken());
  });
});

describe('buildMessage', () => {
  it('包含身份/心智/倒计时/轮次/STOP 语义', () => {
    const msg = buildMessage(validConfig, 'tok123', '## goals\nfoo', 3, 42_000);
    expect(msg).toContain('persistent resident intelligence');
    expect(msg).toContain('CCC resident');
    expect(msg).toContain('minimax-cn-coding-plan/MiniMax-M3');
    expect(msg).toContain('## goals\nfoo'); // 心智内容注入
    expect(msg).toContain('Remaining time: 42000ms');
    expect(msg).toContain('Current round: 3');
    expect(msg).toContain('---MIND-BEGIN---');
    expect(msg).toContain('---STOP tok123---');
    expect(msg).toContain('Do NOT fake the STOP signal');
  });

  it('包含禁止自指 / 禁止绑定 session / 心智自包含要求', () => {
    const msg = buildMessage(validConfig, 't', '', 1, 1000);
    expect(msg).toContain('Do NOT call loop-control tools');
    expect(msg).toContain('Do NOT bind an AGENT_SESSIONS session');
    expect(msg).toContain('continue your cognition from it alone');
  });
});

describe('isOpenCodeServeOnPort', () => {
  it('非 opencode 进程 → false（用自身进程测 /proc cmdline 含 node 而非 opencode）', () => {
    // 自身进程是 vitest（node），cmdline 不含 'opencode serve --port'
    expect(isOpenCodeServeOnPort(process.pid, 9999)).toBe(false);
  });

  it('无效 pid → false', () => {
    expect(isOpenCodeServeOnPort(-1, 9999)).toBe(false);
    expect(isOpenCodeServeOnPort(0, 9999)).toBe(false);
  });
});

describe('isResidentRunner', () => {
  it('自身进程（vitest，非 resident-runner）→ false', () => {
    expect(isResidentRunner(process.pid)).toBe(false);
  });

  it('无效 pid → false', () => {
    expect(isResidentRunner(-1)).toBe(false);
    expect(isResidentRunner(0)).toBe(false);
  });
});

describe('atomic lock (tryAcquireLock / readLockOwner / releaseLock)', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('第一次获取成功，第二次（未释放）失败', () => {
    const lockPath = join(dir, 'resident.lock');
    const fd1 = tryAcquireLock(lockPath, 111);
    expect(fd1).not.toBeNull();
    // 同一进程再次获取 → O_EXCL 失败
    expect(tryAcquireLock(lockPath, 222)).toBeNull();
    // 锁持有者正确
    expect(readLockOwner(lockPath)).toBe(111);
  });

  it('释放后可重新获取', () => {
    const lockPath = join(dir, 'resident.lock');
    const fd1 = tryAcquireLock(lockPath, 111);
    expect(fd1).not.toBeNull();
    releaseLock(lockPath, fd1);
    const fd2 = tryAcquireLock(lockPath, 222);
    expect(fd2).not.toBeNull();
    expect(readLockOwner(lockPath)).toBe(222);
    releaseLock(lockPath, fd2);
  });

  it('readLockOwner 对不存在的锁 → null', () => {
    expect(readLockOwner(join(dir, 'nope.lock'))).toBeNull();
  });
});
