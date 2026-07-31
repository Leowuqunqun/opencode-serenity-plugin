/**
 * safe-mode.ts — Safe mode state management + write blacklist
 *
 * Safe mode combines two protections:
 *   1. bash disabled
 *   2. write/edit blacklist active (path-based, prefix or regex)
 *
 * Controlled by TUI slash command /serenity-safe-mode on|off|status.
 * Persisted via CCC-root marker file `.serenity-safe-on`.
 * Backward compatible: `.serenity-bash-off` treated as safe mode ON.
 *
 * Blacklist configured in `.opencode/serenity.json`:
 *   { "safeMode": { "blacklist": ["/etc/", "regex:^/var/log/"] } }
 *
 * Patterns:
 *   - Plain string: prefix match (path starts with)
 *   - "regex:" prefix: regex match
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { log } from "./util/log.js";

const STATE_FILE = join(tmpdir(), "serenity-safe-mode");
const ON_MARKER = ".serenity-safe-on";
const BASH_OFF_MARKER = ".serenity-bash-off";

function getMarkerFile(cwdRoot?: string): string | null {
  return cwdRoot ? resolve(join(cwdRoot, ON_MARKER)) : null;
}

function getBashOffMarkerFile(cwdRoot?: string): string | null {
  return cwdRoot ? resolve(join(cwdRoot, BASH_OFF_MARKER)) : null;
}

function isServerMode(): boolean {
  return process.argv.some((a) => a === "web" || a === "serve");
}

/**
 * Is safe mode ON?
 * When ON: bash disabled + write blacklist active
 */
export function isSafeModeOn(cwdRoot?: string): boolean {
  // 1. env var override
  const env = process.env.SERENITY_SAFE_MODE;
  if (env === "true") return true;
  if (env === "false") return false;

  // 2. CCC-root .serenity-safe-on marker
  const marker = getMarkerFile(cwdRoot);
  if (marker && existsSync(marker)) return true;

  // 3. Backward compat: .serenity-bash-off → safe mode ON
  const oldMarker = getBashOffMarkerFile(cwdRoot);
  if (oldMarker && existsSync(oldMarker)) return true;

  // 4. /tmp runtime state
  try {
    if (existsSync(STATE_FILE)) {
      return readFileSync(STATE_FILE, "utf-8").trim() === "true";
    }
  } catch { /* ignore */ }

  // 5. Server mode: default ON
  if (isServerMode()) return true;

  // 6. Default: OFF (TUI)
  return false;
}

/**
 * Set safe mode ON (true) or OFF (false).
 * Writes/removes CCC-root marker and /tmp state.
 */
export function setSafeMode(v: boolean, cwdRoot?: string): void {
  try {
    writeFileSync(STATE_FILE, v ? "true" : "false", "utf-8");
  } catch (err) {
    log.warn("safe-mode", "failed to write /tmp state", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const marker = getMarkerFile(cwdRoot);
  if (marker) {
    try {
      if (v) {
        writeFileSync(marker, "", "utf-8");
        log.info("safe-mode", `created ${ON_MARKER}`);
      } else {
        if (existsSync(marker)) {
          rmSync(marker, { force: true });
          log.info("safe-mode", `removed ${ON_MARKER}`);
        }
      }
    } catch (err) {
      log.warn("safe-mode", "failed to update CCC-root marker", {
        marker,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Blacklist ──

export interface BlacklistEntry {
  type: "prefix" | "regex";
  pattern: string;
  /** 自定义拦截提示（可选）；未设置时使用默认提示 */
  message?: string;
}

export function readBlacklist(cwdRoot: string): BlacklistEntry[] {
  try {
    const configPath = join(cwdRoot, ".opencode", "serenity.json");
    if (!existsSync(configPath)) return [];
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const patterns: unknown[] = parsed?.safeMode?.blacklist;
    if (!Array.isArray(patterns) || patterns.length === 0) return [];
    return patterns.map((item): BlacklistEntry | null => {
      // 支持两种形式：
      //   string："/etc/" 或 "regex:..."
      //   object：{ "pattern": "/etc/", "message": "自定义提示" }
      let raw: string;
      let message: string | undefined;
      if (typeof item === "string") {
        raw = item;
      } else if (item && typeof item === "object" && typeof (item as { pattern?: unknown }).pattern === "string") {
        raw = (item as { pattern: string }).pattern;
        const m = (item as { message?: unknown }).message;
        message = typeof m === "string" ? m : undefined;
      } else {
        return null;
      }
      if (raw.startsWith("regex:")) {
        const rest = raw.slice(6);
        if (!rest) return null;
        return { type: "regex" as const, pattern: rest, message };
      }
      return { type: "prefix" as const, pattern: raw, message };
    }).filter((e): e is BlacklistEntry => e !== null);
  } catch {
    return [];
  }
}

/** 匹配命中黑名单的条目（返回 null 表示未命中） */
export function matchBlacklistEntry(targetPath: string, entries: BlacklistEntry[]): BlacklistEntry | null {
  for (const entry of entries) {
    if (entry.type === "prefix") {
      if (targetPath.startsWith(entry.pattern)) return entry;
    } else if (entry.type === "regex") {
      try {
        const re = new RegExp(entry.pattern);
        if (re.test(targetPath)) return entry;
      } catch { /* invalid regex → skip */ }
    }
  }
  return null;
}

/**
 * Check if a path matches any blacklist entry.
 * Only called when safe mode is ON.
 */
export function isPathBlacklisted(targetPath: string, entries: BlacklistEntry[]): boolean {
  return matchBlacklistEntry(targetPath, entries) !== null;
}
