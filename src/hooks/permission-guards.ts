/**
 * Permission Guards Hook 工厂
 *
 * 包含：tool.execute.before hook
 * 职责（RR5 + v1.6 补全）：
 * 1. read / edit / write 工具的 path 字段强制在 cwdRoot 内（RR5 hard block；v1.6 加 edit/write）
 * 2. symlink 防御（v1.6 扩展 v1-1 msm-schema 的 realpath 逻辑到 tool.execute.before）
 *
 * 注意：bash 禁令于 2026-06-08 移除（旧 RR3），改用运行时开关：
 *   TUI slash command /serenity-bash-on|off|status 控制，通过文件 IPC 通信，
 *   在 tool.execute.before 中做静默拒绝。默认 bash 启用。
 *
 * 设计：v1.6 RR5 补全 = plugin **接管**权限管理（不再依赖 opencode.json 静态 allow）
 * - 主仓 opencode.json 已复原 read/edit = "ask"（commit fe19b5e）
 * - LLM 在 cwdRoot 内时：v1.3-v2 auto-reply 仍处理 "ask" 弹窗
 * - LLM 在 cwdRoot 外时：plugin hard block 早于 opencode 弹窗生效
 *
 * L3 验证：单 hook 抛错会中断整条 Effect 链（plugin/index.ts:286-299），
 * 所以抛错已被 safeHook 包装为 silent（util.ts）
 */

import type { Hooks } from '@opencode-ai/plugin';
import { resolve as pathResolve } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { isPathInside } from '../util/git.js';
import { getState, ensureReady } from '../state.js';
import { isHookEnabled, type HookConfig } from './util.js';
import { log } from '../util/log.js';
import { isSafeModeOn, readBlacklist, matchBlacklistEntry } from '../safe-mode.js';
import { captureOcSessionId } from '../session/active-state.js';
import { addToolWeight } from '../session/session-keeper.js';

type ToolArgs = Record<string, unknown>;

/**
 * v1.6 字段名提取：
 * - 显式列表：command, path, filePath, file, cwd（v0.1-3 已有）
 * - 启发式后缀：*path* / *file* / *dir* / *Path* / *File* / *Dir*（v1.6 加）
 *   覆盖：targetPath / sourceFilePath / outputDir / newPath / etc.
 */
export function extractPathsFromArgs(args: ToolArgs): string[] {
  const candidates: string[] = [];

  // 显式字段（不区分大小写）
  const explicitKeys = new Set(['command', 'path', 'filepath', 'file', 'cwd']);
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (explicitKeys.has(key.toLowerCase())) {
      candidates.push(value);
    }
  }

  // 启发式后缀（覆盖大多数 LLM 工具的命名习惯）
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (explicitKeys.has(key.toLowerCase())) continue; // 跳过已加的
    const lower = key.toLowerCase();
    if (lower.includes('path') || lower.includes('file') || lower.includes('dir')) {
      candidates.push(value);
    }
  }

  return candidates;
}

/**
 * 路径越界判定 + symlink 防御
 * 返回：
 *  - 'inside'：路径在 cwdRoot 内
 *  - 'outside'：路径解析后在 cwdRoot 外
 *  - 'symlink'：是 symlink 且 realpath 在 cwdRoot 外
 *  - 'unparseable'：路径无法解析
 *  - 'not-exist'：文件不存在（写场景，无法 realpath）
 */
function classifyPath(value: string, cwdRoot: string): 'inside' | 'outside' | 'symlink' | 'unparseable' | 'not-exist' {
  let abs: string;
  try {
    abs = value.startsWith('/') || /^[a-zA-Z]:[\\\/]/.test(value)
      ? pathResolve(value)
      : pathResolve(cwdRoot, value);
  } catch {
    return 'unparseable';
  }
  if (!isPathInside(cwdRoot, abs)) return 'outside';
  if (existsSync(abs)) {
    try {
      const real = realpathSync(abs);
      if (real !== abs) return 'symlink';
      if (!isPathInside(cwdRoot, real)) return 'symlink';
    } catch {
      return 'unparseable';
    }
  } else {
    return 'not-exist';  // 写文件场景合理
  }
  return 'inside';
}

