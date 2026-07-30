/**
 * active-state.ts — 每个 OpenCode 会话的活跃会话状态（in-memory only）
 *
 * 以 OpenCode sessionID 为 key，不落盘，避免多 agent 共享冲突。
 * 通过 session.compacting hook 注入压缩摘要，确保持续性。
 */

export interface ActiveSession {
  sessionId: string;
  dirName: string;
  mdPath: string;
}

const store = new Map<string, ActiveSession>();

// 全局最近活跃 session（不依赖 OpenCode sessionID，供 tool.definition 等无 sessionID 的 hook 使用）
let lastActive: ActiveSession | null = null;

// messages.transform hook 没有 sessionID 参数，从其他 hook 捕获
let capturedOcSessionId: string | null = null;

export function captureOcSessionId(id: string): void {
  capturedOcSessionId = id;
}

export function getCapturedOcSessionId(): string | null {
  return capturedOcSessionId;
}

export function setActiveSession(ocSessionId: string, info: ActiveSession): void {
  store.set(ocSessionId, info);
  lastActive = info;
}

export function getActiveSession(ocSessionId: string): ActiveSession | undefined {
  return store.get(ocSessionId);
}

/** 获取最近一次活跃的 session（不依赖 OpenCode sessionID） */
export function getLastActiveSession(): ActiveSession | null {
  return lastActive;
}

export function removeActiveSession(ocSessionId: string): void {
  store.delete(ocSessionId);
  if (lastActive && !store.has(ocSessionId)) {
    lastActive = null;
  }
}
