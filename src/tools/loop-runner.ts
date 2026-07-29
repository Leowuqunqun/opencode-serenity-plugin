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
import { spawn, execSync, execFileSync } from "node:child_process";

const STOP_TOKEN = process.argv[2];
const PORT = parseInt(process.argv[3] ?? "0", 10);
const LABEL = process.argv[4]?.trim() || "task";
const CWD_ROOT = process.argv[5] || "";
const MODEL = (process.argv[6] ?? "").replace(/^''$/g, "").trim();
const SESSION_ID = (process.argv[7] ?? "").replace(/^''$/g, "").trim();
const SESSION_DIR = (process.argv[8] ?? "").replace(/^''$/g, "").trim();

if (!STOP_TOKEN || !PORT) {
  process.stderr.write("  usage: loop-runner.ts <stop-token> <port> [label] [cwd-root] [model] [session-id] [session-dir] [session-title]\n");
  process.exit(1);
}

const BASE_URL = `http://127.0.0.1:${PORT}`;
const PID_DIR = "/tmp/serenity-bg-task";

// 进度文件：如果指定了 SESSION 目录则放入其中，否则放 AGENT_SESSIONS/
const progressDir = SESSION_DIR || (CWD_ROOT ? `${CWD_ROOT}/AGENT_SESSIONS` : "");
const PROGRESS_FILE = progressDir ? `${progressDir}/loop-${LABEL}.md` : "";
const STATUS_FILE = progressDir ? `${progressDir}/loop-${LABEL}.json` : "";
let serveProc: ReturnType<typeof spawn> | null = null;

// ── 状态文件 ──

function writeStatus(round: number, done: boolean, response: string, status?: string): void {
  if (!STATUS_FILE) return;
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({
      label: LABEL,
      round,
      done,
      status: status ?? (done ? "done" : "running"),
      response: response.slice(0, 200),
      updatedAt: Date.now(),
    }));
  } catch {}
}
function writeFailedStatus(code: string, message: string): void {
  if (!STATUS_FILE) return;
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({
      label: LABEL,
      round: 0,
      done: true,
      status: "failed",
      errorCode: code,
      errorMessage: message.slice(0, 200),
      response: "",
      updatedAt: Date.now(),
    }));
  } catch {}
}

// ── 错误类 ──

class LoopError extends Error {
  constructor(public code: string, message: string, public ctx: Record<string, unknown> = {}) {
    super(message);
    this.name = "LoopError";
  }
}

// ── 模型验证 ──

function validateModel(model: string): void {
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(model)) {
    log(`invalid model format: "${model}" (expected provider/model)`);
    process.stderr.write(`[loop] error: invalid model format "${model}". Expected provider/model (e.g. deepseek/deepseek-v4-flash)\n`);
    process.exit(1);
  }

  log(`validating model: ${model}`);
  let modelsOutput: string;
  try {
    modelsOutput = execSync("opencode models", { encoding: "utf-8", timeout: 15000 });
  } catch {
    log("warning: cannot run opencode models to validate");
    return; // fail-open: continue if validation unavailable
  }

  const lines = modelsOutput.split("\n").map(l => l.trim()).filter(Boolean);
  const found = lines.some(l => l === model);
  if (!found) {
    const hint = lines
      .filter(l => l.includes(model.split("/")[1] || ""))
      .slice(0, 5);
    const hintMsg = hint.length
      ? `\n  similar models:\n    ${hint.join("\n    ")}`
      : `\n  total available models: ${lines.length} (run "opencode models" to list all)`;
    process.stderr.write(
      `[loop] error: model "${model}" is not available. ` +
      `Ensure the provider is configured and has a valid API key.${hintMsg}\n`
    );
    process.exit(1);
  }
  log(`model validated: ${model}`);
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
    "/opt/homebrew/bin/opencode",
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

  const args = ["serve", "--port", String(port), "--hostname", "0.0.0.0"];
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // 注入模型覆盖（OPENCODE_CONFIG_CONTENT）
  if (MODEL) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: MODEL });
    log(`使用模型: ${MODEL} (OPENCODE_CONFIG_CONTENT)`);
  }

  log(`starting opencode serve (${bin}) --port ${port}`);
  serveProc = spawn(bin, args, {
    stdio: ["ignore", fd, fd],
    env,
  });
  writeFileSync(pidFile(port), String(serveProc.pid ?? ""));
}

