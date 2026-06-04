import { describe, it, expect, beforeEach } from 'vitest';
import { ReadyStateMachine } from '../src/util/ready-state.js';

describe('ReadyStateMachine', () => {
  let machine: ReadyStateMachine;

  beforeEach(() => {
    machine = new ReadyStateMachine();
  });

  it('starts in idle state', () => {
    expect(machine.state).toBe('idle');
    expect(machine.isReady()).toBe(false);
  });

  it('transitions to loading on start()', () => {
    void machine.start(async () => {
      // 模拟 IO
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(machine.state).toBe('loading');
  });

  it('transitions to ready when loader resolves', async () => {
    const promise = machine.start(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    await promise;
    expect(machine.state).toBe('ready');
    expect(machine.isReady()).toBe(true);
  });

  it('transitions to error when loader throws', async () => {
    const promise = machine.start(async () => {
      throw new Error('test error');
    });
    await expect(promise).rejects.toThrow('test error');
    expect(machine.state).toBe('error');
    expect(machine.reason?.message).toBe('test error');
  });

  it('whenReady() resolves immediately if state is ready', async () => {
    void machine.start(async () => {});
    await new Promise((r) => setTimeout(r, 10));
    await expect(machine.whenReady()).resolves.toBeUndefined();
  });

  it('whenReady() blocks during loading', async () => {
    let resolveLoader: () => void = () => {};
    void machine.start(
      () =>
        new Promise<void>((r) => {
          resolveLoader = r;
        }),
    );
    // 此时 state=loading；whenReady 应该阻塞
    const whenReadyPromise = machine.whenReady();
    // 模拟 LLM 同时调多次 whenReady — 应该返回同一 Promise
    const whenReadyPromise2 = machine.whenReady();
    // 解除 loader
    resolveLoader();
    await expect(whenReadyPromise).resolves.toBeUndefined();
    await expect(whenReadyPromise2).resolves.toBeUndefined();
  });

  it('whenReady() rejects if state is error', async () => {
    const promise = machine.start(async () => {
      throw new Error('boom');
    });
    // 显式 catch 防止 unhandled rejection
    await expect(promise).rejects.toThrow('boom');
    expect(machine.state).toBe('error');
    await expect(machine.whenReady()).rejects.toThrow('boom');
  });

  it('whenReady() rejects if state is disabled', async () => {
    machine.markDisabled('RR6 fail');
    await expect(machine.whenReady()).rejects.toThrow('RR6 fail');
  });

  it('whenReady() rejects if state is idle (never started)', async () => {
    await expect(machine.whenReady()).rejects.toThrow(/idle/);
  });

  it('start() multiple times returns same promise (idempotent)', async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
    };
    const p1 = machine.start(loader);
    const p2 = machine.start(loader);
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it('markAsReady() transitions loading → ready (v0 路径)', () => {
    void machine.start(async () => {
      // 永远不 resolve（v0 走 markAsReady 路径）
      await new Promise(() => {});
    });
    expect(machine.state).toBe('loading');
    machine.markAsReady();
    expect(machine.state).toBe('ready');
  });

  it('markDisabled() from idle prevents loader from being called', async () => {
    let called = false;
    machine.markDisabled('pre-empted');
    // 此时 start() 不会再触发 loader
    const p = machine.start(async () => {
      called = true;
    });
    await p.catch(() => {});
    expect(called).toBe(false);
  });

  it('reset() restores idle state (test cleanup)', () => {
    void machine.start(async () => {});
    machine.reset();
    expect(machine.state).toBe('idle');
  });
});
