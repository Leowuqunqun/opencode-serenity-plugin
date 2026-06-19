#!/usr/bin/env npx tsx
/**
 * session-tool.ts — 会话索引重建工具（ACC session 补充）
 *
 * 本文件是完整 session-tool.ts 的 reindex-only 精简版。
 * 仅保留 reindex 子命令及其依赖的扫描/分析基础设施。
 *
 * 类别：Mech（纯机械）
 *
 * 用法：
 *   npx tsx session-tool.ts reindex [--dry-run]
 *
 * 退出码（参见 msm-writing-standards.md §5.3 命名空间）：
 *   0 — 成功
 *   1 — user（缺必填参数 / 未知子命令 / 拒绝协议 flag）
 *   2 — system（CCC_ROOT_NOT_FOUND / AGENT_SESSIONS 目录缺失 / 文件读 / 文件写 / rename 失败）
 *   3 — operator（暂未使用）
 *   4 — internal（兜底，INTERNAL_UNHANDLED_STATE）
 *
 * 输出：
 *   - 成功：stdout 纯文本（业务数据 + 软状态消息）
 *   - 失败：stderr 6 字段 schema（参见 msm-writing-standards.md §5.5）
 *
 * 错误码（参见 msm-writing-standards.md §8 字典）：
 *   - CCC_ROOT_NOT_FOUND        system  无法定位 CCC root
 *   - PARAMETER_MISSING          user    缺必填参数
 *   - PARAMETER_INVALID_VALUE    user    未知子命令 / 拒绝协议 flag
 *   - SESSION_DIR_MISSING        system  AGENT_SESSIONS 目录不存在
 *   - SESSION_FILE_READ_FAILED   system  SESSION.md 读取失败
 *   - SESSION_FILE_WRITE_FAILED  system  SESSION.md 写入失败
 *   - SESSION_RENAME_FAILED      system  reindex 重命名失败
 *   - INTERNAL_UNHANDLED_STATE   internal 兜底（未预期异常）
 *
 * 软状态消息（stdout，**非错误**）：
 *   - reindex: "所有会话已有 ID，无需 reindex" — 软消息，exit 0
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync,
  appendFileSync, readdirSync, statSync,
} from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── 错误类（参见 msm-writing-standards.md §5.13 v0.2.1 模板）──

type Category = "user" | "system" | "operator" | "internal";

class MsmError extends Error {
  constructor(
    public code: string,
    public category: Category,
    public message: string,
    public context: Record<string, unknown> = {},
    public remediation?: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "MsmError";
  }
  toStderr(): string {
    const lines: string[] = [
      `[${this.code}]`,
      `  code: ${this.code}`,
      `  category: ${this.category}`,
      `  message: ${this.message}`,
      `  cause: ${this.cause !== undefined && this.cause !== ""
        ? (this.cause instanceof Error ? this.cause.message : String(this.cause))
        : "(no underlying cause)"}`,
    ];
    if (this.remediation) lines.push(`  remediation: ${this.remediation}`);
    if (Object.keys(this.context).length > 0) {
      lines.push(`  context: ${JSON.stringify(this.context)}`);
    }
    return lines.join("\n");
  }
  exitCode(): number {
    return { user: 1, system: 2, operator: 3, internal: 4 }[this.category];
  }
}

function emitError(err: MsmError): void {
  process.stderr.write(err.toStderr() + "\n");
}

// ── 业务协议 flag 拒绝（v0.2 §10.4）──

function rejectProtocolFlags(args: string[]): void {
  const forbidden = new Set([
    "--json",
    "--format", "--format=json", "--format=text",
    "--log",
    "--help",
    "-h",
    "-j", "-f", "-l",
    "--all",
    "--session",
  ]);
  for (const arg of args) {
    if (forbidden.has(arg) || arg.startsWith("--format=")) {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `业务 msm 不接受 flag: ${arg}`,
        {
          arg,
          validSubcommands: ["reindex"],
        },
        "v0.2: --json/--format/--log/--help/-h 由 msm_exec 拦截",
      );
    }
    if (arg.length >= 2 && arg.startsWith("-") && !arg.startsWith("--")) {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `业务 msm 不接受缩写 flag: ${arg}`,
        {
          arg,
          validSubcommands: ["reindex"],
        },
        "v0.2 §10.4: 业务 flag 必须 --全名（禁止 -d / -h / -j 等缩写）",
      );
    }
  }
}

// ── 路径解析 ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findCccRoot(): string {
  let dir = resolve(process.cwd());
  const maxDepth = 20;
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(dir, ".serenity"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new MsmError(
    "CCC_ROOT_NOT_FOUND",
    "system",
    "无法定位 CCC 根目录（未检测到 .serenity 标记文件）",
    { startDir: process.cwd() },
    "在 CCC 工作目录下执行；或检查 .serenity 文件是否存在",
  );
}

// ── Constants ──

const SESSIONS_DIR = "AGENT_SESSIONS";
const THRESHOLDS = {
  stale_days: 7,
  stalled_completion: 0.3,
  drift_unresolved: 3,
  ghost_age_days: 2,
};
const ARCHIVE_WAIT_DAYS = 30;
const ARCHIVE_AUTO_WAIT_DAYS = 60;

// ── Utility functions ──

function sessionsRoot(cccRoot: string): string {
  return join(cccRoot, SESSIONS_DIR);
}

function parseLocalDate(dateStr: string): Date {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return new Date(dateStr);
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}

function daysBetween(a: Date, b: Date): number {
  const aLocal = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bLocal = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bLocal.getTime() - aLocal.getTime()) / (1000 * 60 * 60 * 24));
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayDate(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isExcluded(name: string): boolean {
  return name.startsWith("_") || name === ".gitkeep";
}

function extractSessionId(dirName: string): string {
  const match = dirName.match(/--(S\d{3})--/);
  return match ? match[1] : "";
}

function parseSessionDate(dirName: string): Date | null {
  const match = dirName.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Session data types ──

interface SessionBasic {
  id: string;
  name: string;
  path: string;
  dirName: string;
  createdAt: Date;
  ageDays: number;
  hasSessionMd: boolean;
  title: string;
  status: SessionStatus;
  closeDate: Date | null;
}

interface ParsedSession extends SessionBasic {
  lastActivityDate: Date | null;
  completionRate: number;
  unresolvedCount: number;
  artifactCount: number;
  goals: string[];
  decisions: string[];
  outputs: string[];
}

type SessionStatus = "completed" | "in-progress" | "closed" | "paused" | "migrated" | "empty" | "unknown";

const STATUS_LABEL: Record<SessionStatus, string> = {
  "completed": "已完成",
  "in-progress": "进行中",
  "closed": "已关闭",
  "paused": "暂停",
  "migrated": "已迁移",
  "empty": "空壳",
  "unknown": "未知",
};

const STATUS_ICON: Record<SessionStatus, string> = {
  "completed": "✅",
  "in-progress": "🔄",
  "closed": "📕",
  "paused": "⏸️",
  "migrated": "📦",
  "empty": "⚠️",
  "unknown": "❓",
};

// ── Session scanning ──

function countArtifacts(sessionPath: string): number {
  let entries: string[];
  try {
    entries = readdirSync(sessionPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[session-tool] warning: 读取会话目录失败 ${sessionPath}: ${msg}（计为 0 产出物）\n`);
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry === "SESSION.md" || entry.startsWith(".")) continue;
    const fullPath = join(sessionPath, entry);
    try {
      const s = statSync(fullPath);
      if (s.isFile() || s.isDirectory()) count++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[session-tool] warning: stat 失败 ${fullPath}: ${msg}（跳过此 entry）\n`);
    }
  }
  return count;
}

function detectStatus(content: string): { status: SessionStatus; closeDate: Date | null } {
  if (content.includes("已迁移") || content.includes("— 已关闭")) {
    return { status: "migrated", closeDate: null };
  }

  const closeMatch = content.match(/- 关闭时间:\s*(\d{4}-\d{2}-\d{2})/);
  if (closeMatch) {
    return { status: "closed", closeDate: parseLocalDate(closeMatch[1]) };
  }

  if (content.includes("进行中")) {
    if (content.includes("暂停")) {
      return { status: "paused", closeDate: null };
    }
    return { status: "in-progress", closeDate: null };
  }

  const statusSection = content.match(/## 状态\n([\s\S]*?)(?=\n## )/);
  if (statusSection) {
    const section = statusSection[1];
    const lines = section.split("\n");
    let hasUnchecked = false;
    let hasChecked = false;
    let allMigratedOrClosed = true;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- [x]") || trimmed.startsWith("- [X]")) {
        hasChecked = true;
        if (!trimmed.includes("已迁移") && !trimmed.includes("已关闭")) {
          allMigratedOrClosed = false;
        }
      } else if (trimmed.startsWith("- [ ]") || trimmed.startsWith("- [>]")) {
        hasUnchecked = true;
        allMigratedOrClosed = false;
      }
    }

    if (allMigratedOrClosed && hasChecked) {
      return { status: "migrated", closeDate: null };
    }
    if (!hasUnchecked && hasChecked) {
      return { status: "completed", closeDate: null };
    }
    if (hasUnchecked) {
      return { status: "in-progress", closeDate: null };
    }
  }

  if (content.includes("- [x] 已完成") || content.includes("- [x] 调研完成")) {
    return { status: "completed", closeDate: null };
  }

  return { status: "unknown", closeDate: null };
}

function extractTitle(content: string): string {
  let titleMatch = content.match(/^#\s+(?:会话[：:]\s*)?(?:SESSION[：:]\s*)?(.+)$/m);
  if (titleMatch) return titleMatch[1].trim();
  titleMatch = content.match(/^SESSION[：:]\s*(.+)$/m);
  if (titleMatch) return titleMatch[1].trim();
  titleMatch = content.match(/^会话[：:]\s*(.+)$/m);
  if (titleMatch) return titleMatch[1].trim();
  return "(未命名)";
}

function extractGoals(content: string): string[] {
  const goalSection = content.match(/## 目标\n([\s\S]*?)(?=\n## )/);
  if (!goalSection) return [];
  return goalSection[1].split("\n")
    .map(l => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);
}

function extractLastActivity(content: string): Date | null {
  const dateRegex = /^###\s+(\d{4}-\d{2}-\d{2})/m;
  let lastDate: Date | null = null;
  for (const line of content.split("\n")) {
    const m = line.match(dateRegex);
    if (m) {
      const d = parseLocalDate(m[1]);
      if (!lastDate || d > lastDate) lastDate = d;
    }
  }
  return lastDate;
}

function computeCompletionRate(content: string): number {
  let total = 0, completed = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- [x]") || trimmed.startsWith("- [X]")) { completed++; total++; }
    else if (trimmed.startsWith("- [>]")) { total++; }
    else if (trimmed.startsWith("- [ ]")) { total++; }
  }
  return total > 0 ? completed / total : 0;
}

function countUnresolved(content: string): number {
  const lines = content.split("\n");
  let inUnresolved = false;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("未解决的问题") || line.includes("## 下一步")) {
      inUnresolved = true;
      continue;
    }
    if (inUnresolved) {
      if (line.startsWith("## ") && !line.includes("未解决") && !line.includes("下一步")) {
        inUnresolved = false;
        continue;
      }
      const trimmed = line.trim();
      if ((trimmed.startsWith("- ") || trimmed.startsWith("* ")) && !trimmed.includes("@") && !/\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        count++;
      }
    }
  }
  return count;
}

function scanAllSessions(cccRoot: string): ParsedSession[] {
  const sRoot = sessionsRoot(cccRoot);
  if (!existsSync(sRoot)) return [];

  const entries = readdirSync(sRoot, { withFileTypes: true });
  const sessions: ParsedSession[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || isExcluded(entry.name)) continue;

    const sessionPath = join(sRoot, entry.name);
    const sessionMdPath = join(sessionPath, "SESSION.md");
    const hasSessionMd = existsSync(sessionMdPath);

    let createdAt: Date;
    try {
      createdAt = parseSessionDate(entry.name) || statSync(sessionPath).birthtime;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MsmError(
        "SESSION_FILE_READ_FAILED",
        "system",
        `无法获取会话创建时间: ${entry.name}`,
        { dirName: entry.name, sessionPath },
        "检查目录权限或文件系统状态",
        err,
      );
    }
    const ageDays = daysBetween(createdAt, new Date());

    let title = entry.name;
    let status: SessionStatus = hasSessionMd ? "unknown" : "empty";
    let closeDate: Date | null = null;
    let lastActivityDate: Date | null = null;
    let completionRate = 0;
    let unresolvedCount = 0;
    let goals: string[] = [];
    let decisions: string[] = [];
    let outputs: string[] = [];

    if (hasSessionMd) {
      let content: string;
      try {
        content = readFileSync(sessionMdPath, "utf-8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new MsmError(
          "SESSION_FILE_READ_FAILED",
          "system",
          `读取 SESSION.md 失败: ${entry.name}`,
          { dirName: entry.name, sessionMdPath },
          "检查文件权限或磁盘状态",
          err,
        );
      }
      const detected = detectStatus(content);
      status = detected.status;
      closeDate = detected.closeDate;
      title = extractTitle(content);
      goals = extractGoals(content);
      lastActivityDate = extractLastActivity(content);
      completionRate = computeCompletionRate(content);
      unresolvedCount = countUnresolved(content);
    }

    const artifactCount = countArtifacts(sessionPath);

    sessions.push({
      id: extractSessionId(entry.name),
      name: entry.name,
      path: sessionPath,
      dirName: entry.name,
      createdAt,
      ageDays,
      hasSessionMd,
      title,
      status,
      closeDate,
      lastActivityDate,
      completionRate,
      unresolvedCount,
      artifactCount,
      goals,
      decisions,
      outputs,
    });
  }

  return sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// ── Output helpers ──

function separator(char = "─", len = 60): string {
  return char.repeat(len);
}

// ===================================================================
// Subcommand: reindex
// ===================================================================

interface ReindexResult {
  oldName: string;
  newName: string;
  sessionId: string;
  action: "rename" | "skip";
}

function cmdReindex(cccRoot: string, subArgs: string[]): void {
  const dryRun = subArgs.includes("--dry-run");
  const sRoot = sessionsRoot(cccRoot);
  if (!existsSync(sRoot)) {
    throw new MsmError(
      "SESSION_DIR_MISSING",
      "system",
      `AGENT_SESSIONS 目录不存在: ${sRoot}`,
      { sRoot },
      "先创建 AGENT_SESSIONS 目录或检查 CCC root 解析",
    );
  }

  const all = scanAllSessions(cccRoot).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );

  const legacy = all.filter(s => !s.id);
  if (legacy.length === 0) {
    console.log("[session-tool] 所有会话已有 ID，无需 reindex");
    return;
  }

  let maxNum = 0;
  for (const s of all) {
    const match = s.id.match(/S(\d+)/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
  }

  console.log(`\n  Reindex: ${legacy.length} 个会话需要编号\n`);

  const results: ReindexResult[] = [];

  for (let i = 0; i < legacy.length; i++) {
    const s = legacy[i];
    const num = maxNum + 1 + i;
    const sessionId = `S${String(num).padStart(3, "0")}`;

    const dateMatch = s.dirName.match(/^(\d{4}-\d{2}-\d{2}--)/);
    if (!dateMatch) {
      console.log(`  ⚠️  跳过 ${s.dirName}: 无法解析日期前缀`);
      results.push({ oldName: s.dirName, newName: s.dirName, sessionId, action: "skip" });
      continue;
    }
    const newDirName = `${dateMatch[1]}${sessionId}--${s.dirName.slice(dateMatch[1].length)}`;
    const oldPath = join(sRoot, s.dirName);
    const newPath = join(sRoot, newDirName);

    if (dryRun) {
      console.log(`  ${s.dirName}`);
      console.log(`    → ${newDirName}  (ID: ${sessionId})`);
      results.push({ oldName: s.dirName, newName: newDirName, sessionId, action: "rename" });
      continue;
    }

    try {
      renameSync(oldPath, newPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MsmError(
        "SESSION_RENAME_FAILED",
        "system",
        `重命名失败: ${s.dirName}`,
        { oldName: s.dirName, newName: newDirName, originalError: msg },
        "检查目录权限或目标是否已存在",
        err,
      );
    }

    const sessionMdPath = join(newPath, "SESSION.md");
    if (existsSync(sessionMdPath)) {
      try {
        let mdContent = readFileSync(sessionMdPath, "utf-8");
        const titleMatch = mdContent.match(/^(# .+)$/m);
        if (titleMatch) {
          const titleLine = titleMatch[1];
          mdContent = mdContent.replace(titleLine, `${titleLine}\n- ID: ${sessionId}`);
          writeFileSync(sessionMdPath, mdContent, "utf-8");
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new MsmError(
          "SESSION_FILE_WRITE_FAILED",
          "system",
          `更新 SESSION.md 失败: ${newDirName}`,
          { sessionMdPath, originalError: msg },
          "检查文件权限或磁盘空间",
          err,
        );
      }
    }

    console.log(`  ✅ ${s.dirName}`);
    console.log(`     → ${newDirName}  (ID: ${sessionId})`);
    results.push({ oldName: s.dirName, newName: newDirName, sessionId, action: "rename" });
  }

  console.log(`\n  Reindex 完成: ${results.filter(r => r.action === "rename").length} 个已重命名`);
}

// ===================================================================
// Usage
// ===================================================================

function printUsage(): void {
  console.log(`
session-tool — 会话索引重建工具（ACC session 补充）

用法:
  npx tsx session-tool.ts reindex [--dry-run]

reindex 参数:
  --dry-run             预览
`);
}

// ===================================================================
// Main router
// ===================================================================

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  rejectProtocolFlags(args);

  const subcommand = args[0];
  const subArgs = args.slice(1);

  const cccRoot = findCccRoot();

  switch (subcommand) {
    case "reindex":
      cmdReindex(cccRoot, subArgs);
      return;

    default:
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `未知子命令: "${subcommand}"`,
        {
          subcommand,
          validSubcommands: ["reindex"],
        },
        "用法: session-tool reindex [--dry-run]",
      );
  }
}

try {
  main();
} catch (err) {
  if (err instanceof MsmError) {
    emitError(err);
    process.exit(err.exitCode());
  }
  const e = err instanceof Error ? err : new Error(String(err));
  const fallback = new MsmError(
    "INTERNAL_UNHANDLED_STATE",
    "internal",
    `未预期的异常: ${e.message}`,
    { stack: e.stack },
    "请向 Agent 报告此 bug",
    e,
  );
  emitError(fallback);
  process.exit(fallback.exitCode());
}
