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

// ── Types ──

interface KeeperState {
  score: number;
  threshold: number;
  pendingCode: string | null;
  pendingThreshold: number;
  lastAckType: "recorded" | "skipped" | null;
  lastAckCode: string | null;
  consecutiveAckFailure: number;
  lastResetAt: number;  // timestamp of last ACK or state creation (for time scoring)
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

// cc_fs subcommands: read-only vs write
const READ_FS_SUBCOMMANDS = new Set([
  "root", "resolve", "exists", "list", "relative", "tree", "info", "find",
]);

const WRITE_FS_SUBCOMMANDS = new Set([
  "mkdir", "rm", "mv", "cp", "touch", "append",
]);

// cc_git subcommands: read vs write
const READ_GIT_SUBCOMMANDS = new Set(["status", "log", "diff"]);
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
    s = { score: 0, threshold, pendingCode: null, pendingThreshold: 0, lastAckType: null, lastAckCode: null, consecutiveAckFailure: 0, lastResetAt: Date.now() };
    store.set(id, s);
  }
  return s;
}

/** Rebuild keeper state from message history (after session restore/reconnect).
 *  Finds the most recent `session use` or ACK marker as reset point,
 *  then accumulates tool weights after it for estimated score. */
function rebuildFromHistory(messages: any[], threshold: number): KeeperState | null {
  let score = 0;
  let foundReset = false;
  let lastAckType: "recorded" | "skipped" | null = null;

  for (const msg of messages) {
    if (!msg) continue;

      // 1. Accumulate tool weights (only after the first reset)
    if (foundReset) {
      for (const part of msg.parts ?? []) {
        if (!isToolCallPart(part)) continue;
        const name = toolNameFromPart(part);
        const input = toolInputFromPart(part);

        if (DELEGATE_TOOLS.has(name)) {
          score += DELEGATE_WEIGHT;
        } else if (WRITE_TOOLS.has(name)) {
          score += WRITE_WEIGHT;
        } else if (name === "cc_fs") {
          const sub = String(input.subcommand ?? "");
          if (WRITE_FS_SUBCOMMANDS.has(sub)) score += WRITE_WEIGHT;
          else if (READ_FS_SUBCOMMANDS.has(sub)) score += READ_WEIGHT;
        } else if (name === "cc_git") {
          const sub = String(input.subcommand ?? "");
          if (WRITE_GIT_SUBCOMMANDS.has(sub)) score += WRITE_WEIGHT;
          else if (READ_GIT_SUBCOMMANDS.has(sub)) score += READ_WEIGHT;
        } else if (READ_TOOLS.has(name)) {
          score += READ_WEIGHT;
        }
      }
    }

    // 2. Check for reset in this message
    for (const part of msg.parts ?? []) {
      // session use tool call (supports both "toolUse" and SDK "tool" format)
      if (isToolCallPart(part)) {
        const name = toolNameFromPart(part);
        const input = toolInputFromPart(part);
        if (name === "session" && input.subcommand === "use") {
          foundReset = true;
          lastAckType = null;
          score = 0;
        }
      }
      // session use result
      if (part.type === "toolResult") {
        const text: string = typeof part.output === "string" ? part.output : "";
        if (text.includes("[SESSION CONTEXT] Activated:")) {
          foundReset = true;
          lastAckType = null;
          score = 0;
        }
      }
      // ACK in assistant text
      if (part.type === "text" && msg.info?.role === "assistant") {
        const text: string = part.text ?? "";
        const match = text.match(ACK_PATTERN);
        if (match) {
          foundReset = true;
          lastAckType = match[1] as "recorded" | "skipped";
          score = 0;
        }
      }
    }
  }

  if (!foundReset) {
    return {
      score: 0, threshold, pendingCode: null, pendingThreshold: 0,
      lastAckType: null, lastAckCode: null, consecutiveAckFailure: 0,
      lastResetAt: Date.now(),
    };
  }

  return {
    score: Math.min(score, threshold - 1),
    threshold, pendingCode: null, pendingThreshold: 0,
    lastAckType, lastAckCode: null, consecutiveAckFailure: 0,
    lastResetAt: Date.now(),
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

/** Extract tool name from a part (supports both "toolUse"/"toolResult" and SDK "tool" format) */
function toolNameFromPart(part: any): string {
  return (part as any).tool ?? (part as any).name ?? "";
}

/** Check if a part is a tool call (not a result) */
function isToolCallPart(part: any): boolean {
  if (part.type === "toolUse") return true;
  if (part.type === "tool") {
    const state = (part as any).state;
    // SDK format: tool with state that is a call/running (not completed/error)
    if (state && typeof state === "object" && (state.type === "call" || state.type === "running")) return true;
    // Fallback: if no state or unknown, treat as call
    if (!state) return true;
  }
  return false;
}

/** Extract tool input from a part */
function toolInputFromPart(part: any): Record<string, unknown> {
  return (part as any).input ?? (part as any).arguments ?? {};
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

function countToolWeights(messages: any[], writeWeight: number, readWeight: number, delegateWeight: number): number {
  let score = 0;
  for (const msg of messages) {
    if (!msg) continue;
    for (const part of msg.parts ?? []) {
      if (!isToolCallPart(part)) continue;
      const name = toolNameFromPart(part);
      const input = toolInputFromPart(part);

      if (DELEGATE_TOOLS.has(name)) {
        score += delegateWeight;
      } else if (WRITE_TOOLS.has(name)) {
        score += writeWeight;
      } else if (name === "cc_fs") {
        const sub = String(input.subcommand ?? "");
        if (WRITE_FS_SUBCOMMANDS.has(sub)) score += writeWeight;
        else if (READ_FS_SUBCOMMANDS.has(sub)) score += readWeight;
      } else if (name === "cc_git") {
        const sub = String(input.subcommand ?? "");
        if (WRITE_GIT_SUBCOMMANDS.has(sub)) score += writeWeight;
        else if (READ_GIT_SUBCOMMANDS.has(sub)) score += readWeight;
      } else if (READ_TOOLS.has(name)) {
        score += readWeight;
      }
    }
  }
  return score;
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
  // Pass messages for state rebuilding on session restore (no existing state in store)
  const state = getOrCreate(ocSessionId, threshold, messages);
  state.threshold = threshold;

  // Step 1: check for ACK in last assistant response
  if (state.pendingCode) {
    const lastText = findLastAssistantText(messages);
    const ack = detectAck(lastText, state.pendingCode);
    if (ack === "recorded" || ack === "skipped") {
      state.score = 0;
      state.pendingCode = null;
      state.lastResetAt = Date.now();
      state.lastAckType = ack;
      state.lastAckCode = null;
      state.consecutiveAckFailure = 0;
    } else if (ack === "invalid") {
      state.consecutiveAckFailure++;
    } else {
      state.consecutiveAckFailure++;
    }
  }

  // Step 2: accumulate score from tool uses + time since last reset
  if (!state.pendingCode) {
    const toolScore = countToolWeights(messages, WRITE_WEIGHT, READ_WEIGHT, DELEGATE_WEIGHT);
    const elapsedMinutes = Math.floor((Date.now() - state.lastResetAt) / 60000);
    const totalScore = toolScore + elapsedMinutes;
    state.score = Math.max(totalScore, state.score);
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
    return { reminder, code };
  }

  return { reminder: null, code: null };
}
