/**
 * session/lib.ts — 会话管理核心逻辑
 *
 * 供 session-tool.ts 消费，实现会话 CRUD + 健康检查 + 归档。
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { SessionError } from '../errors.js';

// ── 类型 ──

interface SessionEntry {
  /** 目录名（如 2026-06-09--S031--plugin-next-round-requirements） */
  dirName: string;
  /** 完整路径 */
  path: string;
  /** 最后修改时间 */
  mtime: Date;
  /** 低开销状态摘要 */
  status: SessionStatus;
}

interface SessionStatus {
  /** SESSION.md 是否存在 */
  hasSessionMd: boolean;
  /** 文件中是否有 [x] 完成标记 */
  completed: boolean;
  /** 文件中有多少个 [x] */
  completedCount: number;
  /** 文件中有多少个 [ ]（未完成） */
  pendingCount: number;
  /** 未解决问题数量（估算："未解决" 关键词出现次数） */
  unresolvedCount: number;
}

// ── 常量 ──

const SESSION_MD = 'SESSION.md';
const HEALTH_STALE_DAYS = 7;
const HEALTH_STALLED_PCT = 30;
const HEALTH_STALLED_DAYS = 3;
const HEALTH_GHOST_DAYS = 2;

// ── 工具函数 ──

/** 解析 SESSION.md 文件，提取状态元数据 */
function parseSessionMd(filePath: string): SessionStatus {
  try {
    const content = readFileSync(filePath, 'utf8');
    const hasSessionMd = true;
    const completed = /\[\s*x\s*\]/.test(content);
    const completedCount = (content.match(/\[\s*x\s*\]/g) ?? []).length;
    const pendingCount = (content.match(/\[\s*[ \t]\s*\]/g) ?? []).length;
    const unresolvedCount = (content.match(/(未解决|open|question|TODO)/gi) ?? []).length;

    return { hasSessionMd, completed, completedCount, pendingCount, unresolvedCount };
  } catch {
    return { hasSessionMd: false, completed: false, completedCount: 0, pendingCount: 0, unresolvedCount: 0 };
  }
}

/** 读取单个会话条目 */
function readSessionEntry(dirPath: string): SessionEntry | null {
  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) return null;
    const dirName = basename(dirPath);
    const sessionMdPath = join(dirPath, SESSION_MD);
    const status = existsSync(sessionMdPath)
      ? parseSessionMd(sessionMdPath)
      : { hasSessionMd: false, completed: false, completedCount: 0, pendingCount: 0, unresolvedCount: 0 };
    return { dirName, path: dirPath, mtime: stat.mtime, status };
  } catch {
    return null;
  }
}

/** 读取 AGENT_SESSIONS 中所有会话，活跃（未完成）排前 */
function readAllSessions(sessionsDir: string): SessionEntry[] {
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readSessionEntry(join(sessionsDir, e.name)))
      .filter((s): s is SessionEntry => s !== null)
      .sort((a, b) => {
        if (!a.status.completed && b.status.completed) return -1;
        if (a.status.completed && !b.status.completed) return 1;
        return b.mtime.getTime() - a.mtime.getTime();
      });
  } catch {
    return [];
  }
}

/** 根据 ID（S###）或目录名查找会话 */
function findSession(sessionsDir: string, name: string): SessionEntry | null {
  const all = readAllSessions(sessionsDir);

  // 精确匹配目录名
  const byName = all.find((s) => s.dirName === name);
  if (byName) return byName;

  // 按 ID 匹配（S###）— 提取目录名中的 S### 段
  const idPattern = /--S(\d{3,})--/;
  // 去掉输入中的 S 前缀（从 "S031" 提取 "031"，允许 "S31" → "031"）
  const searchId = name.replace(/^S/, '').padStart(3, '0');
  const byId = all.find((s) => {
    const match = s.dirName.match(idPattern);
    return match && match[1] === searchId;
  });
  if (byId) return byId;

  // 模糊匹配：在目录名字段中做子串匹配（case-insensitive）
  const lower = name.toLowerCase();
  const fuzzyMatches = all.filter((s) => s.dirName.toLowerCase().includes(lower));
  if (fuzzyMatches.length === 1) return fuzzyMatches[0] ?? null;
  if (fuzzyMatches.length > 1) {
    throw new SessionError(
      `Found ${fuzzyMatches.length} sessions matching "${name}": ` +
      fuzzyMatches.map((s) => s.dirName).join(', ') +
      '. Use a more specific query.',
    );
  }

  return null;
}

