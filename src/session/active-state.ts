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

export function setActiveSession(ocSessionId: string, info: ActiveSession): void {
  store.set(ocSessionId, info);
}

export function getActiveSession(ocSessionId: string): ActiveSession | undefined {
  return store.get(ocSessionId);
}

export function removeActiveSession(ocSessionId: string): void {
  store.delete(ocSessionId);
}
