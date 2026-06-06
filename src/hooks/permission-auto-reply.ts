/**
 * Permission Auto-Reply Hook（v1.3-v2 升级）
 *
 * 监听 opencode `permission.updated` event，对**所有 patterns 都在 cwdRoot 内**的请求
 * 自动 reply `"always"`（**永久放行**——本 session 后续相同 pattern 不再弹窗）。
 *
 * 与 RR5（路径守卫）的协同：
 * - RR5: tool.execute.before 防御 cwdRoot 外 throw（plugin 层 hard stop）
 * - 本 hook: cwdRoot 内一律放行（避免 opencode 弹窗打断 LLM 流程）
 * - cwdRoot 外：不自动 reply → opencode 走原始 ask 弹窗（user 显式决定）
 *
 * v1/v2 SDK 关系（实测 1.16.2）：
 * - plugin 的 Event 类型来自 v1 SDK（`@opencode-ai/sdk`）—— 仍只能监听 `permission.updated`
 * - v1 main client 没有 v2 风格的 `permission.reply` 新 API
 * - v2 subpath (`@opencode-ai/sdk/v2`) 才有 `createOpencodeClient({baseUrl})` + `client.permission.reply({requestID, reply})`
 * - 本 hook 创 v2 client + 缓存 + 用 v2 新 API（不调用 v1 deprecated `respond`）
 *
 * 行为细节：
 * - 仅在 plugin 激活时生效（state.activated）
 * - v2 client 创失败 / 缺失 → 静默让 opencode 走原始 ask（不阻断）
 * - reply 失败 → 静默让 opencode 走原始 ask
 * - reply 成功 → 本 session 内 pattern 永久放行
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { log } from '../util/log.js';
import { isPathInside } from '../util/git.js';
import { getState } from '../state.js';

/** v2 client 简化类型（仅本 hook 用到的部分） */
type V2Client = {
  permission: {
    reply: (params: {
      requestID: string;
      directory?: string;
      workspace?: string;
      reply?: 'once' | 'always' | 'reject';
      message?: string;
    }) => Promise<unknown>;
  };
};

export interface PermissionAutoReplyDeps {
  /** plugin input.serverUrl（URL 对象）— 用于 v2 createOpencodeClient({baseUrl}） */
  getServerUrl: () => URL | null;
  /** 工厂注入点：测试可注入 mock createOpencodeClient（避免真实 HTTP） */
  createV2Client?: (config: { baseUrl: string }) => V2Client;
}

/** v1 Permission 事件 properties 简化版（只取用到的字段） */
type V1PermissionProps = {
  id: string;
  type: string; // tool name (e.g. "edit", "read", "webfetch")
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
  // 缓存 v2 client（lazy 初始化 + 单例）
  let v2ClientCache: V2Client | null = null;
  let v2ClientInitFailed = false;

  function getV2Client(): V2Client | null {
    if (v2ClientCache) return v2ClientCache;
    if (v2ClientInitFailed) return null;
    const serverUrl = deps.getServerUrl();
    if (!serverUrl) {
      log.warn('perm-reply', 'serverUrl unavailable; v2 client not initialized');
      v2ClientInitFailed = true;
      return null;
    }
    try {
      const factory = deps.createV2Client ?? ((config: { baseUrl: string }) => createOpencodeClient(config) as unknown as V2Client);
      v2ClientCache = factory({ baseUrl: serverUrl.toString() });
      log.debug('perm-reply', 'v2 client initialized', { baseUrl: serverUrl.toString() });
      return v2ClientCache;
    } catch (err) {
      log.warn('perm-reply', 'v2 client init failed; auto-reply disabled', { err: String(err) });
      v2ClientInitFailed = true;
      return null;
    }
  }

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

    // 用 v2 client reply "always"
    const client = getV2Client();
    if (!client) return;

    try {
      await client.permission.reply({
        requestID: props.id,
        reply: 'always',
      });
      log.info('perm-reply', 'auto-replied always (v2)', {
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