async function waitForServer(timeout = 30): Promise<void> {
  log("waiting for server...");
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(
        `curl -s -f --max-time 3 --connect-timeout 2 "${BASE_URL}/global/health"`,
        { encoding: "utf-8" },
      );
      const body = JSON.parse(out) as Record<string, unknown>;
      if (body.healthy === true) {
        log("server ready");
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new LoopError("SERVER_TIMEOUT", `server not ready within ${timeout}s`);
}

// ── HTTP 工具 ──

function api<T>(path: string, body?: unknown, timeoutMs = 300_000, retries = 3): T {
  const maxTime = Math.ceil(timeoutMs / 1000);
  const url = `${BASE_URL}${path}`;
  const method = body ? "POST" : "GET";
  const args = [
    "-s", "-f",
    "-X", method,
    "--max-time", String(maxTime),
    "--connect-timeout", "30",
    "-H", "Content-Type: application/json",
  ];
  if (body) args.push("-d", JSON.stringify(body));
  args.push(url);

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const stdout = execFileSync("curl", args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      });
      return JSON.parse(stdout) as T;
    } catch (err: any) {
      // curl -f 在 HTTP 4xx/5xx 时退出码 22 → 不重试
      if (err.status === 22) {
        throw new LoopError("HTTP_ERROR", `curl HTTP error: ${err.stderr?.toString()?.slice(0, 200) ?? err.message}`, { path, exitCode: 22 });
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        log(`curl 重试 (${attempt + 1}/${retries - 1}): ${lastErr.message}`);
        execSync("sleep 1", { stdio: "ignore" });
      }
    }
  }
  const code = (lastErr as any)?.status ?? "unknown";
  const msg = lastErr?.message ?? "unknown";
  log(`curl 失败 (${retries} 次重试): exit=${code} ${msg}`);
  throw new LoopError("HTTP_FAILED", `curl failed after ${retries} retries: exit=${code} ${msg}`, { path });
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

  // 2. validate model (fail fast before starting serve)
  if (MODEL) validateModel(MODEL);

  // 2b. SESSION directory existence check
  if (SESSION_ID && SESSION_DIR && !existsSync(SESSION_DIR)) {
    process.stderr.write(`[loop] error: SESSION ${SESSION_ID} directory not found: ${SESSION_DIR}\n`);
    process.exit(1);
  }
  if (SESSION_ID && !SESSION_DIR) {
    process.stderr.write(`[loop] error: SESSION ${SESSION_ID} not found. Create it first with 'session create'\n`);
    process.exit(1);
  }

  // 3. 启动专用 serve
  startServer(PORT);
  await waitForServer(30);

  // 4. 收集 stdin (prompt)
  const stdin = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
  const prompt = stdin.trim();
  if (!prompt) throw new LoopError("NO_PROMPT", "stdin 未收到 prompt");

  // 5. 创建 headless session
  log("创建 headless session");
  const headlessSession = await api<{ id: string }>("/session", { title: `loop-task-${LABEL}` });
  const headlessSessionId = headlessSession.id;
  log(`headless session: ${headlessSessionId}`);

  // 6. 初始化进度文件
  if (PROGRESS_FILE) {
    try {
      mkdirSync(progressDir, { recursive: true });
      writeFileSync(PROGRESS_FILE, [
        `# loop-task-${LABEL}`,
        ``,
        `## Goal`,
        `${prompt.split("\n")[0]?.slice(0, 200)}`,
        ``,
        `## Progress`,
        `- [ ] started`,
        ``,
      ].join("\n"));
    } catch {}
  }

  // 7. Build message template (pseudo-code loop body)
  const progressRule = PROGRESS_FILE ? `Update progress file: ${PROGRESS_FILE}` : '';

  // 7a. Session context (if session specified)
  const sessionRules = SESSION_ID ? [
    ``,
    `  // ═══════════════════════════════════════════`,
    `  // Working Session`,
    `  // ═══════════════════════════════════════════`,
    `  Active session: ${SESSION_ID}`,
    SESSION_DIR ? `  SESSION.md: ${SESSION_DIR}/SESSION.md` : `  (SESSION ${SESSION_ID} directory not found, create it first)`,
    ``,
    `  After each round:`,
    `    1. Read SESSION.md to review progress`,
    `    2. Advance the work`,
    `    3. Update progress in SESSION.md`,
    ``,
  ] : [];

  const rules = [
    ``,
    `You are executing in a loop. Each message you receive is one iteration of the loop.`,
    ``,
    `for (let round = 1; ; round++) {`,
    ``,
    `  // ═══════════════════════════════════════════`,
    `  // Your Task`,
    `  // ═══════════════════════════════════════════`,
    `  ${prompt}`,
    ``,
    `  // ═══════════════════════════════════════════`,
    `  // Rules`,
    `  // ═══════════════════════════════════════════`,
    `  Within this round you are free to work: read files, edit code, run commands,`,
    `  or do anything needed to advance the task. Decide how far to go each round.`,
    ``,
    `  Your output should include:`,
    `    1. What you did this round (concrete)`,
    `    2. Findings or issues discovered`,
    `    3. Remaining work`,
    `    4. Next steps planned`,
    ``,
    `  If the task is fully complete:`,
    `    Append ---STOP ${STOP_TOKEN}--- break; at the end of your response.`,
    ``,
    `  If the task cannot be completed or hit an unrecoverable error:`,
    `    Output ---STOP ${STOP_TOKEN}--- break; and state the reason.`,
    ``,
    `  // ═══════════════════════════════════════════`,
    `  // Interruption Recovery`,
    `  // ═══════════════════════════════════════════`,
    `  Your work may be interrupted at any time: timeout, server crash,`,
    `  network failure... If interrupted, you will be restarted.`,
    ``,
    `  Before starting each round, check what was already completed —`,
    `  always continue from where you left off, never redo work.`,
    ``,
    `  ${progressRule}`,
    ...sessionRules,
    `  // ═══════════════════════════════════════════`,
    `  // Prohibited`,
    `  // ═══════════════════════════════════════════`,
    `  Do NOT fake ---STOP ${STOP_TOKEN}--- break;`,
    `}`,
    ``,
  ].join('\n');

  const round1Msg = rules;

  // 9. 循环提交消息
  let round = 0;

  while (true) {
    round++;
    const text = round1Msg;
    const maxWait = 7200_000; // 2 小时

    log(`round ${round}: submitting message (timeout=${(maxWait / 1000).toFixed(0)}s)`);
    const result = await api<{ info: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }>(
      `/session/${headlessSessionId}/message`,
      { parts: [{ type: "text", text }] },
      maxWait,
    );

    const responseText = (result.parts ?? [])
      .filter(p => p.type === "text")
      .map(p => p.text ?? "")
      .join("\n");

    // check stop token
    const stopIdx = responseText.indexOf(`---STOP ${STOP_TOKEN}---`);
    if (stopIdx !== -1) {
      const finalResponse = responseText.slice(0, stopIdx).trim();
      log(`round ${round}: stop token detected, loop ends`);
      writeStatus(round, true, finalResponse);
      process.stdout.write(JSON.stringify({
        round,
        done: true,
        response: finalResponse,
        finishReason: result.info?.finishReason ?? "stop",
      }) + "\n");
      return;
    }

    log(`round ${round}: done (${responseText.length} chars)`);
    writeStatus(round, false, responseText);
    process.stdout.write(JSON.stringify({
      round,
      done: false,
      response: responseText,
      finishReason: result.info?.finishReason ?? "unknown",
    }) + "\n");

    // safety valve
    if (round >= 100) {
      log("max rounds (100) reached, forcing stop");
      writeStatus(round, true, responseText);
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
  main().then(() => process.exit(0)).catch((err) => {
    const code = err instanceof LoopError ? err.code : "UNKNOWN";
    const msg = err instanceof LoopError ? `${err.code}: ${err.message}` : String(err);
    writeFailedStatus(code, msg);
    log(`错误: ${msg}`);
    process.exit(1);
  });
}
