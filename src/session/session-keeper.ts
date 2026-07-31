/**
 * session-keeper.ts — Session persistence reminder mechanism
 *
 * Tracks READ/WRITE tool activity with weighted scoring.
 * When score reaches threshold, injects a reminder into the user message
 * requiring the model to ACK with a random 3-char code.
 * Reminder persists every round until ACK received.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// debug logs use console.error directly (log.ts is no-op in release)

// ── Types ──

interface KeeperState {
  score: number;
  threshold: number;
  pendingCode: string | null;
  pendingThreshold: number;
  lastAckType: "recorded" | "skipped" | null;
  lastAckCode: string | null;
  consecutiveAckFailure: number;
  lastResetAt: number;
  /** Last known effective score for incremental delta tracking */
  lastElapsedContribution: number;
}

type SessionId = string;

// ── Constants ──

const DEFAULT_THRESHOLD = 150;
const WRITE_WEIGHT = 3;
const READ_WEIGHT = 1;
const DELEGATE_WEIGHT = 10;

const READ_TOOLS = new Set([
  "read", "grep", "glob", "msm_list", "msm_admin", "msm_exec",
]);

const WRITE_TOOLS = new Set([
  "write", "edit",
]);

const DELEGATE_TOOLS = new Set([
  "task",
]);

// cc_fs subcommands: write operations
const WRITE_FS_SUBCOMMANDS = new Set([
  "mkdir", "rm", "mv", "cp", "touch", "append",
]);

// cc_git subcommands: write operations
const WRITE_GIT_SUBCOMMANDS = new Set(["commit", "push"]);

const ACK_PATTERN = /\[SESSION-KEEPER-(recorded|skipped)-([A-Za-z0-9]{3})\]/;

const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const REMINDER_TEXT =
  "\n\n" +
  "\u2501".repeat(80) + "\n" +
  "[Session-Keeper] Active session (S###).\n" +
  "\n" +
  "Recent activity suggests decisions or actions may have been made.\n" +
  "If so, update SESSION.md now.\n" +
  "\n" +
  "Then append to your response:\n" +
  "  [SESSION-KEEPER-recorded-{code}]\n" +
  "If nothing to record:\n" +
  "  [SESSION-KEEPER-skipped-{code}]\n" +
  "\n" +
  "You must use the exact code above. Do not reuse codes from previous rounds.\n" +
  "\u2501".repeat(80);

// ── State ──

const store = new Map<SessionId, KeeperState>();

/** Reset all state (test cleanup) */
export function resetKeeperStore(): void {
  store.clear();
}

function getOrCreate(id: SessionId, threshold: number, messages?: any[]): KeeperState {
  let s = store.get(id);
  if (!s) {
    if (messages) {
      // Rebuild state from message history (session restore path)
      const rebuilt = rebuildFromHistory(messages, threshold);
      if (rebuilt) {
        store.set(id, rebuilt);
        return rebuilt;
      }
    }
    s = { score: 0, threshold, pendingCode: null, pendingThreshold: 0, lastAckType: null, lastAckCode: null, consecutiveAckFailure: 0, lastResetAt: Date.now(), lastElapsedContribution: 0 };
    store.set(id, s);
  }
  return s;
}

/** Rebuild keeper state from message history (after session restore/reconnect).
 *  Fresh start: score=0, only find last reset point (session use/ACK) for state tracking.
 *  Incremental tool counting via addToolWeight takes over from here. */
