/**
 * permission auto-reply 单测（v1.3-v2 — v2 SDK client）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPermissionAutoReplyHandler } from '../src/hooks/permission-auto-reply.js';
import { resetState, setState, type SerenityState } from '../src/state.js';

function setupSerenityRepo(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'serenity-perm-reply-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

function activatedState(cwdRoot: string): SerenityState {
  return { activated: true, cwdRoot, instanceName: 'home-serenity' };
}

function makeDeps(replyFn: ReturnType<typeof vi.fn>, serverUrl = 'http://localhost:0') {
  return {
    getServerUrl: () => new URL(serverUrl),
    createV2Client: () => ({ permission: { reply: replyFn } }),
  };
}

describe('permission auto-reply (v1.3-v2)', () => {
  beforeEach(() => {
    resetState();
  });

  it('event.type 不是 "permission.updated" → 跳过', async () => {
    const replyFn = vi.fn();
    const handler = createPermissionAutoReplyHandler(makeDeps(replyFn));
    await handler({ event: { type: 'message.updated', properties: { foo: 1 } } });
    expect(replyFn).not.toHaveBeenCalled();
  });

  it('plugin 未激活 → 跳过', async () => {
    const replyFn = vi.fn();
    const handler = createPermissionAutoReplyHandler(makeDeps(replyFn));
    await handler({
      event: {
        type: 'permission.updated',
        properties: { id: 'p1', type: 'edit', pattern: '/x', sessionID: 's1' },
      },
    });
    expect(replyFn).not.toHaveBeenCalled();
  });

  it('event.properties 缺 id → 跳过', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn();
    const handler = createPermissionAutoReplyHandler(makeDeps(replyFn));
    await handler({
      event: { type: 'permission.updated', properties: { type: 'edit', pattern: '/x' } },
    });
    expect(replyFn).not.toHaveBeenCalled();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pattern 越界（绝对路径在 cwdRoot 外）→ 不 reply', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn();
    const handler = createPermissionAutoReplyHandler(makeDeps(replyFn));
    await handler({
      event: {
        type: 'permission.updated',
        properties: { id: 'p1', type: 'edit', pattern: '/etc/passwd', sessionID: 's1' },
      },
    });
    expect(replyFn).not.toHaveBeenCalled();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pattern 在 cwdRoot 内（绝对路径）→ v2 client.permission.reply("always")', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn().mockResolvedValue(true);
    const handler = createPermissionAutoReplyHandler(makeDeps(replyFn));
    const insidePath = join(tmp, 'foo.txt');
    await handler({
      event: {
        type: 'permission.updated',
        properties: { id: 'p-abc', type: 'edit', pattern: insidePath, sessionID: 's-xyz' },
      },
    });
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn).toHaveBeenCalledWith({
      requestID: 'p-abc',
      reply: 'always',
    });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('v2 client 创失败（serverUrl=null）→ 跳过', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn();
    const handler = createPermissionAutoReplyHandler({
      getServerUrl: () => null,
      createV2Client: () => ({ permission: { reply: replyFn } }),
    });
    await expect(
      handler({
        event: {
          type: 'permission.updated',
          properties: { id: 'p1', type: 'edit', pattern: join(tmp, 'foo.txt'), sessionID: 's1' },
        },
      }),
    ).resolves.toBeUndefined();
    expect(replyFn).not.toHaveBeenCalled();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('createV2Client 抛错 → 静默跳过', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn();
    const handler = createPermissionAutoReplyHandler({
      getServerUrl: () => new URL('http://localhost:0'),
      createV2Client: () => {
        throw new Error('sdk init failed');
      },
    });
    await expect(
      handler({
        event: {
          type: 'permission.updated',
          properties: { id: 'p1', type: 'edit', pattern: join(tmp, 'foo.txt'), sessionID: 's1' },
        },
      }),
    ).resolves.toBeUndefined();
    expect(replyFn).not.toHaveBeenCalled();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('v2 reply API 抛错 → 静默吞掉', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn().mockRejectedValue(new Error('network down'));
    const handler = createPermissionAutoReplyHandler(makeDeps(replyFn));
    await expect(
      handler({
        event: {
          type: 'permission.updated',
          properties: { id: 'p1', type: 'edit', pattern: join(tmp, 'foo.txt'), sessionID: 's1' },
        },
      }),
    ).resolves.toBeUndefined();
    expect(replyFn).toHaveBeenCalledTimes(1);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('v2 client 懒初始化（多次 event 应只创 1 次）', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn().mockResolvedValue(true);
    let createCallCount = 0;
    const handler = createPermissionAutoReplyHandler({
      getServerUrl: () => new URL('http://localhost:0'),
      createV2Client: () => {
        createCallCount++;
        return { permission: { reply: replyFn } };
      },
    });
    const insidePath = join(tmp, 'foo.txt');
    await handler({ event: { type: 'permission.updated', properties: { id: 'p1', type: 'edit', pattern: insidePath, sessionID: 's1' } } });
    await handler({ event: { type: 'permission.updated', properties: { id: 'p2', type: 'edit', pattern: insidePath, sessionID: 's1' } } });
    expect(createCallCount).toBe(1);
    expect(replyFn).toHaveBeenCalledTimes(2);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pattern 是 string[] 多值 → 全部在内才 reply', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn().mockResolvedValue(true);
    const handler = createPermissionAutoReplyHandler(makeDeps(replyFn));
    await handler({
      event: {
        type: 'permission.updated',
        properties: {
          id: 'p1',
          type: 'edit',
          pattern: [join(tmp, 'a.txt'), join(tmp, 'b.txt')],
          sessionID: 's1',
        },
      },
    });
    expect(replyFn).toHaveBeenCalledTimes(1);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pattern 是 string[] 含一个越界 → 不 reply', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn();
    const handler = createPermissionAutoReplyHandler(makeDeps(replyFn));
    await handler({
      event: {
        type: 'permission.updated',
        properties: {
          id: 'p1',
          type: 'edit',
          pattern: [join(tmp, 'a.txt'), '/etc/passwd'],
          sessionID: 's1',
        },
      },
    });
    expect(replyFn).not.toHaveBeenCalled();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pattern 为空（无 path 限制，如 webfetch）→ 直接 reply', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn().mockResolvedValue(true);
    const handler = createPermissionAutoReplyHandler(makeDeps(replyFn));
    await handler({
      event: {
        type: 'permission.updated',
        properties: { id: 'p1', type: 'webfetch', sessionID: 's1' },
      },
    });
    expect(replyFn).toHaveBeenCalledTimes(1);
    rmSync(tmp, { recursive: true, force: true });
  });
});