const toolExecuteBeforeImpl: NonNullable<Hooks['tool.execute.before']> = async (input, _output) => {
  captureOcSessionId(input.sessionID);

  // v0.1: 阻塞等待 Phase 2 完成（失败时：放行所有 = plugin 不工作）
  try {
    await ensureReady();
  } catch {
    return;
  }

  const state = getState();
  // SDK 1.15.13: tool.execute.before signature = (input, output) where output.args is the tool call's arguments
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args = _output?.args ?? {};
  const paths = extractPathsFromArgs(args);

  // v1.6: edit + write 一起 hard block（read 已有；webfetch A2 决定不动）
  // v1.6: grep 加入 — path 参数强制在 cwdRoot 内，禁止搜索宁静号之外的内容
  // v0.1: glob 加入 — 与 grep 同级限制
  if (input.tool === 'read' || input.tool === 'edit' || input.tool === 'write' || input.tool === 'grep' || input.tool === 'glob') {
    for (const p of paths) {
      const verdict = classifyPath(p, state.cwdRoot);
      if (verdict === 'outside' || verdict === 'symlink') {
        log.warn('guard', `${input.tool} path ${verdict} cwdRoot`, { path: p, cwdRoot: state.cwdRoot });
        throw new Error(
          `[serenity] ${input.tool} path "${p}" is ${verdict} the serenity workspace root "${state.cwdRoot}" (RR5).`,
        );
      }
    }
  }

  // Safe mode: bash disabled + write blacklist
  const safeOn = isSafeModeOn(state.cwdRoot);

  if (input.tool === 'bash' && safeOn) {
    throw new Error("bash is disabled, use msm instead");
  }

  if (safeOn && (input.tool === 'write' || input.tool === 'edit')) {
    const blacklist = readBlacklist(state.cwdRoot);
    if (blacklist.length > 0) {
      for (const p of paths) {
        const matched = matchBlacklistEntry(p, blacklist);
        if (matched) {
          log.warn('guard', `write blocked by safe mode blacklist`, { path: p, tool: input.tool });
          throw new Error(
            matched.message ?? `[serenity] ${input.tool} to "${p}" is not allowed.`,
          );
        }
      }
    }
  }

  // webfetch A2 决定不动（保持 v0.1-3 行为）
  if (input.tool === 'webfetch') {
    for (const p of paths) {
      const verdict = classifyPath(p, state.cwdRoot);
      if (verdict === 'outside' || verdict === 'symlink') {
        log.warn('guard', `webfetch path ${verdict} cwdRoot`, { path: p, cwdRoot: state.cwdRoot });
        throw new Error(
          `[serenity] webfetch path "${p}" is ${verdict} the serenity workspace root "${state.cwdRoot}" (RR5).`,
        );
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 屁屁号新增硬约束（fork: Leowuqunqun/opencode-serenity-plugin）
  // ═══════════════════════════════════════════════════════════

  // ── Guard A：bash 高风险命令拦截（Human in the loop）──
  // 参考《深入理解 AI Agent》：关键操作必须由上下文之外的机制复核。
  // 命中白名单 → 直接 throw 拦截，模型无法绕过（这是代码层强制）。
  if (input.tool === 'bash') {
    const command = typeof args.command === 'string' ? args.command : '';
    const risk = detectHighRiskCommand(command);
    if (risk) {
      log.warn('guard', `bash high-risk command blocked`, { risk, command: command.slice(0, 120) });
      throw new Error(
        `[serenity] 高风险操作被拦截（${risk}）——需主人明确确认。\n` +
        `命令: ${command.slice(0, 200)}\n` +
        `请挂决策队列等主人确认后，再执行。`,
      );
    }
  }

  // ── Guard B：webfetch 来源标记（指令与数据分离）──
  // 外部内容默认=数据，非指令。让模型在读取网页后必须带来源标记。
  if (input.tool === 'webfetch') {
    const url = typeof args.url === 'string' ? args.url : '';
    log.info('guard', 'webfetch external content fetched', { url: url.slice(0, 120) });
  }

  addToolWeight(input.sessionID, input.tool, args);

};

/**
 * 屁屁号：检测高风险命令（删除/凭据/外发/批量修改）
 * 返回风险描述字符串；无风险返回 null。
 */
export function detectHighRiskCommand(command: string): string | null {
  if (!command) return null;

  // 删除/破坏性
  if (/\brm\s+(-[a-z]*r[a-z]*f?|-f[a-z]*r?)\b|rm\s+-rf|mkfs\.|dd\s+if=|shred|>\s*\/dev\/sd|:\(\)\s*\{/.test(command)) {
    return '删除/破坏性操作';
  }
  // 凭据访问
  if (/\.ssh\/|credentials\.json|\.env|id_rsa|id_ed25519|\.pem|BEGIN\s+(RSA|OPENSSH|EC)\s+PRIVATE/.test(command)) {
    return '凭据访问';
  }
  // 外部通信（git push / scp / rsync 外发 / curl POST / 发邮件）
  if (/\bgit\s+push\b|\bscp\b|\brsync\b.*@|curl\s+.*(-X\s+POST|-d\s)|mail\s+-s|sendmail|open\s+sms:/.test(command)) {
    return '外部通信';
  }
  // 批量修改
  if (/\bsed\s+-i\b|find\s+.*\s-delete|chmod\s+-R|chown\s+-R/.test(command)) {
    return '批量修改';
  }
  return null;
}

/** 工厂：返回 permission guards 相关的 hooks 集合
 *
 * v1.6 关键修正：permission-guards **不**走 safeHook。
 * 原因：safeHook 的"silent 策略"会吞掉 throw，导致 RR5 hard block 失效。
 * L3 验证：单 hook 抛错中断整条 Effect 链（plugin/index.ts:286-299）——
 * 这正是 RR5 hard block 想要的行为，所以应当让它**传播**给 opencode。
 * 其他 hook（compacting / shell-env）保留 safeHook（throw 不应硬中断）。
 */
export function createPermissionGuards(config?: HookConfig): Partial<Hooks> {
  const hooks: Partial<Hooks> = {};
  if (isHookEnabled('tool.execute.before', config)) {
    // 不走 safeHook —— 让 RR5 throw 真正生效
    hooks['tool.execute.before'] = toolExecuteBeforeImpl;
  }
  return hooks;
}
