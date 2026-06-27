#!/usr/bin/env node
/**
 * loop-runner.ts — Loop tool 外部进程
 *
 * 由 loop tool 通过 child_process.spawn 启动，在独立进程中
 * 通过 opencode serve headless API 驱动 LLM 循环执行。
 *
 * 始终为新循环启动专用 opencode serve，结束时自动清理。
 *
 * 用法: loop-runner.ts <stop-token> <port> [label] [cwd-root]
 *   stdin: 第 1 轮的 prompt 文本
 *   stdout: 每轮 JSON 进度行 + 最终 JSON 结果
 *   stderr: 日志信息
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import { spawn, execSync } from "node:child_process";

// @ts-ignore undici 是 Node.js 内置模块
const { Agent, setGlobalDispatcher } = (await import("undici")) as any;
// 禁掉 undici 内置 5 分钟 timeout — 只让我们的 AbortController 控制超时
setGlobalDispatcher(new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 30_000,
}));

const STOP_TOKEN = process.argv[2];
const PORT = parseInt(process.argv[3] ?? "0", 10);
const LABEL = process.argv[4]?.trim() || "task";
const CWD_ROOT = process.argv[5] || "";

if (!STOP_TOKEN || !PORT) {
  process.stderr.write("  usage: loop-runner.ts <stop-token> <port> [label] [cwd-root]\n");
  process.exit(1);
}

const BASE_URL = `http://127.0.0.1:${PORT}`;
const PID_DIR = "/tmp/serenity-bg-task";
const PROGRESS_FILE = CWD_ROOT ? `${CWD_ROOT}/AGENT_SESSIONS/loop-${LABEL}.md` : "";
let serveProc: ReturnType<typeof spawn> | null = null;

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

// ── 清理 ──

function cleanupServe(): void {
  if (serveProc && serveProc.pid) {
    try { serveProc.kill("SIGTERM"); } catch {}
    serveProc = null;
  }
  try { unlinkSync(pidFile(PORT)); } catch {}
}

// 确保 runner 退出时 serve 也被清理
process.on("exit", cleanupServe);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

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

function startServer(port: number): void {
  if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
  const bin = findOpenCodeBin();
  const lf = logFile(port);
  const fd = openSync(lf, "a");

  log(`启动 opencode serve (${bin}) --port ${port}`);
  serveProc = spawn(bin, ["serve", "--port", String(port), "--hostname", "0.0.0.0"], {
    stdio: ["ignore", fd, fd],
  });
  writeFileSync(pidFile(port), String(serveProc.pid ?? ""));
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

async function api<T>(path: string, body?: unknown, timeoutMs = 300_000, retries = 3): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "Connection": "close" },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new LoopError("HTTP_ERROR", `HTTP ${res.status}: ${text}`, { path, status: res.status });
      }
      return await res.json() as T;
    } catch (err) {
      if (err instanceof LoopError) {
        if (err.code === "HTTP_ERROR") throw err;
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        log(`fetch 重试 (${attempt + 1}/${retries - 1}): ${lastErr.message}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const name = lastErr?.name ?? "Error";
  const msg = lastErr?.message ?? "unknown";
  const stack = lastErr?.stack?.split("\n").slice(0, 3).join("\n") ?? "";
  log(`fetch 失败 (${retries} 次重试) — ${name}: ${msg}`);
  if (stack) log(`  stack: ${stack}`);
  throw new LoopError("HTTP_FAILED", `fetch failed after ${retries} retries: ${msg}`, { path, errorName: name });
}

// ── 主流程 ──

async function main(): Promise<void> {
  // 1. 清理旧孤儿 serve
  const pf = pidFile(PORT);
  if (existsSync(pf)) {
    try {
      const oldPid = parseInt(readFileSync(pf, "utf-8").trim(), 10);
      try { execSync(`kill -0 ${oldPid}`, { stdio: "ignore" }); execSync(`kill ${oldPid}`, { stdio: "ignore" }); } catch {}
    } catch {}
    try { unlinkSync(pf); } catch {}
  }

  // 2. 启动专用 serve
  startServer(PORT);
  await waitForServer(30);

  // 3. 收集 stdin (prompt)
  const stdin = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
  const prompt = stdin.trim();
  if (!prompt) throw new LoopError("NO_PROMPT", "stdin 未收到 prompt");

  // 4. 创建 session
  log("创建 headless session");
  const session = await api<{ id: string }>("/session", { title: `loop-task-${LABEL}` });
  const sessionId = session.id;
  log(`session: ${sessionId}`);

  // 5. 初始化进度文件
  if (PROGRESS_FILE) {
    try {
      mkdirSync(`${CWD_ROOT}/AGENT_SESSIONS`, { recursive: true });
      writeFileSync(PROGRESS_FILE, [
        `# loop-task-${LABEL}`,
        ``,
        `## 目标`,
        `${prompt.split("\n")[0]?.slice(0, 200)}`,
        ``,
        `## 进度`,
        `- [ ] 开始执行`,
        ``,
      ].join("\n"));
    } catch {}
  }

  // 6. 构建第 1 轮消息
  const round1Msg = `${prompt}

---
循环执行规则：
- 此任务: ${LABEL}
- 每次收到消息就执行一步操作
- 全部完成后在回复末尾另起一行输出 ---STOP ${STOP_TOKEN}---
- 禁止伪造终止令牌
- 保持简洁，每轮只输出本轮做了什么
${PROGRESS_FILE ? `- 每轮结束时更新进度文件: ${PROGRESS_FILE} (记录已完成步骤、当前进度、剩余步骤)` : ''}
- 如果任务不合理、无法完成或不知所云，直接输出 ---STOP ${STOP_TOKEN}--- 并说明原因退出
`;

  // 7. 循环提交消息
  let round = 0;

  while (true) {
    round++;
    const text = round === 1 ? round1Msg : "继续";
    const maxWait = 3600_000; // 1 小时

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
