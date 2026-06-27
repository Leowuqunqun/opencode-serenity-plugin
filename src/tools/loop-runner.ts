#!/usr/bin/env node
/**
 * loop-runner.ts — Loop tool 外部进程
 *
 * 由 loop tool 通过 child_process.spawn 启动，在独立进程中
 * 通过 opencode serve headless API 驱动 LLM 循环执行。
 *
 * 自动管理 opencode serve 生命周期：未运行时自动启动。
 *
 * 用法: loop-runner.ts <stop-token> <port>
 *   stdin: 第 1 轮的 prompt 文本
 *   stdout: 每轮 JSON 进度行 + 最终 JSON 结果
 *   stderr: 日志信息
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import { spawn, execSync } from "node:child_process";

const STOP_TOKEN = process.argv[2];
const PORT = parseInt(process.argv[3] ?? "4096", 10);

if (!STOP_TOKEN || !PORT) {
  process.stderr.write("usage: loop-runner.ts <stop-token> <port>\n");
  process.exit(1);
}

const BASE_URL = `http://localhost:${PORT}`;
const PID_DIR = "/tmp/serenity-bg-task";

// ── 错误类 ──

class LoopError extends Error {
  constructor(public code: string, message: string, public ctx: Record<string, unknown> = {}) {
    super(message);
    this.name = "LoopError";
  }
}

// ── 日志 ──

function log(msg: string): void {
  process.stderr.write(`[loop] ${msg}\n`);
}

// ── Server 生命周期 ──

function findOpenCodeBin(): string {
  const candidates = [
    "/home/yh/.opencode/bin/opencode",
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const out = execSync("which opencode", { encoding: "utf-8" });
    return out.trim();
  } catch {
    throw new LoopError("SERVER_BIN_NOT_FOUND", "找不到 opencode 二进制，请确认已安装");
  }
}

function pidFile(port: number): string {
  return `${PID_DIR}/server-${port}.pid`;
}

function logFile(port: number): string {
  return `${PID_DIR}/server-${port}.log`;
}

function isServerRunning(port: number): boolean {
  const pf = pidFile(port);
  if (!existsSync(pf)) return false;
  try {
    const pid = parseInt(readFileSync(pf, "utf-8").trim(), 10);
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    return true;
  } catch {
    try { unlinkSync(pf); } catch {}
    return false;
  }
}

function startServer(port: number): void {
  if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
  const bin = findOpenCodeBin();
  const lf = logFile(port);
  const fd = openSync(lf, "a");

  log(`启动 opencode serve (${bin}) --port ${port}`);
  const proc = spawn(bin, ["serve", "--port", String(port), "--hostname", "0.0.0.0"], {
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  proc.unref();
  writeFileSync(pidFile(port), String(proc.pid ?? ""));
}

async function waitForServer(timeout = 30): Promise<void> {
  log("等待 server 就绪...");
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/global/health`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) {
        const body = await res.json() as Record<string, unknown>;
        if (body.healthy === true) {
          log("server 就绪");
          return;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new LoopError("SERVER_TIMEOUT", `server 未在 ${timeout}s 内就绪`);
}

// ── HTTP 工具 ──

async function api<T>(path: string, body?: unknown, timeoutMs = 300_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LoopError("HTTP_ERROR", `HTTP ${res.status}: ${text}`, { path, status: res.status });
    }
    return await res.json() as T;
  } catch (err) {
    if (err instanceof LoopError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new LoopError("HTTP_FAILED", `fetch failed: ${msg}`, { path });
  } finally {
    clearTimeout(timer);
  }
}

// ── 主流程 ──

async function main(): Promise<void> {
  // 1. 确保 server 运行
  if (!isServerRunning(PORT)) {
    log(`port ${PORT} 无运行中的 server`);
    startServer(PORT);
    await waitForServer(30);
  } else {
    log(`复用 port ${PORT} 的 server`);
  }

  // 2. 收集 stdin (prompt)
  const stdin = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
  const prompt = stdin.trim();
  if (!prompt) throw new LoopError("NO_PROMPT", "stdin 未收到 prompt");

  // 3. 创建 session
  log("创建 headless session");
  const session = await api<{ id: string }>("/session", { title: "loop-task" });
  const sessionId = session.id;
  log(`session: ${sessionId}`);

  // 4. 构建第 1 轮消息
  const round1Msg = `${prompt}

---
执行规则：
- 每次收到消息就执行一步操作
- 全部完成后在回复末尾另起一行输出 ---STOP ${STOP_TOKEN}---
- 禁止伪造终止令牌
- 保持简洁，每轮只输出本轮做了什么
`;

  // 5. 循环提交消息
  let round = 0;

  while (true) {
    round++;
    const text = round === 1 ? round1Msg : "继续";
    const maxWait = round === 1 ? 600_000 : 300_000;

    log(`第 ${round} 轮，提交消息 (timeout=${(maxWait / 1000).toFixed(0)}s)`);
    const result = await api<{ info: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }>(
      `/session/${sessionId}/message`,
      { parts: [{ type: "text", text }] },
      maxWait,
    );

    const responseText = (result.parts ?? [])
      .filter(p => p.type === "text")
      .map(p => p.text ?? "")
      .join("\n");

    // 检查 stop token
    const stopIdx = responseText.indexOf(`---STOP ${STOP_TOKEN}---`);
    if (stopIdx !== -1) {
      const finalResponse = responseText.slice(0, stopIdx).trim();
      log(`第 ${round} 轮检测到 stop token，循环结束`);
      process.stdout.write(JSON.stringify({
        round,
        done: true,
        response: finalResponse,
        finishReason: result.info?.finishReason ?? "stop",
      }) + "\n");
      return;
    }

    log(`第 ${round} 轮完成 (${responseText.length} chars)`);
    process.stdout.write(JSON.stringify({
      round,
      done: false,
      response: responseText,
      finishReason: result.info?.finishReason ?? "unknown",
    }) + "\n");

    // 安全阀
    if (round >= 100) {
      log("达到最大轮数 (100)，强制结束");
      process.stdout.write(JSON.stringify({
        round,
        done: true,
        response: responseText,
        finishReason: "max_rounds",
      }) + "\n");
      return;
    }
  }
}

// ── CLI 守卫 ──

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main().catch((err) => {
    const msg = err instanceof LoopError ? `${err.code}: ${err.message}` : String(err);
    log(`错误: ${msg}`);
    process.exit(1);
  });
}