// ── 核心 API ──

/** list 子命令 */
export function listSessions(sessionsDir: string): string {
  const sessions = readAllSessions(sessionsDir);
  if (sessions.length === 0) {
    return '(no sessions in AGENT_SESSIONS/)';
  }

  const lines = sessions.map((s) => {
    const age = Math.floor((Date.now() - s.mtime.getTime()) / 86400000);
    const status = s.status.completed ? '✓' : '○';
    const sessionId = s.dirName;
    return `${status} ${sessionId} (${age}d ago)`;
  });

  return `AGENT_SESSIONS/ (${sessions.length} sessions)\n` + lines.join('\n');
}

/** show 子命令 */
export function showSession(sessionsDir: string, name: string): string {
  const session = findSession(sessionsDir, name);
  if (!session) {
    throw new SessionError(`Session not found: "${name}". Use "list" to see available sessions.`);
  }

  const mdPath = join(session.path, SESSION_MD);
  if (!existsSync(mdPath)) {
    return `Session ${session.dirName} (no SESSION.md — directory exists but is empty)`;
  }

  const content = readFileSync(mdPath, 'utf8');
  return `# ${session.dirName}\n\n${content}`;
}

/** create 子命令 */
export interface CreateSessionOptions {
  sessionsDir: string;
  root: string;
  desc: string;
  type: 'item' | 'project';
  goal?: string;
  dryRun: boolean;
}

export function createSession(opts: CreateSessionOptions): string {
  const { sessionsDir, desc, type, goal, dryRun } = opts;

  // Validate desc — allow any non-empty string (Chinese, spaces, etc.)
  if (!desc || desc.length === 0) {
    throw new SessionError('description cannot be empty');
  }
  if (desc.length > 200) {
    throw new SessionError(`description too long: ${desc.length} chars (max 200)`);
  }

  // 生成日期前缀
  const now = new Date();
  const datePrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD

  if (type === 'project') {
    if (dryRun) {
      return `[dry-run] Would create project session: "${desc}" (no directory, record in _project-links.md)`;
    }
    // project 模式: 不创建目录，在 _project-links.md 追加记录
    const linksPath = join(sessionsDir, '_project-links.md');
    const linkEntry = `- [${datePrefix}] ${desc}${goal ? ` — ${goal}` : ''}`;
    if (existsSync(linksPath)) {
      const existing = readFileSync(linksPath, 'utf8');
      if (existing.includes(linkEntry)) {
        return `Project link already exists: "${desc}"`;
      }
    }
    writeFileSync(linksPath, (existsSync(linksPath) ? readFileSync(linksPath, 'utf8') + '\n' : '') + linkEntry + '\n', 'utf8');
    return `Project session "${desc}" registered in _project-links.md`;
  }

  // item 模式: 创建目录 + SESSION.md
  // 分配 S### ID — 从现有最大值 + 1
  const sessions = readAllSessions(sessionsDir);
  const idPattern = /--S(\d{3,})--/;
  let maxId = 0;
  for (const s of sessions) {
    const match = s.dirName.match(idPattern);
    if (match) {
      const idStr = match[1];
      if (idStr) {
        const num = parseInt(idStr, 10);
        if (num > maxId) maxId = num;
      }
    }
  }
  const nextId = String(maxId + 1).padStart(3, '0');
  const dirName = `${datePrefix}--S${nextId}--${desc}`;
  const sessionPath = join(sessionsDir, dirName);

  if (!dryRun && existsSync(sessionPath)) {
    throw new SessionError(`Session directory already exists: "${dirName}"`);
  }

  if (dryRun) {
    return `[dry-run] Would create: ${dirName}/\n  type=item\n  goal=${goal ?? '(none)'}`;
  }

  // 创建目录
  mkdirSync(sessionPath, { recursive: true });

  // 写 SESSION.md
  const sessionMd = `# SESSION: ${desc}\n- ID: S${nextId}\n\n## 目标\n${goal ?? '（待补充）'}\n\n## 状态\n- [ ] 进行中\n\n## 关键决策\n| # | 决策 | 理由 |\n|---|------|------|\n| 1 | | |\n\n## 进度记录\n- ${now.toISOString().slice(0, 16).replace('T', ' ')} — 创建\n\n## 产出物\n- \n\n## 未解决的问题\n- \n`;

  writeFileSync(join(sessionPath, SESSION_MD), sessionMd, 'utf8');

  return `Created: ${dirName}/ (S${nextId})`;
}

