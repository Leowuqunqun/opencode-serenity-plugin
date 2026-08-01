/**
 * resident-tool.ts — Resident tool（Plugin tool，v0.8 M0）
 *
 * 启动/查询/停止 CCC 顶层常驻 agent（居民）。
 * 读 .serenity-meta/resident.json 声明，spawn resident-runner.ts 后台常驻。
 *
 * actions:
 *   start  — 启动顶层 resident（防重入：已运行则拒绝）
 *   status — 查询运行状态（PID 存活校验 → running / stale / stopped）
 *   stop   — 主动停止（SIGTERM → runner 尽力固化心智 → 清理 serve）
 *
 * 可靠性修正（2 轮静态审查）：
 *   - stop 前校验进程身份 isResidentRunner（防 PID 复用误杀 F7）
 *   - spawn 挂 error 监听 + stdio 重定向到日志文件（F6/F10）
 *   - 端口用 cccName 盐化（防跨 CCC 同名冲突 F8）
 *   - 轮询识别 initializing 状态（F2 盲窗）
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, openSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { getState, ensureReady } from '../state.js';
import { isResidentRunner } from './resident-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const META_DIRNAME = '.serenity-meta';
const STATUS_FILENAME = 'resident.status.json';
const PID_DIR = '/tmp/serenity-bg-task';

/** 固定端口：从 CCC 名 + resident 名稳定派生（防跨 CCC 同名冲突 F8） */
export function residentPort(name: string, cccSalt = ''): number {
  const hash = createHash('sha256').update(`resident:${cccSalt}:${name}`).digest();
  return 31000 + (hash.readUInt32BE(0) % 30000); // 31000-61000
}

/** runner 脚本路径（dist 优先，tsx 开发 fallback） */
function runnerPath(): string {
  const dist = resolve(__dirname, 'resident-runner.js');
  if (existsSync(dist)) return dist;
  return resolve(__dirname, 'resident-runner.ts');
}

/** runner 日志文件（F6：stdio 重定向到文件，非 ignore） */
function runnerLogFile(port: number): string {
  return `${PID_DIR}/resident-${port}.log`;
}

interface StatusFile {
  name: string;
  pid: number;
  port: number;
  status: 'running' | 'initializing' | 'stopped' | 'stale' | 'error' | 'recovering';
  lifetimeCount: number;
  roundInLifetime: number;
  startedAt: number;
  lifetimeMs: number;
  lastMindWrite: number;
  lastHeartbeat: number;
  lastError?: string;
  hostname: string;
  servePid?: number;
}

function statusPath(cwdRoot: string): string {
  return join(cwdRoot, META_DIRNAME, STATUS_FILENAME);
}

/** 读取状态文件（解析失败返回 null） */
export function readStatusFile(cwdRoot: string): StatusFile | null {
  const p = statusPath(cwdRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as StatusFile;
  } catch {
    return null;
  }
}

/** 读取状态文件（旧名，内部用） */
function readStatus(cwdRoot: string): StatusFile | null {
  return readStatusFile(cwdRoot);
}

/** kill -0 存活校验 */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** kill -0 存活校验（旧名，内部用） */
function isAlive(pid: number): boolean {
  return isPidAlive(pid);
}

/** 判定状态：进程身份 + 存活双重校验（F7：防 PID 复用误杀） */
function effectiveProcessState(st: StatusFile): { alive: boolean; isOurs: boolean } {
  if (!st.pid || st.pid <= 0) return { alive: false, isOurs: false };
  const alive = isAlive(st.pid);
  // 身份校验：进程活着但 cmdline 不含 resident-runner → 判定非本 resident（PID 复用）
  const isOurs = alive ? isResidentRunner(st.pid) : false;
  return { alive, isOurs };
}

