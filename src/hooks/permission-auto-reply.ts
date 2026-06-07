/**
 * Permission Auto-Reply Hook（v1.3-v2 → v1.3-v3 → v1.3-v4 演进）
 *
 * 监听 opencode permission 事件，**无条件 reply `"always"`**（trust opencode
 * own `always` list 作为单一真相源）。
 *
 * v1.3-v4 决策（基于真实 payload 观测）：
 * - opencode 1.16+ 在推送 `permission.asked` 事件时，**`always` 字段已包含
 *   opencode 自己判定 "始终放行" 的 pattern 列表**（per user opencode.json 配置）
 * - plugin 应**直接 reply "always"**，不需做自己的 pattern/cwdRoot check
 * - 这就是用户 "装好 agent 就能放开权限" 的最简实现：opencode 自己的
 *   always 列表 = 单一真相源；plugin 不应重复做权限判定
 * - 如果用户想要 "cwdRoot 外不弹窗" — 应该改 opencode.json#permission，
 *   不应由 plugin 拦
 *
 * 演进历史：
 * - v1.3-v2：只听 `permission.updated` 事件，事件名错（plugin 收到 0 事件）→ 不工作
 * - v1.3-v3：根因修复 — 加听 `permission.asked` / `permission.v2.asked` + 解析
 *   v1/v2 两种 props schema + 改用 v2 client permission reply API
 * - v1.3-v4：简化 — 删 "patterns 都在 cwdRoot 内" 的硬约束，改 trust
 *   opencode `always` 列表（v1.3-v3 已收到事件 + 已能 reply，只是多做了
 *   无意义的 pattern check）
 *
 * 事件名与 props schema 矩阵：
 * | 事件名                  | type 字段       | pattern 字段            | reply API                                          |
 * |-------------------------|-----------------|-------------------------|----------------------------------------------------|
 * | `permission.updated`    | `type`          | `pattern` (string\|[])  | v2 `client.permission.reply({requestID, reply})`   |
 * | `permission.asked`      | `permission`    | `patterns` (string[])   | 同上（v2 事件 v1 props 兼容）                      |
 * | `permission.v2.asked`   | `permission`    | `patterns` (string[])   | 同上（v2 事件 v2 props）                            |
 *
 * 行为细节：
 * - 仅在 plugin 激活时生效（state.activated）
 * - v2 client 初始化失败 / 缺失 → 静默让 opencode 走原始 ask（不阻断）
 * - reply 失败 → 静默让 opencode 走原始 ask
 * - reply 成功 → opencode 自身把 pattern 加到 "always" 列表（单 session 永久放行）
 *
 * 与 RR5（路径守卫）的协同：
 * - RR5: tool.execute.before 防御 cwdRoot 外 throw（plugin 层 hard stop）
 * - 本 hook: 对 opencode 弹窗一律 reply "always"（trust opencode 配置）
 * - 两者无冲突：RR5 拦的是"已经到达 plugin 的危险调用"，本 hook 处理
 *   "opencode 想弹窗询问 user 之前"的阶段
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { log } from '../util/log.js';
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
    respond: (params: {
      requestID: string;
      reply?: 'once' | 'always' | 'reject';
      message?: string;
    }) => Promise<unknown>;
  };
  session: {
    permission: {
      reply: (params: {
        sessionID: string;
        requestID: string;
        reply?: 'once' | 'always' | 'reject';
        message?: string;
      }) => Promise<unknown>;
    };
  };
};

export interface PermissionAutoReplyDeps {
  /** plugin input.serverUrl（URL 对象）— 用于 v2 createOpencodeClient({baseUrl}） */
  getServerUrl: () => URL | null;
  /** 工厂注入点：测试可注入 mock createOpencodeClient（避免真实 HTTP） */
  createV2Client?: (config: { baseUrl: string }) => V2Client;
}

/** v1 Permission 事件 properties 简化版 */
type V1PermissionProps = {
  id: string;
  type: string; // tool name (e.g. "edit", "read", "webfetch")
  pattern?: string | Array<string>;
  sessionID: string;
};

/** v2 PermissionRequest 事件 properties 简化版 */
type V2PermissionProps = {
  id: string;
  sessionID: string;
  permission: string; // tool name
  patterns: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID: string; callID: string };
};

/** Event union 简化版 */
type EventLike = { type: string; properties?: unknown };

/** 三种要监听的事件名 */
const WATCHED_EVENT_TYPES = new Set([
  'permission.updated', // v1 事件
  'permission.asked', // v2 事件（v1 兼容）
  'permission.v2.asked', // v2 事件（v2 风格）
]);

/**
 * event hook 处理器
 * 收到 opencode event，识别 permission 事件并自动 reply
 */
export function createPermissionAutoReplyHandler(
  deps: PermissionAutoReplyDeps,
): (input: { event: EventLike }) => Promise<void> {
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

    if (!event || !WATCHED_EVENT_TYPES.has(event.type)) return;

    const state = getState();
    if (!state.activated) return;

    // 解析事件 props（v1 vs v2 两种 schema）
    const isV2Event = event.type === 'permission.asked' || event.type === 'permission.v2.asked';
    let toolName: string;
    let patterns: string[];
    let requestId: string;
    let alwaysList: string[] = [];

    if (isV2Event) {
      const props = event.properties as V2PermissionProps | undefined;
      if (!props || !props.id || !props.sessionID) {
        log.warn('perm-reply', 'v2 event missing id/sessionID', { type: event.type });
        return;
      }
      toolName = props.permission;
      patterns = props.patterns;
      requestId = props.id;
      alwaysList = props.always ?? [];
    } else {
      // v1 event
      const props = event.properties as V1PermissionProps | undefined;
      if (!props || !props.id) {
        log.warn('perm-reply', 'v1 event missing id', { type: event.type });
        return;
      }
      toolName = props.type;
      const pattern = props.pattern;
      patterns = Array.isArray(pattern) ? pattern : pattern ? [pattern] : [];
      requestId = props.id;
    }

    // v1.3-v4 决策（基于 /tmp/serenity-plugin.log 真实 payload）：
    // opencode 1.16+ 推送 `always: ["*"]` 时 = opencode 自己已知道 "始终放行" 列表匹配
    // → plugin 应**直接 reply "always"**，不需做 pattern check
    // 这是用户"装好 agent 就能放开权限"的最简实现：opencode 自己的 always 列表是单一真相源
    // 如果用户想要"cwdRoot 外不弹窗"——应该让 opencode 的 permission 配置接管（而不是 plugin 拦）
    log.info('perm-reply', 'replying always (v1.3-v4: trust opencode always list)', {
      eventType: event.type,
      tool: toolName,
      patterns,
      always: alwaysList,
      requestID: requestId,
    });

    // 用 v2 client reply "always"
    const client = getV2Client();
    if (!client) return;

    try {
      // v2 SDK 实际 API：client.permission.reply({requestID, reply}) — 无需 sessionID
      // （v2 Permission class 旧 `respond({sessionID, permissionID, response})` 已 deprecated）
      await client.permission.reply({
        requestID: requestId,
        reply: 'always',
      });
      log.info('perm-reply', 'auto-replied always', {
        eventType: event.type,
        tool: toolName,
        patterns,
        requestID: requestId,
      });
    } catch (err) {
      log.warn('perm-reply', 'reply failed; falling back to opencode ask', {
        eventType: event.type,
        requestID: requestId,
        err: String(err),
      });
    }
  };
}