/** health 子命令 */
export function healthCheck(sessionsDir: string): string {
  const sessions = readAllSessions(sessionsDir);
  if (sessions.length === 0) {
    return 'No sessions found — nothing to check.';
  }

  const now = Date.now();
  const DAY_MS = 86400000;

  interface HealthIssue { dirName: string; issue: string; severity: string; }

  const issues: HealthIssue[] = [];

  for (const s of sessions) {
    const ageDays = (now - s.mtime.getTime()) / DAY_MS;
    const st = s.status;

    // STALE: > 7天无活动
    if (ageDays > HEALTH_STALE_DAYS && !st.completed) {
      issues.push({ dirName: s.dirName, issue: `No activity for ${Math.floor(ageDays)}d`, severity: 'stale' });
    }

    // STALLED: 完成度 < 30% 且创建超过 3 天
    const totalTasks = st.completedCount + st.pendingCount;
    if (totalTasks > 0) {
      const pct = Math.round((st.completedCount / totalTasks) * 100);
      if (pct < HEALTH_STALLED_PCT && ageDays > HEALTH_STALLED_DAYS && !st.completed) {
        issues.push({ dirName: s.dirName, issue: `Only ${pct}% done after ${Math.floor(ageDays)}d`, severity: 'stalled' });
      }
    }

    // GHOST: SESSION.md 不存在的空壳目录
    if (!st.hasSessionMd && ageDays > HEALTH_GHOST_DAYS) {
      issues.push({ dirName: s.dirName, issue: 'No SESSION.md (ghost directory)', severity: 'ghost' });
    }

    // DRIFT: 未解决问题过多
    if (st.unresolvedCount > 3 && !st.completed) {
      issues.push({ dirName: s.dirName, issue: `${st.unresolvedCount} unresolved items`, severity: 'drift' });
    }
  }

  if (issues.length === 0) {
    return 'All sessions healthy — no issues found.';
  }

  const lines = issues.map(
    (i) => `[${i.severity.toUpperCase()}] ${i.dirName}: ${i.issue}`,
  );
  return `${issues.length} issue(s) found:\n` + lines.join('\n');
}

/** archive 子命令 */
export interface ArchiveOptions {
  sessionsDir: string;
  name?: string;
  dryRun: boolean;
}