export const residentTool: ToolDefinition = tool({
  description:
    'Resident tool — 启动/查询/停止 CCC 顶层常驻 agent（居民）。' +
    '读 .serenity-meta/resident.json 声明。双层循环：外层永存，内层生命周期（lifetimeMs）到期自我了结。' +
    'start 后台常驻立即返回；status 校验 PID 存活+身份；stop 发 SIGTERM 触发尽力固化。',
  args: {
    action: z
      .enum(['start', 'status', 'stop'])
      .describe('操作：start / status / stop'),
  },
  execute: async (input, ctx) => {
    await ensureReady();
    const cwdRoot = getState().cwdRoot || ctx.directory;
    const cccName = getState().cccName || '';
    const action = input.action;

    if (action === 'start') {
      // 1. 配置存在性
      const configFile = join(cwdRoot, META_DIRNAME, 'resident.json');
      if (!existsSync(configFile)) {
        throw new Error(
          `resident start: missing ${META_DIRNAME}/resident.json. ` +
          'Create it first (name/description/model/mind.file/cycle).',
        );
      }
      let config: { name?: string; model?: string };
      try {
        config = JSON.parse(readFileSync(configFile, 'utf8'));
      } catch {
        throw new Error('resident start: resident.json is not valid JSON');
      }
      if (!config.name || !config.model) {
        throw new Error('resident start: resident.json must contain name and model');
      }

      // 2. 防重入：已运行则拒绝（进程身份 + 存活校验）
      const prev = readStatus(cwdRoot);
      if (prev && prev.status === 'running' && isPidAlive(prev.pid)) {
        const { isOurs } = effectiveProcessState(prev);
        if (isOurs) {
          return JSON.stringify(
            { ok: false, reason: 'already_running', pid: prev.pid, name: prev.name },
            null,
            2,
          );
        }
        // pid 存活但不是 resident-runner（PID 复用）→ 视为 stale，继续启动
      }

      // 3. spawn runner（detached + unref；日志重定向到文件；挂 error 监听）
      const port = residentPort(config.name, cccName);
      const runner = runnerPath();
      const logFd = openSync(runnerLogFile(port), 'a');
      const child = spawn(process.execPath, [runner, cwdRoot, String(port), String(process.pid)], {
        stdio: ['ignore', logFd, logFd],
        detached: true,
      });
      child.unref();
      child.on('error', (err) => {
        try { writeFileSyncLog(`spawn error: ${err.message}`); } catch {}
      });

      // 4. 等 status.json 出现（runner 启动成功标志），最多 20s
      //    runner 先写 initializing（pid 已确定）→ 立即能确认 spawn 成功
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const st = readStatus(cwdRoot);
        if (st && st.pid > 0 && isPidAlive(st.pid)) {
          const { isOurs } = effectiveProcessState(st);
          if (isOurs || st.status === 'initializing') {
            return JSON.stringify(
              {
                ok: true,
                started: true,
                name: st.name,
                pid: st.pid,
                port: st.port,
                status: st.status,
                note: st.status === 'initializing'
                  ? 'resident spawned; initializing (model validation / server boot)'
                  : 'resident started in background (detached)',
              },
              null,
              2,
            );
          }
        }
        if (st && st.status === 'error') {
          return JSON.stringify(
            { ok: false, reason: 'runner_error', error: st.lastError ?? 'unknown' },
            null,
            2,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      return JSON.stringify(
        { ok: false, reason: 'unconfirmed', note: 'runner spawned but no status within 20s; check resident log', pid: child.pid ?? 0 },
        null,
        2,
      );
    }

    if (action === 'status') {
      const st = readStatus(cwdRoot);
      if (!st) {
        return JSON.stringify({ running: false, status: 'unknown' }, null, 2);
      }
      const { alive, isOurs } = effectiveProcessState(st);
      let effectiveStatus: string;
      if (st.status === 'running' || st.status === 'initializing' || st.status === 'recovering') {
        effectiveStatus = alive && isOurs ? st.status : 'stale';
      } else {
        effectiveStatus = st.status;
      }
      const remainingMs = st.startedAt && st.lifetimeMs
        ? Math.max(0, st.startedAt + st.lifetimeMs - Date.now())
        : null;
      return JSON.stringify(
        {
          running: alive && isOurs && (st.status === 'running' || st.status === 'recovering'),
          name: st.name,
          pid: st.pid,
          port: st.port,
          status: effectiveStatus,
          lifetimeCount: st.lifetimeCount ?? 0,
          roundInLifetime: st.roundInLifetime ?? 0,
          startedAt: st.startedAt ?? null,
          lifetimeMs: st.lifetimeMs ?? null,
          remainingMs,
          lastMindWrite: st.lastMindWrite ?? null,
          lastHeartbeat: st.lastHeartbeat ?? null,
          lastError: st.lastError ?? null,
          hostname: st.hostname ?? null,
          servePid: st.servePid ?? null,
        },
        null,
        2,
      );
    }

    // stop
    const st = readStatus(cwdRoot);
    if (!st || !st.pid) {
      return JSON.stringify({ ok: false, reason: 'not_running', note: 'no status file' }, null, 2);
    }
    const { alive, isOurs } = effectiveProcessState(st);
    if (!alive || !isOurs) {
      return JSON.stringify(
        {
          ok: true,
          note: 'process already dead or PID reused; status marked stale',
          reason: 'already_dead',
          stale: true,
        },
        null,
        2,
      );
    }
    try {
      process.kill(st.pid, 'SIGTERM');
    } catch {
      return JSON.stringify({ ok: false, reason: 'kill_failed' }, null, 2);
    }
    return JSON.stringify({ ok: true, note: 'SIGTERM sent; runner will solidify mind and exit' }, null, 2);
  },
});

/** 简易日志写（spawn error 用） */
function writeFileSyncLog(msg: string): void {
  try {
    if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
    writeFileSync(join(PID_DIR, 'resident-spawn.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' });
  } catch {}
}
