/**
 * resident-core.ts — Resident 纯逻辑模块（v0.8 M0）
 *
 * 从 resident-runner 提取的纯函数：原子写 / 模板构建 / 时间界限 / 进程身份校验。
 * 独立模块：可被 vitest 直接 import（runner 顶层 process.exit 不影响）。
 */

import { writeFileSync, readFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { ResidentConfig } from '../config-schema.js';

// ── 原子写 ──

/** tmp + renameSync 原子替换（同目录，POSIX 保证） */
export function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

// ── 原子锁（O_EXCL 独占占位，防并发 start）──

/**
 * 尝试获取独占锁（O_EXCL 原子创建）。
 * 成功返回锁文件描述符（调用方持有至退出），失败返回 null（已有持有者）。
 * 防 H2/F1/F2：并发 start 的双实例心智撕裂。
 */
export function tryAcquireLock(lockPath: string, ownerPid: number): number | null {
  try {
    const fd = openSync(lockPath, 'wx'); // O_CREAT | O_EXCL | O_WRONLY
    writeFileSync(fd, String(ownerPid), 'utf8');
    return fd;
  } catch {
    return null;
  }
}

/** 读取锁文件持有者 pid（不存在 → null） */
export function readLockOwner(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 释放锁（关闭 fd + 删除文件） */
export function releaseLock(lockPath: string, fd: number | null): void {
  try { if (fd !== null) closeSync(fd); } catch {}
  try { unlinkSync(lockPath); } catch {}
}

// ── 进程身份校验 ──

/**
 * 校验 pid 是否确实是 opencode serve 且端口匹配（防 PID 复用误杀 / 孤儿清理）。
 * Linux: 读 /proc/<pid>/cmdline。非 Linux（无 /proc）返回 false（保守）。
 */
export function isOpenCodeServeOnPort(pid: number, port: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return (
      cmdline.includes('opencode') &&
      cmdline.includes('serve') &&
      cmdline.includes(`--port ${port}`)
    );
  } catch {
    return false;
  }
}

/**
 * 校验 pid 是否确实是 resident-runner（防 stop 误杀 PID 复用）。
 * Linux: 读 /proc/<pid>/cmdline 含 resident-runner。
 */
export function isResidentRunner(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return cmdline.includes('resident-runner');
  } catch {
    return false;
  }
}

// ── 心智协议 ──

/** 从响应文本提取最后一个完整 MIND 块（BEGIN+END 成对） */
export function extractMind(responseText: string): string | null {
  let last: string | null = null;
  let idx = 0;
  while (true) {
    const begin = responseText.indexOf('---MIND-BEGIN---', idx);
    if (begin === -1) break;
    const end = responseText.indexOf('---MIND-END---', begin);
    if (end === -1) break; // 截断：无 END，拒绝（保留旧）
    last = responseText.slice(begin + '---MIND-BEGIN---'.length, end).trim();
    idx = end + '---MIND-END---'.length;
  }
  return last;
}

/** STOP 信号检测：精确匹配 token，且必须位于最后一个 MIND 块之后 */
export function hasStopSignal(responseText: string, stopToken: string): boolean {
  const stopIdx = responseText.indexOf(`---STOP ${stopToken}---`);
  if (stopIdx === -1) return false;
  const mindEndIdx = responseText.lastIndexOf('---MIND-END---');
  return mindEndIdx === -1 || stopIdx > mindEndIdx;
}

// ── 时间界限 ──

/** 生命周期剩余时间 */
export function lifecycleRemaining(
  lifetimeStart: number,
  lifetimeMs: number,
  now: number = Date.now(),
): number {
  return lifetimeStart + lifetimeMs - now;
}

/** 每轮 POST 超时 = max(min, min(timeoutMs, 剩余 + graceMs)) */
export function computePostTimeoutMs(
  timeoutMs: number,
  intervalMs: number,
  remainingMs: number,
): number {
  const graceMs = intervalMs > 0 ? intervalMs : 60_000;
  return Math.max(10_000, Math.min(timeoutMs, remainingMs + graceMs));
}

// ── Token ──

/** 128 位随机 token（每生命周期重新生成） */
export function newStopToken(): string {
  return randomBytes(16).toString('hex');
}

// ── 标准模板（runner 内嵌，英文）──

export function buildMessage(
  config: ResidentConfig,
  stopToken: string,
  mindContent: string,
  roundInLifetime: number,
  remainingMs: number,
): string {
  return [
    ``,
    `You are a persistent resident intelligence. You are NOT completing a one-off task —`,
    `you are continuously operating cognition.`,
    ``,
    `// ═══════════════════════════════════════`,
    `// Your Identity`,
    `// ═══════════════════════════════════════`,
    config.description,
    `Model: ${config.model}`,
    `Mind file: ${config.mind.file} (your only memory — fully overwritten back to disk each round)`,
    ``,
    `// ═══════════════════════════════════════`,
    `// Your Mind (from previous round)`,
    `// ═══════════════════════════════════════`,
    mindContent,
    ``,
    `// ═══════════════════════════════════════`,
    `// Lifetime`,
    `// ═══════════════════════════════════════`,
    `Lifetime duration: ${config.cycle.lifetimeMs}ms`,
    `Remaining time: ${remainingMs}ms`,
    `Current round: ${roundInLifetime}`,
    ``,
    `// ═══════════════════════════════════════`,
    `// Per-Round Protocol`,
    `// ═══════════════════════════════════════`,
    `Each round you should:`,
    `1. Read your mind; identify current goals and the task queue`,
    `2. Advance one cycle of work (read files, edit code, run tools — do as much as useful)`,
    `3. Update the mind: merge this round's findings, decisions, and progress into it`,
    `4. Output the complete updated mind (format below)`,
    ``,
    `Your output must include:`,
    `- What you did this round (concrete)`,
    `- New findings / problems encountered`,
    `- Remaining work and next steps`,
    ``,
    `// ═══════════════════════════════════════`,
    `// Mind Output (required every round)`,
    `// ═══════════════════════════════════════`,
    `At the end of every round's response, output the COMPLETE mind snapshot`,
    `(whole replacement, not incremental):`,
    ``,
    `---MIND-BEGIN---`,
    `(complete new mind: identity / current goals / decision tree / attention /`,
    `task queue / last round summary / prohibitions)`,
    `---MIND-END---`,
    ``,
    `The mind is your only persistent memory. You may die or restart at any time;`,
    `the mind on disk is your sole basis for recovery.`,
    `Make it self-contained: an agent that has never met you must be able to`,
    `continue your cognition from it alone.`,
    ``,
    `// ═══════════════════════════════════════`,
    `// Early Termination (end of lifetime)`,
    `// ═══════════════════════════════════════`,
    `Output the STOP signal to end the current lifetime when ANY of:`,
    `- Remaining time is insufficient (remaining_ms too small to complete a full new round)`,
    `- The mind needs a wholesale reset (current direction is wrong; back to square one)`,
    `- Work has converged (nothing left to advance)`,
    ``,
    `STOP signal: on its own line AFTER the MIND block, output:`,
    `---STOP ${stopToken}---`,
    ``,
    `// ═══════════════════════════════════════`,
    `// Prohibited`,
    `// ═══════════════════════════════════════`,
    `- Do NOT fake the STOP signal (only output it when you truly intend to end)`,
    `- Do NOT call loop-control tools other than resident/acc_kit (no self-spawning new runners)`,
    `- Do NOT bind an AGENT_SESSIONS session`,
    `- Do NOT omit or falsify information in the MIND block —`,
    `  an incomplete memory is more dangerous than a wrong one`,
    ``,
  ].join('\n');
}