export function archiveSessions(opts: ArchiveOptions): string {
  const { sessionsDir, name, dryRun } = opts;
  const now = Date.now();
  const DAY_MS = 86400000;
  const ARCHIVE_DIR = join(sessionsDir, '_archived');

  if (name) {
    // 归档单个指定会话
    const session = findSession(sessionsDir, name);
    if (!session) {
      throw new SessionError(`Session not found: "${name}"`);
    }

    // 检查是否可归档（完成 + 超过 grace period）
    if (!session.status.completed) {
      return `Session "${session.dirName}" is not completed — skipping.`;
    }
    const ageDays = (now - session.mtime.getTime()) / DAY_MS;
    if (ageDays < 7) {
      return `Session "${session.dirName}" completed ${Math.floor(ageDays)}d ago — needs ${7 - Math.floor(ageDays)} more days before archiving.`;
    }

    if (dryRun) {
      return `[dry-run] Would archive: ${session.dirName} → ${ARCHIVE_DIR}/`;
    }

    if (!existsSync(ARCHIVE_DIR)) {
      mkdirSync(ARCHIVE_DIR, { recursive: true });
    }
    renameSync(session.path, join(ARCHIVE_DIR, session.dirName));
    return `Archived: ${session.dirName} → _archived/`;
  }

  // 批量归档所有符合条件的主控板
  const sessions = readAllSessions(sessionsDir);
  const toArchive = sessions.filter((s) => {
    if (!s.status.completed) return false;
    const ageDays = (now - s.mtime.getTime()) / DAY_MS;
    return ageDays >= 7;
  });

  if (toArchive.length === 0) {
    return 'No sessions eligible for archiving.';
  }

  if (dryRun) {
    return `[dry-run] Would archive ${toArchive.length} session(s):\n` +
      toArchive.map((s) => `  ${s.dirName}`).join('\n');
  }

  if (!existsSync(ARCHIVE_DIR)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  let count = 0;
  for (const s of toArchive) {
    renameSync(s.path, join(ARCHIVE_DIR, s.dirName));
    count++;
  }

  return `Archived ${count} session(s) → _archived/`;
}

/** use 子命令 — 激活会话作为当前工作上下文 */
export function useSession(sessionsDir: string, name: string): string {
  const session = findSession(sessionsDir, name);
  if (!session) {
    throw new SessionError(`Session not found: "${name}". Use "list" to see available sessions.`);
  }

  if (session.status.completed) {
    throw new SessionError(
      `Session "${session.dirName}" is completed and cannot be activated. ` +
      'Only active (in-progress) sessions can be used with "session use".',
    );
  }

  const mdPath = join(session.path, SESSION_MD);
  if (!existsSync(mdPath)) {
    throw new SessionError(`Session "${session.dirName}" has no SESSION.md — nothing to load.`);
  }

  // 提取 S### ID 用于输出提示
  const idMatch = session.dirName.match(/S(\d{3,})/);
  const sessionId = idMatch ? idMatch[0] : basename(session.dirName);
  const dirName = session.dirName;

  return [
    `───────────────────────────────────────────────────────────────`,
    `[SESSION CONTEXT] Activated: ${dirName}`,
    `───────────────────────────────────────────────────────────────`,
    `Use "session show ${sessionId}" to view session details.`,
    `SESSION.md path: ${mdPath}`,
    ``,
    `→ All subsequent work should refer back to this session.`,
    `  Use "session show ${sessionId}" to check current progress.`,
    `  After advancing work, update the "进度记录" (progress) section in SESSION.md.`,
    `───────────────────────────────────────────────────────────────`,
  ].join('\n');
}

/** close 子命令 — 关闭会话，需要 --confirm 确认 */
export function closeSession(sessionsDir: string, name: string, confirm: boolean): string {
  if (!confirm) {
    return (
      `⚠ Close requires explicit confirmation.\n` +
      `  Re-run with --confirm to confirm closing this session.`
    );
  }

  const session = findSession(sessionsDir, name);
  if (!session) {
    throw new SessionError(`Session not found: "${name}". Use "list" to see available sessions.`);
  }

  if (session.status.completed) {
    return `Session "${session.dirName}" is already completed.`;
  }

  const mdPath = join(session.path, SESSION_MD);
  if (!existsSync(mdPath)) {
    throw new SessionError(`Session "${session.dirName}" has no SESSION.md — nothing to close.`);
  }

  let content = readFileSync(mdPath, 'utf8');

  // Mark status as completed
  content = content.replace(
    /## 状态\n\n- \[ \] 进行中/,
    '## 状态\n\n- [x] 已完成\n- [x] 已关闭',
  );

  // Add close date to progress section
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  if (!content.includes('-- 关闭')) {
    content = content.replace(
      /(## 进度记录\n)/,
      `$1- ${now} — 关闭\n`,
    );
  }

  writeFileSync(mdPath, content, 'utf8');

  return `Session "${session.dirName}" closed and marked as completed.`;
}

/** summary 子命令 */
export function sessionSummary(sessionsDir: string): string {
  const sessions = readAllSessions(sessionsDir);
  if (sessions.length === 0) {
    return 'AGENT_SESSIONS/ is empty.';
  }

  const now = Date.now();
  const DAY_MS = 86400000;

  const completed = sessions.filter((s) => s.status.completed).length;
  const active = sessions.filter((s) => !s.status.completed).length;
  const stale = sessions.filter((s) => !s.status.completed && (now - s.mtime.getTime()) / DAY_MS > HEALTH_STALE_DAYS).length;
  const ghost = sessions.filter((s) => !s.status.hasSessionMd).length;

  const recent = sessions.slice(0, 5);

  const lines: string[] = [
    `AGENT_SESSIONS Summary`,
    `────────────────────────`,
    `Total:    ${sessions.length}`,
    `Active:   ${active}`,
    `Completed: ${completed}`,
    `Stale:    ${stale}`,
    `Ghost:    ${ghost}`,
    ``,
    `Recent activity (top 5):`,
    ...recent.map((s) => {
      const age = Math.floor((now - s.mtime.getTime()) / DAY_MS);
      return `  ${s.status.completed ? '✓' : '○'} ${s.dirName} (${age}d ago)`;
    }),
  ];

  if (stale > 0) {
    lines.push('', '⚠ Warning: Stale sessions found — run "session-tool health" for details.');
  }

  return lines.join('\n');
}

// ── QA / 事实核对 ──

interface QaIssue {
  severity: 'info' | 'warning' | 'error';
  category: string;
  message: string;
}

/** 事实核对：检查 SESSION.md 声明与实际情况的一致性 */
export function qaSession(sessionsDir: string, name: string): string {
  const session = findSession(sessionsDir, name);
  if (!session) {
    throw new SessionError(`Session not found: "${name}". Use "list" to see available sessions.`);
  }

  const mdPath = join(session.path, SESSION_MD);
  if (!existsSync(mdPath)) {
    return `[ERROR] Session "${session.dirName}" has no SESSION.md — nothing to verify.`;
  }

  const content = readFileSync(mdPath, 'utf8');
  const issues: QaIssue[] = [];

  // ── 1. 结构性检查：必选章节是否存在 ──
  const requiredSections = [
    { heading: '目标', label: '目标 (goal)' },
    { heading: '状态', label: '状态 (status)' },
    { heading: '关键决策', label: '关键决策 (key decisions)' },
    { heading: '进度记录', label: '进度记录 (progress)' },
    { heading: '产出物', label: '产出物 (outputs)' },
    { heading: '未解决的问题', label: '未解决的问题 (unresolved)' },
  ];

  for (const section of requiredSections) {
    // (?![\s\S]) = JS 惯用 "end of string" 断言（[\s\S] 匹配任意字符含换行）
    const headingRegex = new RegExp(`^##\\s*${section.heading}[\\s\\S]*?(?=^##|(?![\\s\\S]))`, 'm');
    const match = content.match(headingRegex);
    if (!match) {
      issues.push({
        severity: 'warning',
        category: 'structure',
        message: `Missing section: ${section.label}`,
      });
      continue;
    }

    // 检查章节是否只有空占位符（用 new RegExp 支持变量 heading）
    const headingLineRegex = new RegExp(`^##\\s*${section.heading}\\s*$`, 'm');
    const body = match[0].replace(headingLineRegex, '').trim();
    if (!body || /^[-*]\s*$/.test(body)) {
      issues.push({
        severity: 'warning',
        category: 'structure',
        message: `Section "${section.label}" is empty (only placeholder)`,
      });
    }
  }

  // ── 2. 完成度矛盾检查 ──
  const completedTasks = (content.match(/\[\s*x\s*\]/gi) ?? []).length;
  const pendingTasks = (content.match(/\[\s*[ \t]\s*\]/gi) ?? []).length;

  // 从"状态"段提取 completion mark（避免 goal/progress 中的"完成"误触发）
  const statusSection = content.match(/^##\s*状态[\s\S]*?(?=^##|(?![^]))/mi);
  const statusBody = statusSection
    ? statusSection[0].replace(/^##\s*状态.*$/m, '').trim()
    : '';
  const hasCompletionMark = statusBody
    ? /#+\s*(?:完成|done|completed|closed)\b/i.test(statusBody)
      || /(?:全部完成|已全部完成|所有.*任务.*完成|任务.*全部完成|已完成.*所有)/i.test(statusBody)
    : false;

  // 从"未解决的问题"章节正文提取 unresolved 计数，避免 section 标题中的"未解决"误报
  const unresolvedSection = content.match(/^##\s*未解决的问题[\s\S]*?(?=^##|(?![^]))/mi);

  const unresolvedBody = unresolvedSection
    ? unresolvedSection[0].replace(/^##\s*未解决的问题.*$/m, '').trim()
    : '';
  const unresolvedCount = unresolvedBody
    ? (unresolvedBody.match(/(?:未解决|open|question|TODO)/gi) ?? []).length
    : 0;

  if (hasCompletionMark && pendingTasks > 0) {
    issues.push({
      severity: 'error',
      category: 'consistency',
      message: `Session marked as completed but has ${pendingTasks} pending task(s)`,
    });
  }

  if (hasCompletionMark && unresolvedCount > 0) {
    issues.push({
      severity: 'warning',
      category: 'consistency',
      message: `Session marked as completed but has ${unresolvedCount} unresolved item(s)`,
    });
  }

  if (completedTasks > 0 && pendingTasks === 0 && !hasCompletionMark) {
    issues.push({
      severity: 'info',
      category: 'consistency',
      message: `All ${completedTasks} task(s) completed but session not marked complete`,
    });
  }

  // ── 3. 进度新鲜度检查 ──
  const progressSection = content.match(/##\s*进度记录[\s\S]*?(?=^##|\z)/m);
  if (progressSection) {
    const dateMatches = progressSection[0].match(/\b(\d{4}-\d{2}-\d{2})\b/g);
    if (dateMatches && dateMatches.length > 0) {
      const lastDateStr = dateMatches[dateMatches.length - 1];
      if (lastDateStr) {
        const lastDate = new Date(lastDateStr);
        const now = new Date();
        const daysSince = Math.floor((now.getTime() - lastDate.getTime()) / 86400000);
        if (daysSince > HEALTH_STALE_DAYS && pendingTasks > 0) {
          issues.push({
            severity: 'warning',
            category: 'stale',
            message: `No progress entry for ${daysSince} days (last: ${lastDateStr}), session still has ${pendingTasks} pending task(s)`,
          });
        }
      }
    }
  }

  // ── 4. 决策质量检查 ──
  const decisionSection = content.match(/##\s*关键决策[\s\S]*?(?=^##|\z)/m);
  if (decisionSection) {
    const decisionLines = decisionSection[0].split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l));
    if (decisionLines.length > 0) {
      const emptyDecisions = decisionLines.filter((l) => {
        const cells = l.split('|').map((c) => c.trim());
        // | 1 | 决策 | 理由 | — 如果决策或理由列为空
        return cells.length >= 4 && (!cells[2] || !cells[3] || cells[2] === '-' || cells[3] === '-');
      });
      if (emptyDecisions.length > 0) {
        issues.push({
          severity: 'info',
          category: 'quality',
          message: `${emptyDecisions.length} decision(s) have empty reason — consider filling gaps`,
        });
      }
    } else if (!hasCompletionMark) {
      issues.push({
        severity: 'info',
        category: 'quality',
        message: 'No decisions recorded yet — add key decisions as the session progresses',
      });
    }
  }

  // ── 5. 产出物文件存在性检查 ──
  const outputSection = content.match(/##\s*产出物[\s\S]*?(?=^##|\z)/m);
  if (outputSection) {
    const outputLines = outputSection[0].split('\n').filter((l) => /^\s*[-*]\s/.test(l));
    const fileRefs: string[] = [];
    for (const line of outputLines) {
      // 提取看起来像文件路径的引用（含 / 或 . 或 ` 包裹）
      const refs = line.match(/`[^`]+`/g) ?? [];
      fileRefs.push(...refs.map((r) => r.replace(/`/g, '')));
      // 也匹配行内路径模式
      const inlineRefs = line.match(/\b[\w./-]+\.[a-zA-Z]{1,5}\b/g) ?? [];
      fileRefs.push(...inlineRefs.filter((r) => r.includes('/') || r.includes('.')));
    }

    if (fileRefs.length > 0) {
      // 产出物路径相对于项目根（sessionsDir 的父目录），而非会话目录
      const projectRoot = join(sessionsDir, '..');
      const missing = fileRefs.filter((ref) => !existsSync(join(projectRoot, ref)));
      if (missing.length > 0 && completedTasks > 0) {
        issues.push({
          severity: 'warning',
          category: 'outputs',
          message: `${missing.length} referenced file(s) not found: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? `... (+${missing.length - 3} more)` : ''}`,
        });
      }
    }
  }

  // ── 报告生成 ──
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;
  const verified = errorCount === 0 && warningCount === 0;

  const lines: string[] = [
    `QA Report: ${session.dirName}`,
    `────────────────${'─'.repeat(session.dirName.length)}`,
    `Summary: ${issues.length} issue(s) found (${errorCount} error, ${warningCount} warning, ${infoCount} info)`,
    `Status: ${verified ? '✓ Verified' : '⚠ Issues found'}`,
  ];

  if (issues.length > 0) {
    lines.push('');
    for (const issue of issues) {
      const tag = issue.severity === 'error' ? 'ERR' : issue.severity === 'warning' ? 'WRN' : 'INF';
      lines.push(`  [${tag}:${issue.category}] ${issue.message}`);
    }
  }

  lines.push('', 'Recommendations:');
  if (errorCount > 0) {
    lines.push('  • Fix errors before closing the session (status vs content mismatch)');
  }
  if (warningCount > 0) {
    lines.push('  • Review warnings — they may indicate incomplete or outdated information');
  }
  if (verified) {
    lines.push('  • Session looks clean — no issues detected');
  }

  return lines.join('\n');
}
