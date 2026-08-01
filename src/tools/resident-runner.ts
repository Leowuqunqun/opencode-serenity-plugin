#!/usr/bin/env node
/**
 * resident-runner.ts — Resident 外部常驻进程（v0.8 M0）
 *
 * 由 resident-tool 通过 child_process.spawn 启动，detached + 后台运行。
 * 在独立进程中通过 opencode serve headless API 驱动常驻 agent 循环。
 *
 * 双层 while 循环：
 *   外层：永存（进程不退出，除非外部 stop / 宿主死亡 / 信号）
 *   内层：一个生命周期（lifetimeMs），到期自我了结 → 新 session → 新周期
 *
 * 心智协议：
 *   - 每轮消息模板注入 mind.md 全量 + 倒计时
 *   - agent 响应末尾输出 ---MIND-BEGIN/END--- 完整心智快照
 *   - runner 提取最后一个完整块 → 原子写回 mind.md（tmp + rename）
 *
 * 时间界限：
 *   - 每轮 POST 超时 = min(timeoutMs, 生命周期剩余 + graceMs)，保证可强制执行
 *
 * 可靠性（2 轮静态审查修正）：
 *   - 原子锁 O_EXCL 占位（防并发 start 双实例）
 *   - initializing 状态先写（tool 轮询盲窗消除）
 *   - serve 崩溃自愈（exit 监听 + 每轮健康检查 + 重建 serve/session）
 *   - stop 进程身份校验（防 PID 复用误杀）
 *   - 心智写盘无前缀（防逐轮污染）
 *   - 异步 curl + abort（SIGTERM 可中断，stop 不延迟）
 *   - startedAt 每生命周期刷新（remainingMs 正确）
 *
 * 用法: resident-runner.ts <cwdRoot> <port> <hostPid>
 *   配置从 <cwdRoot>/.serenity-meta/resident.json 读取
 *   stdout/stderr: 日志（spawn 方重定向到文件）
 */

import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { spawn, execSync, execFile } from 'node:child_process';
import { join } from 'node:path';
import { parseResidentConfig, type ResidentConfig } from '../config-schema.js';
import {
  atomicWrite,
  tryAcquireLock,
  readLockOwner,
  releaseLock,
  isOpenCodeServeOnPort,
  isResidentRunner,
  extractMind,
  hasStopSignal,
  lifecycleRemaining,
  computePostTimeoutMs,
  newStopToken,
  buildMessage,
} from './resident-core.js';

const CWD_ROOT = process.argv[2] || '';
const PORT = parseInt(process.argv[3] ?? '0', 10);
const HOST_PID = parseInt(process.argv[4] ?? '0', 10);

const META_DIR = join(CWD_ROOT, '.serenity-meta');
const CONFIG_FILE = join(META_DIR, 'resident.json');
const STATUS_FILE = join(META_DIR, 'resident.status.json');
const LOCK_FILE = join(META_DIR, 'resident.lock');
const PID_DIR = '/tmp/serenity-bg-task';

const BASE_URL = `http://127.0.0.1:${PORT}`;

let config: ResidentConfig;
let serveProc: ReturnType<typeof spawn> | null = null;
let lastExtractedMind = ''; // 内存中最后成功提取的心智（SIGTERM 尽力固化用）
let stopToken = ''; // 本生命周期随机 token（每周期重新生成）
let lockFd: number | null = null;
let shuttingDown = false;
let activeCurl: { abort: () => void } | null = null;

// ── 日志 ──

function log(msg: string): void {
  process.stderr.write(`[resident] ${msg}\n`);
}

// ── 错误类 ──

class ResidentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ResidentError';
  }
}

// ── 状态文件 ──

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

