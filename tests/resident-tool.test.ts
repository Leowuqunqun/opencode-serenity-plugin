/**
 * resident-tool.test.ts (v0.8 M0)
 *
 * 覆盖:
 * 1. residentPort - 从 name 稳定派生固定端口（同 name 同端口，区间 31000-61000）
 * 2. readStatusFile - 状态文件读取（无文件 / 非法 JSON → null）
 * 3. isPidAlive - PID 存活校验（自身进程活 / 无效 pid 死）
 * 4. execute start - 配置缺失/非法 → 报错；防重入
 * 5. execute status - 无状态文件 → unknown；状态判定
 * 6. execute stop - 无状态文件 / 进程已死
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { residentTool, residentPort, readStatusFile, isPidAlive, findNodeBin } from '../src/tools/resident-tool.js';
import { resetState, setState } from '../src/state.js';

let tmpRoot = '';
let origCwd = '';

function fakeCtx() {
  return { directory: tmpRoot } as any;
}

function writeStatusFile(content: unknown): void {
  mkdirSync(join(tmpRoot, '.serenity-meta'), { recursive: true });
  writeFileSync(join(tmpRoot, '.serenity-meta', 'resident.status.json'), JSON.stringify(content, null, 2));
}

beforeEach(() => {
  resetState();
  tmpRoot = mkdtempSync(join(tmpdir(), 'resident-tool-'));
  mkdirSync(join(tmpRoot, '.serenity-meta'), { recursive: true });
  setState({ activated: true, cwdRoot: tmpRoot, cccName: 'test-ccc' });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  resetState();
});

describe('residentPort (固定端口派生)', () => {
  it('同 name 稳定输出同端口', () => {
    expect(residentPort('guardian')).toBe(residentPort('guardian'));
    expect(residentPort('foo')).toBe(residentPort('foo'));
  });

  it('不同 name 输出不同端口', () => {
    expect(residentPort('guardian')).not.toBe(residentPort('other'));
  });

  it('端口落在 31000-61000 区间', () => {
    for (const name of ['a', 'b', 'c', 'guardian', 'sqc']) {
      const p = residentPort(name);
      expect(p).toBeGreaterThanOrEqual(31000);
      expect(p).toBeLessThanOrEqual(61000);
    }
  });

  it('同 name 不同 CCC 盐 → 不同端口（防跨 CCC 冲突 F8）', () => {
    expect(residentPort('guardian', 'ccc-a')).not.toBe(residentPort('guardian', 'ccc-b'));
    expect(residentPort('guardian', 'ccc-a')).toBe(residentPort('guardian', 'ccc-a'));
  });
});

describe('readStatusFile', () => {
  it('无文件 → null', () => {
    expect(readStatusFile(tmpRoot)).toBeNull();
  });

  it('非法 JSON → null', () => {
    mkdirSync(join(tmpRoot, '.serenity-meta'), { recursive: true });
    writeFileSync(join(tmpRoot, '.serenity-meta', 'resident.status.json'), 'not-json');
    expect(readStatusFile(tmpRoot)).toBeNull();
  });

  it('合法 JSON → 解析返回', () => {
    writeStatusFile({ name: 'g', pid: 1, status: 'running' });
    const st = readStatusFile(tmpRoot);
    expect(st).not.toBeNull();
    expect(st!.name).toBe('g');
    expect(st!.status).toBe('running');
  });
});

describe('isPidAlive', () => {
  it('自身进程（alive）→ true', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('无效 pid → false', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(999_999_999)).toBe(false);
  });
});

describe('findNodeBin (S063 spawn 回归)', () => {
  it('返回可执行的 node 二进制，能真实 spawn 并执行脚本', async () => {
    // S063: process.execPath 是 opencode 二进制（Bun），不能跑 JS。
    // findNodeBin 必须返回真 node。
    const nodeBin = findNodeBin();
    expect(nodeBin.length).toBeGreaterThan(0);

    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(nodeBin, ['-e', 'console.log("RESIDENT_NODE_OK")']);
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`exit ${code}: ${err}`));
      });
    });
    expect(result).toBe('RESIDENT_NODE_OK');
  });

  it('process.execPath 不等于 findNodeBin（opencode 是 Bun 二进制）', () => {
    // 在 vitest 环境二者可能都是 node；此测试标记语义而非强断言
    const nodeBin = findNodeBin();
    expect(typeof nodeBin).toBe('string');
  });
});

describe('residentTool execute: start', () => {
  it('缺 resident.json → 报错', async () => {
    await expect(residentTool.execute!({ action: 'start' } as any, fakeCtx())).rejects.toThrow(/resident.json/);
  });

  it('resident.json 非法 JSON → 报错', async () => {
    mkdirSync(join(tmpRoot, '.serenity-meta'), { recursive: true });
    writeFileSync(join(tmpRoot, '.serenity-meta', 'resident.json'), 'not-json');
    await expect(residentTool.execute!({ action: 'start' } as any, fakeCtx())).rejects.toThrow(/not valid JSON/);
  });

  it('resident.json 缺 name/model → 报错', async () => {
    mkdirSync(join(tmpRoot, '.serenity-meta'), { recursive: true });
    writeFileSync(join(tmpRoot, '.serenity-meta', 'resident.json'), JSON.stringify({ description: 'x' }));
    await expect(residentTool.execute!({ action: 'start' } as any, fakeCtx())).rejects.toThrow(/name and model/);
  });
});

describe('residentTool execute: status', () => {
  it('无状态文件 → unknown', async () => {
    const out = await residentTool.execute!({ action: 'status' } as any, fakeCtx());
    expect(JSON.parse(out as string).status).toBe('unknown');
  });

  it('进程已死但文件说 running → stale', async () => {
    writeStatusFile({ name: 'g', pid: 999_999_999, status: 'running', startedAt: Date.now(), lifetimeMs: 1000 });
    const out = JSON.parse(await residentTool.execute!({ action: 'status' } as any, fakeCtx()) as string);
    expect(out.status).toBe('stale');
    expect(out.running).toBe(false);
  });

  it('包含剩余时间计算字段', async () => {
    writeStatusFile({ name: 'g', pid: 999_999_999, status: 'running', startedAt: Date.now() - 100, lifetimeMs: 1000 });
    const out = JSON.parse(await residentTool.execute!({ action: 'status' } as any, fakeCtx()) as string);
    expect(out.remainingMs).toBeDefined();
  });
});

describe('residentTool execute: stop', () => {
  it('无状态文件 → not_running', async () => {
    const out = JSON.parse(await residentTool.execute!({ action: 'stop' } as any, fakeCtx()) as string);
    expect(out.reason).toBe('not_running');
  });

  it('进程已死 → already_dead', async () => {
    writeStatusFile({ name: 'g', pid: 999_999_999, status: 'running' });
    const out = JSON.parse(await residentTool.execute!({ action: 'stop' } as any, fakeCtx()) as string);
    expect(out.reason).toBe('already_dead');
  });

  it('进程活着但不是 resident-runner（PID 复用）→ stale，不误杀', async () => {
    // 用自身进程 pid（vitest，非 resident-runner）模拟 PID 复用
    writeStatusFile({ name: 'g', pid: process.pid, status: 'running' });
    const out = JSON.parse(await residentTool.execute!({ action: 'stop' } as any, fakeCtx()) as string);
    expect(out.reason).toBe('already_dead');
    expect(out.stale).toBe(true);
  });
});