function rebuildFromHistory(messages: any[], threshold: number): KeeperState | null {
  let lastAckType: "recorded" | "skipped" | null = null;
  let foundReset = false;

  for (const msg of messages) {
    if (!msg) continue;

    for (const part of msg.parts ?? []) {
      // session use tool call as reset point
      if (isToolCallPart(part)) {
        const name = toolNameFromPart(part);
        const input = toolInputFromPart(part);
        if (name === "session" && input.subcommand === "use") {
          foundReset = true;
          lastAckType = null;
        }
      }
      // session use result
      if (part.type === "toolResult") {
        const text: string = typeof part.output === "string" ? part.output : "";
        if (text.includes("[SESSION CONTEXT] Activated:")) {
          foundReset = true;
          lastAckType = null;
        }
      }
      // ACK in assistant text
      if (part.type === "text" && msg.info?.role === "assistant") {
        const text: string = part.text ?? "";
        const match = text.match(ACK_PATTERN);
        if (match) {
          foundReset = true;
          lastAckType = match[1] as "recorded" | "skipped";
        }
      }
    }
  }

  return {
    score: 0,
    threshold,
    pendingCode: null,
    pendingThreshold: 0,
    lastAckType,
    lastAckCode: null,
    consecutiveAckFailure: 0,
    lastResetAt: foundReset ? Date.now() : Date.now(),
    lastElapsedContribution: 0,
  };
}

// ── Config ──