function writeStatus(partial: Partial<StatusFile>): void {
  try {
    const prev = readStatus();
    const next: StatusFile = {
      name: config?.name ?? prev.name ?? 'unknown',
      pid: process.pid, // runner 自身 pid（F11：去掉无意义 fallback）
      port: PORT,
      status: 'running',
      lifetimeCount: prev.lifetimeCount ?? 0,
      roundInLifetime: prev.roundInLifetime ?? 0,
      startedAt: prev.startedAt ?? Date.now(),
      lifetimeMs: config?.cycle?.lifetimeMs ?? prev.lifetimeMs ?? 0,
      lastMindWrite: prev.lastMindWrite ?? 0,
      lastHeartbeat: Date.now(),
      hostname: prev.hostname ?? requireHostname(),
      servePid: serveProc?.pid ?? prev.servePid,
      ...partial,
    };
    atomicWrite(STATUS_FILE, JSON.stringify(next, null, 2));
  } catch (err) {
    log(`writeStatus failed: ${err}`);
  }
}

function readStatus(): Partial<StatusFile> {
  try {
    if (!existsSync(STATUS_FILE)) return {};
    return JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as Partial<StatusFile>;
  } catch {
    return {};
  }
}

function requireHostname(): string {
  try {
    return execSync('hostname', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ── 进程存活 ──

/** kill -0 检查 pid 是否存活 */
function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── Server 生命周期 ──

function findOpenCodeBin(): string {
  const candidates = [
    '/home/yh/.opencode/bin/opencode',
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
    '/usr/bin/opencode',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const out = execSync('which opencode', { encoding: 'utf-8' });
    return out.trim();
  } catch {
    throw new ResidentError('SERVER_BIN_NOT_FOUND', '找不到 opencode 二进制');
  }
}

function pidFile(port: number): string {
  return `${PID_DIR}/server-${port}.pid`;
}

function logFile(port: number): string {
  return `${PID_DIR}/server-${port}.log`;
}

function cleanupServe(): void {
  if (serveProc && serveProc.pid) {
    try { serveProc.kill('SIGTERM'); } catch {}
    serveProc = null;
  }
  try { unlinkSync(pidFile(PORT)); } catch {}
}

/** 启动 serve；挂 exit 监听（非主动关闭时置 recovering 标记） */
function startServer(port: number): void {
  if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
  const bin = findOpenCodeBin();
  const lf = logFile(port);
  const fd = openSync(lf, 'a');

  const args = ['serve', '--port', String(port), '--hostname', '0.0.0.0'];
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: config.model });
  log(`starting opencode serve (${bin}) --port ${port} cwd=${CWD_ROOT}`);

  serveProc = spawn(bin, args, {
    cwd: CWD_ROOT,
    stdio: ['ignore', fd, fd],
    env,
  });
  serveProc.on('exit', (code, signal) => {
    // 主动关闭（cleanupServe 已置 null）时不标记；意外崩溃才置位
    if (serveProc !== null && !shuttingDown) {
      log(`serve exited unexpectedly (code=${code}, signal=${signal}), will rebuild`);
    }
    serveProc = null;
  });
  writeFileSync(pidFile(port), String(serveProc.pid ?? ''));
}

async function waitForServer(timeout = 30): Promise<void> {
  log('waiting for server...');
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(
        `curl -s -f --max-time 3 --connect-timeout 2 "${BASE_URL}/global/health"`,
        { encoding: 'utf-8' },
      );
      const body = JSON.parse(out) as Record<string, unknown>;
      // 校验 serve 身份：/proc cmdline 含 opencode serve --port（防对旧孤儿 serve 探测成功）
      const pfPid = readPidFile();
      const isOurs = pfPid !== null && isOpenCodeServeOnPort(pfPid, PORT);
      if (body.healthy === true && isOurs) {
        log('server ready (verified identity)');
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new ResidentError('SERVER_TIMEOUT', `server not ready within ${timeout}s`);
}

function readPidFile(): number | null {
  const pf = pidFile(PORT);
  if (!existsSync(pf)) return null;
  try {
    const pid = parseInt(readFileSync(pf, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 确保 serve 存活：死则重建（serve 崩溃自愈 H1/F3） */
function ensureServeHealthy(): boolean {
  if (serveProc && serveProc.pid && isAlive(serveProc.pid)) return true;
  log('serve down, rebuilding...');
  try { cleanupServe(); } catch {}
  try {
    writeStatus({ status: 'recovering' });
    startServer(PORT);
    waitForServer(30);
    return true;
  } catch (err) {
    log(`serve rebuild failed: ${err}`);
    return false;
  }
}

// ── HTTP 工具（异步 curl + abort，M7 修复：SIGTERM 可中断）──

function api<T>(path: string, body?: unknown, timeoutMs = 300_000, retries = 3): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const maxTime = Math.ceil(timeoutMs / 1000);
    const url = `${BASE_URL}${path}`;
    const method = body ? 'POST' : 'GET';
    const args = [
      '-s', '-f',
      '-X', method,
      '--max-time', String(maxTime),
      '--connect-timeout', '30',
      '-H', 'Content-Type: application/json',
    ];
    if (body) args.push('-d', JSON.stringify(body));
    args.push(url);

    let attempt = 0;
    let lastErr: Error | null = null;

    const runAttempt = (): void => {
      if (attempt >= retries) {
        reject(lastErr ?? new Error('unknown'));
        return;
      }
      attempt++;
      const ac = new AbortController();
      activeCurl = ac;
      execFile('curl', args, { maxBuffer: 10 * 1024 * 1024, signal: ac.signal }, (err, stdout, stderr) => {
        if (activeCurl === ac) activeCurl = null;
        if (err) {
          if ((err as any).name === 'AbortError') {
            reject(new ResidentError('ABORTED', 'curl aborted (shutdown)'));
            return;
          }
          // curl -f 在 HTTP 4xx/5xx 时退出码 22 → 不重试
          if ((err as any).code === 22) {
            reject(new ResidentError('HTTP_ERROR', `curl HTTP error: ${stderr?.slice(0, 200) ?? err.message}`));
            return;
          }
          lastErr = err;
          log(`curl 重试 (${attempt}/${retries}): ${err.message}`);
          setTimeout(runAttempt, 1000);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as T);
        } catch (e) {
          reject(new ResidentError('HTTP_PARSE', `cannot parse response: ${String(e)}`));
        }
      });
    };
    runAttempt();
  });
}

// ── 生命周期 ──

/** 外层循环：永存。每生命周期一个内层循环。 */
async function runForever(): Promise<void> {
  let lifetimeCount = readStatus().lifetimeCount ?? 0;

  while (true) {
    // 宿主死亡 → 自我了结（进程永存语义不适用于宿主已死）
    if (HOST_PID && !isAlive(HOST_PID)) {
      log('host process died, self-terminating');
      writeStatus({ status: 'stopped' });
      cleanupServe();
      return;
    }

    // serve 健康（崩溃自愈）
    if (!ensureServeHealthy()) {
      writeStatus({ status: 'error', lastError: 'serve unrecoverable' });
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }

    lifetimeCount++;
    stopToken = newStopToken();
    const lifetimeStart = Date.now();
    let roundInLifetime = 0;

    log(`lifetime #${lifetimeCount} starting`);
    // F5：每生命周期刷新 startedAt（remainingMs 正确）
    writeStatus({ lifetimeCount, startedAt: lifetimeStart, status: 'running', lastError: undefined });

    // 创建 headless session（上下文归零，从 mind.md 恢复）
    let headlessSessionId: string;
    try {
      const sess = await api<{ id: string }>('/session', { title: `resident-${config.name}-${lifetimeCount}` });
      headlessSessionId = sess.id;
    } catch (err) {
      log(`session create failed: ${err}`);
      writeStatus({ lastError: String(err) });
      await new Promise((r) => setTimeout(r, 60_000)); // 退避，防热循环
      continue;
    }
    log(`headless session: ${headlessSessionId}`);

    // 内层循环：一个生命周期
    while (true) {
      // 宿主死亡 → 自我了结
      if (HOST_PID && !isAlive(HOST_PID)) {
        log('host process died, self-terminating');
        writeStatus({ status: 'stopped' });
        cleanupServe();
        return;
      }

      // serve 健康检查（崩溃自愈）
      if (!ensureServeHealthy()) {
        writeStatus({ lastError: 'serve down, waiting' });
        await new Promise((r) => setTimeout(r, config.cycle.intervalMs));
        continue;
      }

      // 生命周期剩余检查
      const remaining = lifecycleRemaining(lifetimeStart, config.cycle.lifetimeMs);
      if (remaining <= 0) break; // 生命周期到期，结束内层
      roundInLifetime++;

      // 读取当前 mind（每轮从磁盘读，保证最新）
      let mindContent = '';
      try {
        mindContent = readFileSync(join(CWD_ROOT, config.mind.file), 'utf8');
      } catch {
        mindContent = '(mind file unreadable)';
      }

      // 构建消息
      const message = buildMessage(config, stopToken, mindContent, roundInLifetime, remaining);

      // 每轮 POST 超时 = min(timeoutMs, 剩余 + graceMs) — 时间界限可强制执行
      const postTimeoutMs = computePostTimeoutMs(
        config.cycle.timeoutMs,
        config.cycle.intervalMs,
        remaining,
      );

      log(`round ${roundInLifetime}: submitting (timeout=${(postTimeoutMs / 1000).toFixed(0)}s, remaining=${(remaining / 1000).toFixed(0)}s)`);

      let responseText = '';
      try {
        const result = await api<{ info: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }>(
          `/session/${headlessSessionId}/message`,
          { parts: [{ type: 'text', text: message }] },
          postTimeoutMs,
        );
        responseText = (result.parts ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('\n');
      } catch (err) {
        log(`round ${roundInLifetime} failed: ${err}`);
        writeStatus({ lastError: String(err), roundInLifetime });
        // serve 相关错误（HTTP_ERROR 404 = session 失效）→ 下一轮 ensureServeHealthy 重建
        await new Promise((r) => setTimeout(r, config.cycle.intervalMs));
        continue; // agent 不死于单轮失败
      }

      // 提取心智（取最后一个完整块；无有效块则保留旧 mind）
      const extracted = extractMind(responseText);
      if (extracted !== null && extracted.length > 0) {
        lastExtractedMind = extracted;
        try {
          // M3：写盘无前缀（buildMessage 已有段标题，前缀会造成逐轮污染）
          atomicWrite(join(CWD_ROOT, config.mind.file), `${extracted}\n`);
          writeStatus({ lastMindWrite: Date.now(), lastError: undefined });
        } catch (err) {
          log(`mind write failed: ${err}`);
          writeStatus({ lastError: `mind write failed: ${err}` });
        }
      } else {
        log(`round ${roundInLifetime}: no valid MIND block, keeping previous mind`);
        writeStatus({ lastError: 'no valid MIND block this round' });
      }

      // STOP 检测（精确匹配随机 token；必须位于 MIND 块之后）
      if (hasStopSignal(responseText, stopToken)) {
        log(`round ${roundInLifetime}: STOP signal, ending lifetime`);
        break;
      }

      // 更新状态 + 心跳
      writeStatus({ roundInLifetime, lifetimeCount, lastError: undefined });
      log(`round ${roundInLifetime}: done (${responseText.length} chars)`);

      // sleep 到下一轮（定时唤醒）
      await new Promise((r) => setTimeout(r, config.cycle.intervalMs));
    }

    // 生命周期结束：固化最终心智（尽力），进入新周期
    log(`lifetime #${lifetimeCount} ended`);
    writeStatus({ lifetimeCount, status: 'running' });
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

// ── 信号处理 ──

// SIGTERM：尽力固化（大概率非绝对）+ 中断在途 curl（M7 修复）
function handleShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, best-effort solidifying mind`);
  try {
    if (activeCurl) activeCurl.abort(); // 中断阻塞 POST，让 handler 尽快到达固化
  } catch {}
  try {
    if (lastExtractedMind.length > 0 && config) {
      atomicWrite(join(CWD_ROOT, config.mind.file), `${lastExtractedMind}\n`);
    }
  } catch (err) {
    log(`solidify failed: ${err}`);
  }
  try {
    writeStatus({ status: 'stopped' });
  } catch {}
  cleanupServe();
  releaseLock(LOCK_FILE, lockFd);
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// 兜底：exit 时清理 serve + 释放锁（仅同步）
process.on('exit', () => {
  try { cleanupServe(); } catch {}
  try { releaseLock(LOCK_FILE, lockFd); } catch {}
});

// ── 主流程 ──

async function main(): Promise<void> {
  if (!CWD_ROOT || !PORT) {
    process.stderr.write('  usage: resident-runner.ts <cwdRoot> <port> <hostPid>\n');
    process.exit(1);
  }
  if (!existsSync(CONFIG_FILE)) {
    throw new ResidentError('CONFIG_NOT_FOUND', `missing ${CONFIG_FILE}`);
  }

  // 1. 解析配置（zod 校验）
  const raw = readFileSync(CONFIG_FILE, 'utf8');
  const parsed = parseResidentConfig(JSON.parse(raw));
  if (!parsed.success) {
    throw new ResidentError('CONFIG_INVALID', `invalid resident.json: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  config = parsed.data;

  // 2. mind.md 必须存在且可解析
  const mindPath = join(CWD_ROOT, config.mind.file);
  if (!existsSync(mindPath)) {
    throw new ResidentError('MIND_NOT_FOUND', `missing mind file: ${config.mind.file}`);
  }
  const mindContent = readFileSync(mindPath, 'utf8').trim();
  if (!mindContent) {
    throw new ResidentError('MIND_EMPTY', `mind file is empty: ${config.mind.file}`);
  }

  // 2b. 原子锁占位（H2/F1/F2：防并发 start 双实例）
  lockFd = tryAcquireLock(LOCK_FILE, process.pid);
  if (lockFd === null) {
    const owner = readLockOwner(LOCK_FILE);
    if (owner !== null && isResidentRunner(owner) && isAlive(owner)) {
      throw new ResidentError('ALREADY_RUNNING', `resident already running (pid=${owner})`);
    }
    // 持锁者已死（崩溃残留）→ 强制回收重试一次
    try { unlinkSync(LOCK_FILE); } catch {}
    lockFd = tryAcquireLock(LOCK_FILE, process.pid);
    if (lockFd === null) {
      throw new ResidentError('LOCK_BUSY', 'cannot acquire resident lock');
    }
  }

  // 2c. 先写 initializing 状态（tool 轮询盲窗消除 F2）
  writeStatus({ status: 'initializing', startedAt: Date.now(), lastError: undefined });

  // 3. 校验 model（fail fast）
  try {
    const out = execSync('opencode models', { encoding: 'utf-8', timeout: 15000 });
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.some((l) => l === config.model)) {
      throw new ResidentError('MODEL_NOT_FOUND', `model "${config.model}" not available`);
    }
  } catch (err) {
    if (err instanceof ResidentError) throw err;
    log('warning: cannot run opencode models to validate, continuing'); // fail-open
  }

  // 4. 清理该端口孤儿 serve（PID 身份校验，防 PID 复用误杀）
  const pf = pidFile(PORT);
  if (existsSync(pf)) {
    try {
      const oldPid = parseInt(readFileSync(pf, 'utf8').trim(), 10);
      if (isOpenCodeServeOnPort(oldPid, PORT)) {
        try { execSync(`kill ${oldPid}`, { stdio: 'ignore' }); } catch {}
      } else {
        log(`skipping orphan cleanup: pid ${oldPid} is not an opencode serve on port ${PORT}`);
      }
    } catch {}
    try { unlinkSync(pf); } catch {}
  }

  // 5. 启动专用 serve + 确认状态
  startServer(PORT);
  await waitForServer(30);

  writeStatus({
    name: config.name,
    port: PORT,
    status: 'running',
    startedAt: Date.now(),
    lifetimeMs: config.cycle.lifetimeMs,
    lastError: undefined,
  });

  // 6. 双层循环：永存
  await runForever();
}

// ── CLI 守卫 ──

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      const code = err instanceof ResidentError ? err.code : 'UNKNOWN';
      log(`fatal: ${code}: ${err.message}`);
      writeStatus({ status: 'error', lastError: `${code}: ${err.message}` });
      try { cleanupServe(); } catch {}
      try { releaseLock(LOCK_FILE, lockFd); } catch {}
      process.exit(1);
    });
}
