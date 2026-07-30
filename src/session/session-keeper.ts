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

const READ_TOOLS = new Set([
  "read", "grep", "glob", "msm_list", "msm_admin", "msm_exec",
]);

const WRITE_TOOLS = new Set([
  "write", "edit",
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

function getOrCreate(id: SessionId, threshold: number): KeeperState {
  let s = store.get(id);
  if (!s) {
    s = { score: 0, threshold, pendingCode: null, pendingThreshold: 0, lastAckType: null, lastAckCode: null, consecutiveAckFailure: 0, lastResetAt: Date.now() };
    store.set(id, s);
  }
  return s;
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

function countToolWeights(messages: any[], writeWeight: number, readWeight: number): number {
  let score = 0;
  for (const msg of messages) {
    if (!msg) continue;
    for (const part of msg.parts ?? []) {
      if (part.type !== "toolUse") continue;
      const name: string = part.name ?? "";
      const input: Record<string, unknown> = part.input ?? {};

      if (WRITE_TOOLS.has(name)) {
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
  const state = getOrCreate(ocSessionId, threshold);
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
    const toolScore = countToolWeights(messages, WRITE_WEIGHT, READ_WEIGHT);
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
