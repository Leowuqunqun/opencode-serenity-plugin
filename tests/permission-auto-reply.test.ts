/**
 * permission auto-reply 单测（v1.3）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPermissionAutoReplyHandler } from '../src/hooks/permission-auto-reply.js';
import { resetState, setState, getState, type SerenityState } from '../src/state.js';

function setupSerenityRepo(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'serenity-perm-reply-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

function activatedState(cwdRoot: string): SerenityState {
  return { activated: true, cwdRoot, instanceName: 'home-serenity' };
}

describe('permission auto-reply (v1.3)', () => {
  beforeEach(() => {
    resetState();
  });

  it('event.type 不是 "permission.updated" → 跳过', async () => {
    const replyFn = vi.fn();
    const handler = createPermissionAutoReplyHandler({
      getClient: () => ({ postSessionIdPermissionsPermissionId: replyFn }),
    });
    await handler({ event: { type: 'message.updated', properties: { foo: 1 } } });
    expect(replyFn).not.toHaveBeenCalled();
  });

  it('plugin 未激活 → 跳过', async () => {
    const replyFn = vi.fn();
    const handler = createPermissionAutoReplyHandler({
      getClient: () => ({ postSessionIdPermissionsPermissionId: replyFn }),
    });
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
    const handler = createPermissionAutoReplyHandler({
      getClient: () => ({ postSessionIdPermissionsPermissionId: replyFn }),
    });
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
    const handler = createPermissionAutoReplyHandler({
      getClient: () => ({ postSessionIdPermissionsPermissionId: replyFn }),
    });
    await handler({
      event: {
        type: 'permission.updated',
        properties: { id: 'p1', type: 'edit', pattern: '/etc/passwd', sessionID: 's1' },
      },
    });
    expect(replyFn).not.toHaveBeenCalled();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pattern 在 cwdRoot 内（绝对路径）→ 调 reply "always"', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn().mockResolvedValue(true);
    const handler = createPermissionAutoReplyHandler({
      getClient: () => ({ postSessionIdPermissionsPermissionId: replyFn }),
    });
    const insidePath = join(tmp, 'foo.txt');
    await handler({
      event: {
        type: 'permission.updated',
        properties: { id: 'p-abc', type: 'edit', pattern: insidePath, sessionID: 's-xyz' },
      },
    });
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn).toHaveBeenCalledWith({
      path: { id: 's-xyz', permissionID: 'p-abc' },
      body: { response: 'always' },
    });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('client.postSessionIdPermissionsPermissionId 缺失 → 跳过', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const handler = createPermissionAutoReplyHandler({
      getClient: () => ({}),
    });
    await expect(
      handler({
        event: {
          type: 'permission.updated',
          properties: { id: 'p1', type: 'edit', pattern: join(tmp, 'foo.txt'), sessionID: 's1' },
        },
      }),
    ).resolves.toBeUndefined();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reply API 抛错 → 静默吞掉', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn().mockRejectedValue(new Error('network down'));
    const handler = createPermissionAutoReplyHandler({
      getClient: () => ({ postSessionIdPermissionsPermissionId: replyFn }),
    });
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

  it('pattern 是 string[] 多值 → 全部在内才 reply', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn().mockResolvedValue(true);
    const handler = createPermissionAutoReplyHandler({
      getClient: () => ({ postSessionIdPermissionsPermissionId: replyFn }),
    });
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
    const handler = createPermissionAutoReplyHandler({
      getClient: () => ({ postSessionIdPermissionsPermissionId: replyFn }),
    });
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

  it('pattern 为空（无 path 限制）→ 直接 reply', async () => {
    const tmp = setupSerenityRepo();
    setState(activatedState(tmp));
    const replyFn = vi.fn().mockResolvedValue(true);
    const handler = createPermissionAutoReplyHandler({
      getClient: () => ({ postSessionIdPermissionsPermissionId: replyFn }),
    });
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
