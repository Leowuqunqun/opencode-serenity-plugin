/**
 * resident-tool.ts — Resident tool（Plugin tool，v0.8 M0）
 *
 * 启动 CCC 顶层常驻 agent（居民）。接口极简：调用即 start，start 后就挂起常驻。
 * 读 .serenity-meta/resident.json 声明，spawn resident-runner.ts 后台常驻。
 *
 * 设计理念：
 *   - CCC 无需理解生命周期细节，只需 "resident start" → 挂起
 *   - 防重入：已运行则返回 already_running，不重复启动
 *   - runner 内部双层循环（外层永存 + 内层生命周期），CCC 无感知
 *
 * 可靠性修正（2 轮静态审查 + S063 反馈）：
 *   - spawn 用 findNodeBin()（opencode 二进制不能跑 JS，S063 根因）
 *   - spawn 挂 error 监听 + stdio 重定向到日志文件
 *   - 端口用 cccName 盐化（防跨 CCC 同名冲突）
 *   - 轮询识别 initializing 状态（启动盲窗）
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, openSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getState, ensureReady } from '../state.js';
import { isResidentRunner } from './resident-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 查找 node 二进制（复制 loop-tool.findNodeBin）：
 *  process.execPath 是 opencode 二进制（Bun 编译），不能直接跑 TS/JS runner */
export function findNodeBin(): string {
  try {
    return execSync('which node', { encoding: 'utf-8' }).trim() || 'node';
  } catch {
    return 'node';
  }
}

const META_DIRNAME = '.serenity-meta';
const STATUS_FILENAME = 'resident.status.json';
const PID_DIR = '/tmp/serenity-bg-task';

/** 固定端口：从 CCC 名 + resident 名稳定派生（防跨 CCC 同名冲突） */
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

/** runner 日志文件 */
function runnerLogFile(port: number): string {
  return `${PID_DIR}/resident-${port}.log`;
}

interface StatusFile {
  name: string;
  pid: number;
  port: number;
  status: 'running' | 'initializing' | 'stopped' | 'stale' | 'error' | 'recovering';
  lastError?: string;
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

/** 判定状态：进程身份 + 存活双重校验（防 PID 复用） */
function effectiveProcessState(st: StatusFile): { alive: boolean; isOurs: boolean } {
  if (!st.pid || st.pid <= 0) return { alive: false, isOurs: false };
  const alive = isPidAlive(st.pid);
  const isOurs = alive ? isResidentRunner(st.pid) : false;
  return { alive, isOurs };
}

export const residentTool: ToolDefinition = tool({
  description:
    'Resident tool — 启动 CCC 顶层常驻 agent（居民）并挂住。' +
    '读 .serenity-meta/resident.json 声明。调用后阻塞（像 loop 一样 hang 住），' +
    '直到 resident 停止才返回——它持续运行、自行维护心智。' +
    '已在运行时返回 already_running（不重复启动）。',
  args: {},
  execute: async (_input, ctx) => {
    await ensureReady();
    const cwdRoot = getState().cwdRoot || ctx.directory;
    const cccName = getState().cccName || '';

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
    const prev = readStatusFile(cwdRoot);
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

    // 3. spawn runner（阻塞挂住，像 loop 一样：await close 直到 resident 退出）
    const port = residentPort(config.name, cccName);
    const runner = runnerPath();
    const logFd = openSync(runnerLogFile(port), 'a');
    const nodeBin = findNodeBin();
    const child = spawn(nodeBin, [runner, cwdRoot, String(port), String(process.pid)], {
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
    // 不 unref()——保持在本进程事件循环中，才能 await close 阻塞
    const spawnError: Error | null = await new Promise<Error | null>((resolve) => {
      child.once('error', (err) => {
        try { writeFileSyncLog(`spawn error: ${err.message}`); } catch {}
        resolve(err);
      });
      child.once('close', () => resolve(null));
    });

    // 用户取消 → 杀 runner 进程组（runner + serve 一锅端）
    const killGroup = () => {
      try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
    };
    if (ctx.abort.aborted) {
      killGroup();
      throw new Error('resident start 已被用户取消');
    }
    const onAbort = () => killGroup();
    ctx.abort.addEventListener('abort', onAbort);

    // 4. 阻塞等待 runner 退出（resident 常驻，只有 stop/死亡/宿主死才退出）
    const exitCode = await new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? -1));
    });
    ctx.abort.removeEventListener('abort', onAbort);

    if (ctx.abort.aborted) {
      throw new Error('resident start 已被用户取消');
    }
    if (spawnError) {
      throw new Error(`resident start 失败: ${spawnError.message} (log: ${runnerLogFile(port)})`);
    }
    if (exitCode !== 0) {
      throw new Error(`resident 进程退出 (exit=${exitCode}); log: ${runnerLogFile(port)}`);
    }

    return JSON.stringify(
      {
        ok: true,
        stopped: true,
        name: config.name,
        port,
        log: runnerLogFile(port),
        note: 'resident stopped; mind was solidified to .serenity-meta/mind.md',
      },
      null,
      2,
    );
  },
});

/** 简易日志写（spawn error 用） */
function writeFileSyncLog(msg: string): void {
  try {
    if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
    writeFileSync(join(PID_DIR, 'resident-spawn.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' });
  } catch {}
}
