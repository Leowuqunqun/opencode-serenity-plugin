/**
 * Permission Auto-Reply Hook（v1.3 B 路径）
 *
 * 监听 opencode `permission.updated` event，对**所有 patterns 都在 cwdRoot 内**的请求
 * 自动 reply `"always"`（**永久放行**——本 session 后续相同 pattern 不再弹窗）。
 *
 * 与 RR5（路径守卫）的协同：
 * - RR5: tool.execute.before 防御 cwdRoot 外 throw（plugin 层 hard stop）
 * - 本 hook: cwdRoot 内一律放行（避免 opencode 弹窗打断 LLM 流程）
 * - cwdRoot 外：不自动 reply → opencode 走原始 ask 弹窗（user 显式决定）
 *
 * 行为细节：
 * - 仅在 plugin 激活时生效（state.activated）
 * - v1 SDK 事件：`type: "permission.updated"`，properties = Permission 对象
 * - v1 SDK reply：`client.postSessionIdPermissionsPermissionId(...)`
 * - reply 失败 → 静默让 opencode 走原始 ask 弹窗（不阻断）
 * - reply 成功 → 本 session 内 pattern 永久放行
 *
 * 关于 SDK 版本：
 * - v1 SDK（@opencode-ai/sdk）Event union 不含 "permission.asked"
 * - v1 实际事件名 = "permission.updated"（Permission 状态变化）
 * - v2 SDK（@opencode-ai/sdk/v2）才有 "permission.asked"——本 plugin 走 v1
 */

import { log } from '../util/log.js';
import { isPathInside } from '../util/git.js';
import { getState } from '../state.js';

/** 简化 SDK client 类型（仅本 hook 用到的部分） */
type ReplyClient = {
  postSessionIdPermissionsPermissionId: (params: {
    path: { id: string; permissionID: string };
    body: { response: 'once' | 'always' | 'reject' };
  }) => Promise<unknown>;
} | null;

export interface PermissionAutoReplyDeps {
  /** SDK client（plugin input.client）；null 表示未注入（测试用） */
  getClient: () => unknown;
}

/** v1 Permission 事件 properties 简化版（只取用到的字段） */
type V1PermissionProps = {
  id: string;
  type: string;  // tool name (e.g. "edit", "read", "webfetch")
  pattern?: string | Array<string>;
  sessionID: string;
};

/** v1 Event union 简化版（只 type narrowing 用到的） */
type V1EventLike = { type: string; properties?: unknown };

/**
 * event hook 处理器
 * 收到 opencode event，识别 permission.updated 并自动 reply
 */
export function createPermissionAutoReplyHandler(
  deps: PermissionAutoReplyDeps,
): (input: { event: V1EventLike }) => Promise<void> {
  return async (input) => {
    const event = input.event;
    if (!event || event.type !== 'permission.updated') return;

    const state = getState();
    if (!state.activated) return;

    // 解析 v1 event payload
    const props = event.properties as V1PermissionProps | undefined;
    if (!props || !props.id) {
      log.warn('perm-reply', 'permission.updated event missing id', { type: event.type });
      return;
    }

    const toolName = props.type ?? 'unknown';
    const pattern = props.pattern;
    const patterns: string[] = Array.isArray(pattern) ? pattern : pattern ? [pattern] : [];

    // 判定：所有 patterns 都在 cwdRoot 内
    if (patterns.length > 0) {
      const allInside = patterns.every((p) => isPathInside(state.cwdRoot, p));
      if (!allInside) {
        log.info('perm-reply', 'patterns outside cwdRoot; skipping auto-reply', {
          tool: toolName,
          patterns,
          cwdRoot: state.cwdRoot,
        });
        return;
      }
    }

    // reply "always" via v1 SDK API
    const client = deps.getClient() as ReplyClient;
    if (
      !client ||
      typeof client.postSessionIdPermissionsPermissionId !== 'function'
    ) {
      log.warn('perm-reply', 'SDK client.postSessionIdPermissionsPermissionId unavailable; skipping auto-reply', {
        requestID: props.id,
      });
      return;
    }

    try {
      await client.postSessionIdPermissionsPermissionId({
        path: { id: props.sessionID, permissionID: props.id },
        body: { response: 'always' },
      });
      log.info('perm-reply', 'auto-replied always', {
        tool: toolName,
        patterns,
        requestID: props.id,
      });
    } catch (err) {
      log.warn('perm-reply', 'reply failed; falling back to opencode ask', {
        requestID: props.id,
        err: String(err),
      });
    }
  };
}