export function readKeeperThreshold(cwdRoot: string): number {
  try {
    const configPath = join(cwdRoot, ".opencode", "serenity.json");
    if (!existsSync(configPath)) return DEFAULT_THRESHOLD;
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const t = parsed?.sessionKeeper?.threshold;
    return typeof t === "number" ? t : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}

// ── Helpers ──

function randomCode(): string {
  let code = "";
  for (let i = 0; i < 3; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function injectReminderMsg(text: string, code: string, sessionId: string): string {
  return text + REMINDER_TEXT.replace(/\{code\}/g, code).replace(/S###/, sessionId);
}

/** Extract tool name from a part: supports all known hook formats */
function toolNameFromPart(part: any): string {
  return (part as any).tool ?? (part as any).name ?? (part as any).function ?? "";
}

/** Check if a part is a tool call (not a result).
 *  SDK format: one part per tool call, state evolves pending→completed.
 *  In messages.transform, all prior tool parts are "completed" — count them all. */
function isToolCallPart(part: any): boolean {
  if (part.type === "toolUse" || part.type === "functionCall") return true;
  if (part.type === "toolResult" || part.type === "functionResponse") return false;
  if (part.type === "tool") return true;
  return false;
}

/** Extract tool input from a part */
function toolInputFromPart(part: any): Record<string, unknown> {
  return (part as any).input ?? (part as any).arguments ?? (part as any).args ?? {};
}

function findLastAssistantText(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.info?.role !== "assistant") continue;
    for (const part of msg.parts ?? []) {
      if (part.type === "text") {
        const t = part.text ?? "";
        if (t.trim()) return t;
      }
    }
    break;
  }
  return null;
}

/** Increment keeper score for a tool execution. Called from tool.execute.before hook. */
export function addToolWeight(sessionId: string, toolName: string, args: Record<string, unknown>): void {
  let state = store.get(sessionId);
  if (!state) {
    state = { score: 0, threshold: DEFAULT_THRESHOLD, pendingCode: null, pendingThreshold: 0, lastAckType: null, lastAckCode: null, consecutiveAckFailure: 0, lastResetAt: Date.now(), lastElapsedContribution: 0 };
    store.set(sessionId, state);
  }
  if (state.pendingCode) return;

  let weight = 0;
  if (DELEGATE_TOOLS.has(toolName)) {
    weight = DELEGATE_WEIGHT;
  } else if (WRITE_TOOLS.has(toolName)) {
    weight = WRITE_WEIGHT;
  } else if (toolName === "cc_fs") {
    const sub = String(args.subcommand ?? "");
    weight = WRITE_FS_SUBCOMMANDS.has(sub) ? WRITE_WEIGHT : READ_WEIGHT;
  } else if (toolName === "cc_git") {
    const sub = String(args.subcommand ?? "");
    weight = WRITE_GIT_SUBCOMMANDS.has(sub) ? WRITE_WEIGHT : READ_WEIGHT;
  } else if (READ_TOOLS.has(toolName)) {
    weight = READ_WEIGHT;
  }

  if (weight > 0) {
  state.score += weight;
  console.error('[keeper] +weight', JSON.stringify({ tool: toolName, weight, score: state.score }));
  }
}

/** Check if score reached threshold and return reminder text for tool output injection.
 *  Called from tool.execute.after hook for immediate feedback (DCP pattern). */
export function triggerOnToolResult(sessionId: string, toolOutput: string, sessionDirName: string): string | null {
  const state = store.get(sessionId);
  if (!state || state.pendingCode) {
    console.error('[keeper] trigger skipped', JSON.stringify({ reason: !state ? 'no-state' : 'pending' }));
    return null;
  }
  if (state.score < state.threshold) {
    console.error('[keeper] trigger below threshold', JSON.stringify({ score: state.score, threshold: state.threshold }));
    return null;
  }

  const code = randomCode();
  state.pendingCode = code;
  state.pendingThreshold = state.threshold;
  console.error('[keeper] trigger', JSON.stringify({ code, score: state.score, threshold: state.threshold }));

  const reminder = injectReminderMsg("", code, sessionDirName).trimStart();
  return toolOutput + "\n\n" + reminder;
}

function detectAck(assistantText: string | null, expectedCode: string): "recorded" | "skipped" | "invalid" | null {
  if (!assistantText) return null;
  const match = assistantText.match(ACK_PATTERN);
  if (!match) return null;
  if (match[2] !== expectedCode) return "invalid";
  return match[1] as "recorded" | "skipped";
}

// ── Main entry: called from messages.transform hook ──

export interface KeeperResult {
  reminder: string | null;
  code: string | null;
}

export function processSessionKeeper(
  ocSessionId: string,
  messages: any[],
  cwdRoot: string,
  sessionDirName: string,
): KeeperResult {
  const threshold = readKeeperThreshold(cwdRoot);
  const state = getOrCreate(ocSessionId, threshold, messages);
  state.threshold = threshold;

  console.error('[keeper] process', JSON.stringify({
    ocSessionId,
    score: state.score,
    threshold,
    pendingCode: state.pendingCode,
  }));

  // Step 1: check for ACK in last assistant response
  if (state.pendingCode) {
    const lastText = findLastAssistantText(messages);
    const ack = detectAck(lastText, state.pendingCode);
    if (ack === "recorded" || ack === "skipped") {
      state.score = 0;
      state.pendingCode = null;
      state.lastResetAt = Date.now();
      state.lastElapsedContribution = 0;
      state.lastAckType = ack;
      state.lastAckCode = null;
      state.consecutiveAckFailure = 0;
    } else if (ack === "invalid") {
      state.consecutiveAckFailure++;
    } else {
      state.consecutiveAckFailure++;
    }
  }

  // Step 2: add elapsed time since last reset (incremental delta)
  if (!state.pendingCode) {
    const elapsedSinceReset = Math.floor((Date.now() - state.lastResetAt) / 60000);
    const delta = elapsedSinceReset - state.lastElapsedContribution;
    if (delta > 0) {
      state.score += delta;
      state.lastElapsedContribution = elapsedSinceReset;
      console.error('[keeper] +time', JSON.stringify({ delta, score: state.score }));
    }
  }

  // Step 3: inject reminder if needed
  if (state.pendingCode) {
    const reminder = injectReminderMsg("", state.pendingCode, sessionDirName).trimStart();
    return { reminder, code: state.pendingCode };
  }

  if (state.score >= state.threshold) {
    const code = randomCode();
    state.pendingCode = code;
    state.pendingThreshold = state.threshold;
    const reminder = injectReminderMsg("", code, sessionDirName).trimStart();
    console.error('[keeper] trigger', JSON.stringify({ code, score: state.score, threshold: state.threshold }));
    return { reminder, code };
  }

  return { reminder: null, code: null };
}

/** Reset keeper score for next LLM round. Called once per messages.transform cycle. */
export function resetForNextRound(sessionId: string): void {
  const state = store.get(sessionId);
  if (state && !state.pendingCode) {
    state.score = 0;
    state.lastResetAt = Date.now();
    state.lastElapsedContribution = 0;
  }
}
